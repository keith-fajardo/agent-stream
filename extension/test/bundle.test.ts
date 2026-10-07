import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build, type BuildOptions } from 'esbuild';
import { copyPlaywrightCore, playwrightVendorPlugin } from '../vendorPlaywright.mjs';
import { describe, expect, it } from 'vitest';

const options = JSON.parse(readFileSync(new URL('../bundle.config.json', import.meta.url), 'utf8')) as BuildOptions;

describe('extension bundle', () => {
  it('bundles the engine, the Agent SDK and Nunjucks into one CommonJS file that loads', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cs-bundle-'));
    const outfile = join(dir, 'engine.cjs');
    await build({ ...options, entryPoints: [fileURLToPath(new URL('../../engine/src/index.ts', import.meta.url))], outfile, plugins: [playwrightVendorPlugin] });
    const out = execFileSync(process.execPath, ['-e', `const e = require(${JSON.stringify(outfile)}); console.log(typeof e.createApp, typeof e.findClaude)`], {
      encoding: 'utf8',
    });
    expect(out.trim()).toBe('function function');
  }, 60_000);

  // The bundle loads playwright-core with a native import(): the CommonJS entry (index.js) has no named exports there, so the
  // vendored ES module entry (index.mjs) is what must be resolved and copied.
  it('loads the vendored playwright-core with a native dynamic import, as the bundle does, and finds chromium', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cs-bundle-'));
    const outfile = join(dir, 'engine.cjs');
    await build({ ...options, entryPoints: [fileURLToPath(new URL('../../engine/src/index.ts', import.meta.url))], outfile, plugins: [playwrightVendorPlugin] });
    const specifier = /import\("(\.\/vendor\/playwright-core\/[^"]+)"\)/.exec(readFileSync(outfile, 'utf8'))?.[1];
    expect(specifier).toBe('./vendor/playwright-core/index.mjs');
    const vendor = copyPlaywrightCore(dir);
    // Real Node, outside vitest's module loader: the same native import() the bundle runs.
    const script = `import(${JSON.stringify(pathToFileURL(join(dir, specifier!)).href)}).then((m) => console.log(typeof (m.chromium && m.chromium.launchPersistentContext)))`;
    expect(execFileSync(process.execPath, ['-e', script], { encoding: 'utf8' }).trim()).toBe('function');
    expect(vendor).toBe(join(dir, 'vendor', 'playwright-core'));
  }, 60_000);

  it('keeps playwright-core out of the bundle and ships it next to it, without browsers, its CLI or its trace viewer (ruling R17)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cs-bundle-'));
    const outfile = join(dir, 'engine.cjs');
    await build({ ...options, entryPoints: [fileURLToPath(new URL('../../engine/src/index.ts', import.meta.url))], outfile, plugins: [playwrightVendorPlugin] });
    const vendor = copyPlaywrightCore(dir);
    const code = readFileSync(outfile, 'utf8');
    expect(code).toContain('./vendor/playwright-core/index.mjs');
    expect(code).not.toContain('chromium-bidi');
    const out = execFileSync(process.execPath, ['-e', `const pw = require(${JSON.stringify(join(vendor, 'index.js'))}); console.log(typeof pw.chromium.launchPersistentContext)`], { encoding: 'utf8' });
    expect(out.trim()).toBe('function');
    for (const gone of ['bin', join('lib', 'vite'), join('lib', 'tools')]) expect(existsSync(join(vendor, gone))).toBe(false);
    for (const kept of ['browsers.json', 'LICENSE', 'index.js', 'index.mjs']) expect(existsSync(join(vendor, kept))).toBe(true);
  }, 60_000);

  it('lists Sessions above Graphs, then Approvals', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    expect(pkg.contributes.views.agentStream.map((v: { id: string }) => v.id)).toEqual(['agentStream.sessions', 'agentStream.graphs', 'agentStream.approvals']);
  });
});
