import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { estimateTokens, IMAGE_TOKENS } from '../src/agentLoop/compact';
import { attachedPrompt, ATTACHED_IMAGE, IMAGE_NOT_SHOWN, IMAGE_OVER_5_MB, PDF_READ_TOOL, readIfThere, readImages, storeReader, withAttachedFiles, type StepAttachment } from '../src/attachedFiles';
import { AttachmentStore } from '../src/attachmentStore';
import { tmpProject } from './helpers';

const dir = mkdtempSync(join(tmpdir(), 'attached-'));
writeFileSync(join(dir, 'mockup.png'), 'PNGDATA');
const file = (name: string, kind: StepAttachment['kind'], missing = false): StepAttachment => ({ name, kind, missing, path: join(dir, name), shown: `.agent-stream/attachments/g/${name}` });
const files = [file('mockup.png', 'image'), file('spec.pdf', 'pdf'), file('notes.md', 'text'), file('gone.png', 'image', true)];

describe('the Attached files list (step model spec §6b.5)', () => {
  it('lists each file that is there by path, with the provider’s note for its kind', () => {
    expect(withAttachedFiles('Do it.\n', files, { image: ATTACHED_IMAGE, pdf: PDF_READ_TOOL })).toBe(
      [
        'Do it.',
        '',
        'Attached files:',
        '- .agent-stream/attachments/g/mockup.png (image, attached to this message)',
        '- .agent-stream/attachments/g/spec.pdf (PDF: read it with the Read tool)',
        '- .agent-stream/attachments/g/notes.md',
        '',
      ].join('\n'),
    );
    expect(withAttachedFiles('Do it.', [file('mockup.png', 'image')], { image: IMAGE_NOT_SHOWN })).toContain("mockup.png (This image couldn't be shown to the model.)");
    expect(withAttachedFiles('Do it.', [file('gone.png', 'image', true)], {})).toBe('Do it.');
    expect(withAttachedFiles('Do it.', undefined, {})).toBe('Do it.');
  });

  it('reads the images that are there, as base64 with their media type', () => {
    expect(readImages(files, readIfThere)).toEqual([{ name: 'mockup.png', mediaType: 'image/png', data: Buffer.from('PNGDATA').toString('base64') }]);
    expect(readImages([file('vanished.webp', 'image')], readIfThere)).toEqual([]);
  });

  it('an image counts a fixed amount toward a conversation’s size, never its base64 length', () => {
    const big = 'A'.repeat(4_000_000);
    const t = estimateTokens('', [{ role: 'user', content: [{ type: 'text', text: 'hi' }, { type: 'image', mediaType: 'image/png', data: big }] }], []);
    expect(t).toBeLessThan(IMAGE_TOKENS + 100);
    expect(t).toBeGreaterThanOrEqual(IMAGE_TOKENS);
  });
});

describe('what the prompt says about each image is decided from what was read (fix F1, F2)', () => {
  const sized = (name: string, size: number) => {
    writeFileSync(join(dir, name), Buffer.alloc(size, 1));
    return file(name, 'image');
  };

  it('sends a readable image and says it is attached', () => {
    const r = attachedPrompt('Do it.', [file('mockup.png', 'image')], readIfThere, { send: true });
    expect(r.images.map((i) => i.name)).toEqual(['mockup.png']);
    expect(r.text).toBe('Do it.\n\nAttached files:\n- .agent-stream/attachments/g/mockup.png (image, attached to this message)\n');
  });

  it('lists an image over the limit with its path and the Read tool note, and does not send it', () => {
    const r = attachedPrompt('Do it.', [sized('big.png', 11), file('mockup.png', 'image')], readIfThere, { send: true, maxBytes: 10 });
    expect(r.images.map((i) => i.name)).toEqual(['mockup.png']);
    expect(r.text).toContain(`- .agent-stream/attachments/g/big.png (${IMAGE_OVER_5_MB})`);
    expect(r.text).toContain('- .agent-stream/attachments/g/mockup.png (image, attached to this message)');
    expect(IMAGE_OVER_5_MB).toBe('image over 5 MB: read it with the Read tool');
    // Exactly at the limit still goes.
    expect(attachedPrompt('x', [sized('edge.png', 10)], readIfThere, { send: true, maxBytes: 10 }).images).toHaveLength(1);
  });

  it('leaves out an image that was there at the start but can no longer be read, and labels the others by what was read', () => {
    const r = attachedPrompt('Do it.', [file('mockup.png', 'image'), file('vanished.png', 'image'), file('notes.md', 'text')], readIfThere, { send: true });
    expect(r.images.map((i) => i.name)).toEqual(['mockup.png']);
    expect(r.text).toBe('Do it.\n\nAttached files:\n- .agent-stream/attachments/g/mockup.png (image, attached to this message)\n- .agent-stream/attachments/g/notes.md\n');
  });

  it('says every image could not be shown when the provider sends none, without reading them', () => {
    const read = (): undefined => {
      throw new Error('must not read');
    };
    const r = attachedPrompt('Do it.', [file('mockup.png', 'image'), file('vanished.png', 'image')], read, { send: false });
    expect(r.images).toEqual([]);
    expect(r.text).toContain(`mockup.png (${IMAGE_NOT_SHOWN})`);
    expect(r.text).toContain(`vanished.png (${IMAGE_NOT_SHOWN})`);
  });
});

const canLink = (() => {
  const d = mkdtempSync(join(tmpdir(), 'linkprobe-'));
  try {
    symlinkSync(d, join(d, 'l'));
    return true;
  } catch {
    return false;
  }
})();

describe('the store-backed reader (fix F3)', () => {
  const setup = () => {
    const paths = tmpProject();
    const store = new AttachmentStore(paths);
    store.add('g', [{ name: 'a.png', bytes: new TextEncoder().encode('REAL') }]);
    const f: StepAttachment = { name: 'a.png', kind: 'image', missing: false, path: store.path('g', 'a.png'), shown: 'a.png' };
    return { paths, store, f };
  };

  it('reads a file the store has, and nothing else', () => {
    const { store, f } = setup();
    const read = storeReader(store, 'g', [f]);
    expect(read(f.path)?.toString()).toBe('REAL');
    expect(read(join(dir, 'mockup.png'))).toBeUndefined();
    rmSync(f.path);
    expect(read(f.path)).toBeUndefined();
  });

  it.skipIf(!canLink)('does not follow a file replaced by a link, or a folder replaced by a link', () => {
    const { store, f } = setup();
    const secret = join(dir, 'secret.txt');
    writeFileSync(secret, 'SECRET');
    const read = storeReader(store, 'g', [f]);
    rmSync(f.path);
    symlinkSync(secret, f.path);
    expect(read(f.path)).toBeUndefined();
    // The same through a linked graph folder.
    const folder = store.dir('g');
    rmSync(folder, { recursive: true });
    const elsewhere = join(dir, 'elsewhere');
    mkdirSync(elsewhere);
    writeFileSync(join(elsewhere, 'a.png'), 'OTHER');
    symlinkSync(elsewhere, folder);
    expect(read(f.path)).toBeUndefined();
  });
});
