import { attachmentFileProblem, MAX_ATTACH_PAYLOAD_CHARS, MAX_ATTACHMENTS, safeAttachmentName, type AttachmentUpload } from '@agent-stream/shared';

/** Bytes as base64, in chunks so a large image doesn't overflow the call stack. */
function base64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/**
 * Files dropped, pasted or picked in the tab, checked before anything is sent (step model spec §6b.4): the type, the size,
 * and how many the list can still take (`room`). Then read as base64 for the engine.
 */
export async function readUploads(files: readonly File[], room: number): Promise<{ ok: true; uploads: AttachmentUpload[] } | { ok: false; error: string }> {
  if (files.length > room) return { ok: false, error: room <= 0 ? `This list already has ${MAX_ATTACHMENTS} attachments, the most it can have.` : `Only ${room} more can be attached here (at most ${MAX_ATTACHMENTS}).` };
  for (const f of files) {
    const problem = attachmentFileProblem(safeAttachmentName(f.name), f.size);
    if (problem) return { ok: false, error: problem };
  }
  const uploads = await Promise.all(files.map(async (f) => ({ name: f.name, data: base64(new Uint8Array(await f.arrayBuffer())) })));
  return { ok: true, uploads };
}

/** The files a drop or a paste carries (a paste of text carries none). */
export const filesOf = (data: DataTransfer | null): File[] => (data ? [...data.files] : []);

/** What base64 makes of `bytes` bytes, in characters (what the engine's payload cap counts). */
const base64Chars = (bytes: number): number => Math.ceil(bytes / 3) * 4;

/**
 * The files, in order, that fit in one message to the engine (its cap on base64 characters, counting `used` already
 * pending), checked from their sizes before anything is read. The first that would go past it is `tooLarge`; it and any
 * after are left out. A file that can't be attached at all is kept, for readUploads to refuse in its own words.
 */
export function withinPayload(files: readonly File[], used = 0): { fits: File[]; tooLarge?: File } {
  let chars = used;
  const fits: File[] = [];
  for (const f of files) {
    if (!attachmentFileProblem(safeAttachmentName(f.name), f.size)) {
      chars += base64Chars(f.size);
      if (chars > MAX_ATTACH_PAYLOAD_CHARS) return { fits, tooLarge: f };
    }
    fits.push(f);
  }
  return { fits };
}

/** The list's refusal of files that together are more than the engine takes in one go. */
export const TOO_LARGE_TO_ATTACH = 'These files are too large to attach in one go. Attach fewer or smaller files at a time.';

/** Why a file couldn't be read (a dropped folder, a file that went away), in words for the user. */
export const unreadable = (files: readonly File[]): string => (files.length === 1 ? `${files[0].name} couldn't be read.` : "Some of those files couldn't be read.");
