/** Attachments: files and photos given to agents as context (step model spec §6b). Pure rules, shared by the engine and the tab. */

export const MAX_ATTACHMENT_NAME_CHARS = 100;
/** At most this many attachments per step, per graph, and per chat message (spec §6b.2). */
export const MAX_ATTACHMENTS = 20;
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_OTHER_BYTES = 5 * 1024 * 1024;
/** All files of one `attach`, or of one chat message, together: 20 files of 5 MB, as base64 characters. The engine refuses more. */
export const MAX_ATTACH_PAYLOAD_CHARS = 140_000_000;
/** A chat message's text file is inlined up to this many characters (spec §6b.5: 100 KB). */
export const MAX_INLINED_TEXT_CHARS = 100 * 1024;

export const ONLY_AGENT_STEPS_ATTACH = 'Only agent steps have attachments.';
/** The one-time notice when a graph's attachments folder gets its first file (spec §6b.2). */
export const ATTACHMENT_NOTICE = "Attachments are saved with the graph (and committed) and sent to your AI provider. Don't attach secrets.";
export const ALLOWED_ATTACHMENTS = 'images (png, jpg, gif, webp), PDFs, and text files (md, txt, csv, tsv, json, yaml, sql, xml, html, log, or source code)';

export type AttachmentKind = 'image' | 'pdf' | 'text';

/** The image types the providers take. */
export type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
const IMAGE_TYPES = new Map<string, ImageMediaType>([['png', 'image/png'], ['jpg', 'image/jpeg'], ['jpeg', 'image/jpeg'], ['gif', 'image/gif'], ['webp', 'image/webp']]);
/** An extension longer than this is dropped when a name is made safe or made unique, so the stem keeps room. */
const MAX_EXTENSION_CHARS = 90;
const TEXT_TYPES = new Set([
  'md', 'txt', 'csv', 'tsv', 'json', 'yaml', 'yml', 'sql', 'xml', 'html', 'htm', 'log',
  // Common source code.
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'kts', 'swift', 'c', 'h', 'cc', 'cpp', 'hpp', 'cs', 'php',
  'sh', 'bash', 'zsh', 'ps1', 'r', 'scala', 'lua', 'pl', 'css', 'scss', 'less', 'vue', 'svelte', 'toml', 'ini', 'cfg', 'conf', 'graphql', 'proto', 'tf', 'dart',
]);
const WINDOWS_DEVICE_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const SAFE_CHAR_RE = /[\p{L}\p{N}._\- ]/u;
const SAFE_NAME_RE = /^[\p{L}\p{N}._\- ]+$/u;

const extensionOf = (name: string): string => {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
};

/** Image, PDF or text file, by the name's extension; undefined for a type attachments don't take. */
export function attachmentKind(name: string): AttachmentKind | undefined {
  const ext = extensionOf(name);
  if (IMAGE_TYPES.has(ext)) return 'image';
  if (ext === 'pdf') return 'pdf';
  if (TEXT_TYPES.has(ext)) return 'text';
  return undefined;
}

/** An image's media type (`image/png`), for providers that take the bytes. */
export const imageMediaType = (name: string): ImageMediaType | undefined => IMAGE_TYPES.get(extensionOf(name));

/**
 * Why `name` can't name an attachment, or null (spec §6b.2): letters, digits, `.`, `-`, `_` and spaces, at most 100
 * characters, not starting with `.` or a space and not ending with either (Windows), and not a Windows device name.
 */
export function attachmentNameProblem(name: string): string | null {
  const rule = `An attachment name uses letters, digits, ".", "-", "_" and spaces (at most ${MAX_ATTACHMENT_NAME_CHARS} characters), and doesn't start or end with "." or a space.`;
  if (!name || [...name].length > MAX_ATTACHMENT_NAME_CHARS || !SAFE_NAME_RE.test(name) || /^[. ]|[. ]$/.test(name)) return `"${name}" isn't a safe attachment name. ${rule}`;
  if (WINDOWS_DEVICE_RE.test(name.split('.')[0].trim())) return `"${name}" can't be used as an attachment name on Windows. Rename the file.`;
  return null;
}

