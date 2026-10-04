import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { legacyGraphForMarkdown, parseGraph, type StepRename } from '@agent-stream/shared';
import { writeFileAtomic } from './fsutil';
import type { GraphStore } from './graphStore';
import { isGraphId, type ProjectPaths } from './paths';

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Moves a project's pre-rename `.claude-stream` folder to `.agent-stream` (graphs, chat and op
 * logs, runs and the inner .gitignore come along). Returns startup warnings; never throws.
 */
export function migrateProjectFolder(root: string, rename: typeof renameSync = renameSync): string[] {
  const legacy = join(root, '.claude-stream');
  const current = join(root, '.agent-stream');
  if (!existsSync(legacy)) return [];
  if (existsSync(current)) return [`Found both .agent-stream and an older .claude-stream folder in ${root}; the old one is ignored. Move anything you need, then delete it.`];
  try {
    rename(legacy, current);
    return [];
  } catch (e) {
    return [`Could not move the older .claude-stream folder in ${root} to .agent-stream (${errorText(e)}); starting with a new .agent-stream folder. Move anything you need, then delete the old one.`];
  }
}

/** Moves the pre-rename variable values file to its new path (folder 0700, file 0600). Returns startup warnings; never throws. */
export function migrateValuesFile(file: string, legacyFile: string, rename: typeof renameSync = renameSync): string[] {
  if (existsSync(file) || !existsSync(legacyFile)) return [];
  try {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    try {
      rename(legacyFile, file);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e;
      copyFileSync(legacyFile, file);
      unlinkSync(legacyFile);
    }
    if (process.platform !== 'win32') chmodSync(file, 0o600);
    return [];
  } catch (e) {
    return [`Could not move the variable values file from ${legacyFile} to ${file} (${errorText(e)}); variable values are treated as empty.`];
  }
}

/** ` Renamed step a- to a and step b--c to b-c: …`, or nothing when no step id changed. */
function renamedNote(renamed: StepRename[]): string {
  if (!renamed.length) return '';
  const steps = renamed.map((r) => `step ${r.from} to ${r.to}`);
  const list = steps.length === 1 ? steps[0] : `${steps.slice(0, -1).join(', ')} and ${steps[steps.length - 1]}`;
  return ` Renamed ${list}: step ids can't contain "--" or end in "-".`;
}

/**
 * Converts each graph file from before Markdown, `<id>.json` without a `<id>.md`, to `<id>.md` and `<id>.meta.json`,
 * then renames the JSON to `<id>.json.bak` (Markdown graph files spec §5.2), or `.bak2`, `.bak3`, … when that name is
 * taken, so an older backup is never replaced. Graphs in `skip` are left for the next start. Baselines stay JSON. What the Markdown
 * can't hold is fixed first (`legacyGraphForMarkdown`): a step id with "--" or a trailing "-" is renamed, in the graph,
 * its side file and its baseline (run records keep the old id), and the note says so. Returns one note per converted
 * graph and a warning per file left as it was; never throws, never deletes.
 */
export function migrateGraphsToMarkdown(
  paths: ProjectPaths,
  store: GraphStore,
  rename: typeof renameSync = renameSync,
  skip: ReadonlySet<string> = new Set(),
): { notes: string[]; warnings: string[] } {
  const notes: string[] = [];
  const warnings: string[] = [];
  if (!existsSync(paths.graphsDir)) return { notes, warnings };
  const ids = readdirSync(paths.graphsDir)
    .filter((f) => f.endsWith('.json') && !f.endsWith('.baseline.json') && !f.endsWith('.meta.json'))
    .map((f) => f.slice(0, -'.json'.length))
    .filter((id) => isGraphId(id) && !skip.has(id) && !existsSync(join(paths.graphsDir, `${id}.md`)))
    .sort();
  for (const id of ids) {
    const file = join(paths.graphsDir, `${id}.json`);
    const leftAlone = (why: string) => warnings.push(`Could not convert the graph file ${id}.json to Markdown (${why}); it was left as it is.`);
    let json: unknown;
    try {
      json = JSON.parse(readFileSync(file, 'utf8'));
    } catch (e) {
      leftAlone(`invalid JSON: ${errorText(e)}`);
      continue;
    }
    const r = parseGraph(json);
    if (!r.ok) {
      leftAlone(r.error);
      continue;
    }
    const base = store.baseline(id);
    const baseline = base.ok ? base.graph : undefined;
    // The baseline's ids stay free, so a renamed step can't take the id of one only the baseline has.
    const converted = legacyGraphForMarkdown({ ...r.graph, id }, new Map(), baseline?.nodes.map((n) => n.id));
    const { renamed } = converted;
    const followed = baseline && legacyGraphForMarkdown(baseline, new Map(renamed.map((x) => [x.from, x.to])), converted.graph.nodes.map((n) => n.id)).graph;
    // A number given to a step only the baseline has is never given to a new step.
    const graph = { ...converted.graph, nodeSeq: Math.max(converted.graph.nodeSeq, followed?.nodeSeq ?? 0) };
    try {
      store.writeConverted(graph);
      if (followed && followed !== baseline) writeFileAtomic(join(paths.graphsDir, `${id}.baseline.json`), `${JSON.stringify(followed, null, 2)}\n`);
    } catch (e) {
      leftAlone(errorText(e));
      continue;
    }
    const note = renamedNote(renamed);
    let bak = `${id}.json.bak`;
    for (let i = 2; existsSync(join(paths.graphsDir, bak)); i++) bak = `${id}.json.bak${i}`;
    try {
      rename(file, join(paths.graphsDir, bak));
      notes.push(`Converted the graph "${graph.name}" to ${id}.md; the old file is kept as ${bak}.${note}`);
    } catch (e) {
      warnings.push(`Converted the graph "${graph.name}" to ${id}.md, but could not rename ${id}.json to ${bak} (${errorText(e)}). Delete ${id}.json when you no longer need it.${note}`);
    }
  }
  return { notes, warnings };
}
