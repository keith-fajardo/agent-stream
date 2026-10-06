import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { estimateTokens, IMAGE_TOKENS } from '../src/agentLoop/compact';
import { attachedPrompt, ATTACHED_IMAGE, CLAUDE_IMAGE_MAX_BASE64, CLAUDE_IMAGE_MAX_BYTES, IMAGE_NOT_SHOWN, IMAGE_TOO_LARGE, IMAGE_OVER_BUDGET, INLINE_MAX_BYTES, INLINE_MAX_IMAGES, inlineBudget, PDF_READ_TOOL, readIfThere, readImages, storeReader, withAttachedFiles, type StepAttachment } from '../src/attachedFiles';
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
    expect(r.text).toContain(`- .agent-stream/attachments/g/big.png (${IMAGE_TOO_LARGE})`);
    expect(r.text).toContain('- .agent-stream/attachments/g/mockup.png (image, attached to this message)');
    expect(IMAGE_TOO_LARGE).toBe('image over 3.75 MB: read it with the Read tool');
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

describe('the inline budget per request (ruling on I-2)', () => {
  const MB = 1024 * 1024;
  const sized = (name: string, size: number) => {
    writeFileSync(join(dir, name), Buffer.alloc(size, 1));
    return file(name, 'image');
  };

  it('is 20 MB of raw bytes and 20 images, and pins the note', () => {
    expect(INLINE_MAX_BYTES).toBe(20 * MB);
    expect(INLINE_MAX_IMAGES).toBe(20);
    expect(IMAGE_OVER_BUDGET).toBe('image not sent inline (too many large images): read it with the Read tool');
  });

  it('counts bytes and images in order; a file that doesn’t fit is refused and not counted', () => {
    const b = inlineBudget({ bytes: 10, images: 2 });
    expect(b.take(4, true)).toBe(true);
    expect(b.take(7, false)).toBe(false);
    expect(b.take(6, false)).toBe(true);
    expect(b.take(0, true)).toBe(true);
    expect(b.take(0, true)).toBe(false);
    const c = inlineBudget({ bytes: 10, images: 1 });
    expect(c.take(1, true)).toBe(true);
    expect(c.take(1, true)).toBe(false);
    expect(c.take(9, false)).toBe(true);
  });

  it('sends images in order until 20 MB is spent; the rest are listed by path with the budget note', () => {
    const list = ['b1', 'b2', 'b3', 'b4', 'b5'].map((n) => sized(`${n}.png`, Math.floor(4.5 * MB)));
    const r = attachedPrompt('Do it.', [...list, sized('tiny.png', 10)], readIfThere, { send: true, maxBytes: 5 * MB });
    expect(r.images.map((i) => i.name)).toEqual(['b1.png', 'b2.png', 'b3.png', 'b4.png', 'tiny.png']);
    expect(r.text).toContain(`- .agent-stream/attachments/g/b4.png (${ATTACHED_IMAGE})`);
    expect(r.text).toContain(`- .agent-stream/attachments/g/b5.png (${IMAGE_OVER_BUDGET})`);
    expect(r.text).toContain(`- .agent-stream/attachments/g/tiny.png (${ATTACHED_IMAGE})`);
  });

  it("Claude's image limit is on the base64 it is sent as: 5 MB of base64, 3.75 MB of image", () => {
    expect(CLAUDE_IMAGE_MAX_BASE64).toBe(5 * 1024 * 1024);
    expect(CLAUDE_IMAGE_MAX_BYTES).toBe(3.75 * 1024 * 1024);
    expect(Buffer.alloc(CLAUDE_IMAGE_MAX_BYTES).toString('base64')).toHaveLength(CLAUDE_IMAGE_MAX_BASE64);
    expect(Buffer.alloc(CLAUDE_IMAGE_MAX_BYTES + 1).toString('base64').length).toBeGreaterThan(CLAUDE_IMAGE_MAX_BASE64);
  });

  it('sends at most 20 images; an image over 5 MB is not sent and counts toward nothing', () => {
    const list = Array.from({ length: 21 }, (_, i) => sized(`i${i}.png`, 10));
    const r = attachedPrompt('Do it.', [sized('huge.png', 5 * MB + 1), ...list], readIfThere, { send: true, maxBytes: 5 * MB });
    expect(r.images).toHaveLength(20);
    expect(r.images.map((i) => i.name)).not.toContain('i20.png');
    expect(r.text).toContain(`huge.png (${IMAGE_TOO_LARGE})`);
    expect(r.text).toContain(`i19.png (${ATTACHED_IMAGE})`);
    expect(r.text).toContain(`i20.png (${IMAGE_OVER_BUDGET})`);
  });

  it('takes the provider’s own wording for an image it didn’t send', () => {
    const r = attachedPrompt('Do it.', [sized('huge.png', 11), sized('one.png', 1), sized('two.png', 1)], readIfThere, {
      send: true,
      maxBytes: 10,
      budget: { bytes: 100, images: 1 },
      notSent: { tooBig: 'too big here', overBudget: 'too many here' },
    });
    expect(r.text).toContain('huge.png (too big here)');
    expect(r.text).toContain(`one.png (${ATTACHED_IMAGE})`);
    expect(r.text).toContain('two.png (too many here)');
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