/** How file systems (macOS, Windows) tell names apart: composed form, any letter case. Every "same file" decision uses it. */
export const attachmentKey = (name: string): string => name.normalize('NFC').toLowerCase();
const key = attachmentKey;

/** Why a list of attachment names can't be stored, or null: each name safe, none twice (in any letter case), at most 20. */
export function attachmentListProblem(names: readonly string[]): string | null {
  if (names.length > MAX_ATTACHMENTS) return `at most ${MAX_ATTACHMENTS} attachments; remove ${names.length - MAX_ATTACHMENTS}.`;
  const seen = new Set<string>();
  for (const name of names) {
    if (name !== name.normalize('NFC')) return `"${name}" must be written in its composed form (for example "\u00f6", not "o" and a separate accent), because files are saved under composed names.`;
    const problem = attachmentNameProblem(name);
    if (problem) return problem;
    if (seen.has(key(name))) return `"${name}" is attached twice. Keep one.`;
    seen.add(key(name));
  }
  return null;
}

/** Why a file can't be attached (its type, or its size), or null (spec §6b.2). */
export function attachmentFileProblem(name: string, bytes: number): string | null {
  const kind = attachmentKind(name);
  if (!kind) return `${name} can't be attached. Attach ${ALLOWED_ATTACHMENTS}.`;
  const max = kind === 'image' ? MAX_IMAGE_BYTES : MAX_OTHER_BYTES;
  if (bytes > max) return `${name} is larger than ${max / (1024 * 1024)} MB${kind === 'image' ? ' (the limit for images)' : ''}.`;
  return null;
}

/**
 * A file's own name made safe (spec §6b.2): folders dropped, other characters as `_`, no leading or trailing dot or space,
 * at most 100 characters with the extension kept, and never a Windows device name.
 */
export function safeAttachmentName(original: string): string {
  const base = (original.split(/[\\/]/).pop() ?? '').normalize('NFC');
  let name = [...base].map((c) => (SAFE_CHAR_RE.test(c) ? c : '_')).join('').replace(/^[. ]+|[. ]+$/g, '');
  const ext = extensionOf(name);
  const keepExt = [...ext].length <= MAX_EXTENSION_CHARS;
  const suffix = ext && keepExt ? `.${ext}` : '';
  let stem = (suffix ? name.slice(0, name.length - suffix.length) : name).replace(/[. ]+$/, '');
  if (!stem) stem = 'attachment';
  if (WINDOWS_DEVICE_RE.test(stem.split('.')[0].trim())) stem = `_${stem.trimStart()}`;
  const room = MAX_ATTACHMENT_NAME_CHARS - [...suffix].length;
  stem = [...stem].slice(0, room).join('').replace(/[. ]+$/, '') || 'attachment';
  name = `${stem}${suffix}`;
  return name;
}

/** `name`, or `name-2.png`, `name-3.png`, … when a taken name (in any letter case) has it, kept within 100 characters. */
export function uniqueAttachmentName(name: string, taken: Iterable<string>): string {
  const used = new Set([...taken].map(key));
  if (!used.has(key(name))) return name;
  const ext = extensionOf(name);
  const suffix = ext && [...ext].length <= MAX_EXTENSION_CHARS ? `.${ext}` : '';
  const stem = suffix ? name.slice(0, name.length - suffix.length) : name;
  for (let i = 2; ; i++) {
    const tail = `-${i}${suffix}`;
    const candidate = `${[...stem].slice(0, MAX_ATTACHMENT_NAME_CHARS - tail.length).join('')}${tail}`;
    if (!used.has(key(candidate))) return candidate;
  }
}
