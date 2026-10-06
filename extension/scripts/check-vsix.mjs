// Fails unless the .vsix is one universal package for every OS and CPU.
import { readFileSync } from 'node:fs';

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const file = process.argv[2] ?? new URL(`../${manifest.name}-${manifest.version}.vsix`, import.meta.url);

/** Names of the files inside a zip (a .vsix is a zip), read from its central directory. */
function zipEntries(buf) {
  let end = buf.length - 22;
  while (end >= 0 && buf.readUInt32LE(end) !== 0x06054b50) end--;
  if (end < 0) throw new Error('not a zip file');
  const count = buf.readUInt16LE(end + 10);
  let p = buf.readUInt32LE(end + 16);
  const names = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('corrupt zip central directory');
    const nameLength = buf.readUInt16LE(p + 28);
    const extraLength = buf.readUInt16LE(p + 30);
    const commentLength = buf.readUInt16LE(p + 32);
    names.push(buf.toString('utf8', p + 46, p + 46 + nameLength));
    p += 46 + nameLength + extraLength + commentLength;
  }
  return names;
}

const problems = [];
for (const key of ['os', 'cpu']) if (manifest[key]) problems.push(`package.json sets "${key}", which limits the platforms`);
const names = zipEntries(readFileSync(file));
for (const name of names) {
  if (/(^|\/)node_modules\//.test(name)) problems.push(`contains node_modules: ${name}`);
  if (/\.(node|exe|dll|dylib|so)$/i.test(name)) problems.push(`contains a native file: ${name}`);
  if (/claude-agent-sdk-(darwin|linux|win32)/.test(name)) problems.push(`contains a per-platform Claude Code binary: ${name}`);
}
const vendor = 'extension/dist/vendor/playwright-core';
for (const required of ['extension/package.json', 'extension/dist/extension.cjs', 'extension/dist/webview/assets/index.js', 'extension/dist/webview/assets/index.css', 'extension/media/icon.svg', 'extension/LICENSE.txt', `${vendor}/index.js`, `${vendor}/index.mjs`, `${vendor}/browsers.json`, `${vendor}/lib/coreBundle.js`, `${vendor}/LICENSE`]) {
  if (!names.includes(required)) problems.push(`missing ${required}`);
}
if (!names.includes('extension.vsixmanifest')) problems.push('missing extension.vsixmanifest');
// playwright-core ships as JavaScript only: never a browser, an install script, or its trace viewer.
for (const name of names) if (name.startsWith(`${vendor}/`) && /\/(bin|lib\/vite|lib\/tools)\//.test(name.slice(vendor.length))) problems.push(`contains a playwright-core file it doesn't need: ${name}`);
if (problems.length) {
  console.error(`The .vsix is not a universal package:\n- ${problems.join('\n- ')}`);
  process.exit(1);
}
console.log(`${names.length} files; universal package (no platform-specific files).`);
