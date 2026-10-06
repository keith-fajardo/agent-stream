// playwright-core reads its own files at run time (browsers.json, package.json, lib/*), so it can't live inside the
// single bundle: esbuild keeps it external and the build copies what it needs next to the bundle (ruling R17).
import { cpSync, existsSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative } from 'node:path';

/** esbuild: `playwright-core` resolves to ./vendor/playwright-core/index.mjs beside the bundle, loaded at run time. The ES module entry, not index.js: the bundle loads it with a native import(), and for the CommonJS entry that has no named exports. */
export const playwrightVendorPlugin = {
  name: 'vendor-playwright-core',
  setup(build) {
    build.onResolve({ filter: /^playwright-core$/ }, () => ({ path: './vendor/playwright-core/index.mjs', external: true }));
  },
};

/** Copies playwright-core into <outDir>/vendor/playwright-core: no browsers, no install scripts (bin/), no trace viewer or CLI. */
export function copyPlaywrightCore(outDir) {
  const require = createRequire(import.meta.url);
  const root = dirname(require.resolve('playwright-core/package.json'));
  const dest = join(outDir, 'vendor', 'playwright-core');
  rmSync(dest, { recursive: true, force: true });
  for (const name of ['package.json', 'browsers.json', 'index.js', 'index.mjs', 'LICENSE', 'NOTICE', 'ThirdPartyNotices.txt']) {
    if (existsSync(join(root, name))) cpSync(join(root, name), join(dest, name));
  }
  const lib = join(root, 'lib');
  cpSync(lib, join(dest, 'lib'), { recursive: true, filter: (src) => !/^(vite|tools)([\\/]|$)/.test(relative(lib, src)) });
  return dest;
}
