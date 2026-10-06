import { readFileSync } from 'node:fs';
import { build } from 'esbuild';
import { copyPlaywrightCore, playwrightVendorPlugin } from './vendorPlaywright.mjs';

const options = JSON.parse(readFileSync(new URL('./bundle.config.json', import.meta.url), 'utf8'));
await build({ ...options, entryPoints: ['src/extension.ts'], outfile: 'dist/extension.cjs', external: ['vscode'], plugins: [playwrightVendorPlugin] });
copyPlaywrightCore('dist');
