import { attachmentFileProblem, MAX_ATTACHMENTS, safeAttachmentName, type AttachmentUpload } from '@agent-stream/shared';

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
export const base64Chars = (bytes: number): number => Math.ceil(bytes / 3) * 4;

/** Why a file couldn't be read (a dropped folder, a file that went away), in words for the user. */
export const unreadable = (files: readonly File[]): string => (files.length === 1 ? `${files[0].name} couldn't be read.` : "Some of those files couldn't be read.");
