import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, type BuildOptions } from 'esbuild';
import { describe, expect, it } from 'vitest';

const options = JSON.parse(readFileSync(new URL('../bundle.config.json', import.meta.url), 'utf8')) as BuildOptions;

describe('extension bundle', () => {
  it('bundles the engine, the Agent SDK and Nunjucks into one CommonJS file that loads', async () => {
    const outfile = join(mkdtempSync(join(tmpdir(), 'cs-bundle-')), 'engine.cjs');
    await build({ ...options, entryPoints: [fileURLToPath(new URL('../../engine/src/index.ts', import.meta.url))], outfile });
    const out = execFileSync(process.execPath, ['-e', `const e = require(${JSON.stringify(outfile)}); console.log(typeof e.createApp, typeof e.findClaude)`], {
      encoding: 'utf8',
    });
    expect(out.trim()).toBe('function function');
  }, 60_000);
});
