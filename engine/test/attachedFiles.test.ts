import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { estimateTokens, IMAGE_TOKENS } from '../src/agentLoop/compact';
import { ATTACHED_IMAGE, IMAGE_NOT_SHOWN, PDF_READ_TOOL, readIfThere, readImages, withAttachedFiles, type StepAttachment } from '../src/attachedFiles';

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
