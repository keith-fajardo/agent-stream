import { describe, expect, it } from 'vitest';
import {
  attachmentFileProblem,
  attachmentKind,
  attachmentListProblem,
  attachmentNameProblem,
  imageMediaType,
  MAX_ATTACHMENTS,
  safeAttachmentName,
  uniqueAttachmentName,
} from '../src/attachments';

describe('attachment types and sizes (spec §6b.2)', () => {
  it('takes images, PDFs and text-like files by extension, in any letter case', () => {
    expect(['a.png', 'b.JPG', 'c.jpeg', 'd.gif', 'e.webp'].map(attachmentKind)).toEqual(['image', 'image', 'image', 'image', 'image']);
    expect(attachmentKind('spec.PDF')).toBe('pdf');
    expect(['notes.md', 'a.txt', 'b.csv', 'c.tsv', 'd.json', 'e.yaml', 'f.yml', 'g.sql', 'h.xml', 'i.html', 'j.log', 'k.ts', 'l.py'].every((n) => attachmentKind(n) === 'text')).toBe(true);
    expect(attachmentKind('tool.exe')).toBeUndefined();
    expect(attachmentKind('Makefile')).toBeUndefined();
    expect(imageMediaType('a.JPG')).toBe('image/jpeg');
    expect(imageMediaType('a.pdf')).toBeUndefined();
  });

  it('refuses other types, naming the allowed ones, and files over the limit', () => {
    expect(attachmentFileProblem('tool.exe', 10)).toBe("tool.exe can't be attached. Attach images (png, jpg, gif, webp), PDFs, and text files (md, txt, csv, tsv, json, yaml, sql, xml, html, log, or source code).");
    expect(attachmentFileProblem('big.png', 10 * 1024 * 1024)).toBeNull();
    expect(attachmentFileProblem('big.png', 10 * 1024 * 1024 + 1)).toBe('big.png is larger than 10 MB (the limit for images).');
    expect(attachmentFileProblem('big.pdf', 5 * 1024 * 1024 + 1)).toBe('big.pdf is larger than 5 MB.');
  });
});

describe('attachment names (spec §6b.2)', () => {
  it('accepts letters, digits, . - _ and spaces, up to 100 characters', () => {
    for (const name of ['mockup.png', 'Q3 report v2.pdf', 'größe_1.csv', 'a-b.c.md', 'x'.repeat(96) + '.png']) expect(attachmentNameProblem(name), name).toBeNull();
  });

  it('refuses other characters, a leading or trailing dot or space, long names and Windows device names', () => {
    for (const name of ['', '../x.png', 'a/b.png', 'a:b.png', '.env', ' a.png', 'a.png ', 'a.', 'x'.repeat(97) + '.png', 'tab\t.md']) expect(attachmentNameProblem(name), name).toMatch(/isn't a safe attachment name/);
    expect(attachmentNameProblem('CON.png')).toBe(`"CON.png" can't be used as an attachment name on Windows. Rename the file.`);
  });

  it('makes a file’s own name safe, keeping its extension', () => {
    expect(safeAttachmentName('/Users/me/Desktop/My Mockup (final).png')).toBe('My Mockup _final_.png');
    expect(safeAttachmentName('C:\\work\\notes:v2.md')).toBe('notes_v2.md');
    expect(safeAttachmentName('.hidden.txt')).toBe('hidden.txt');
    expect(safeAttachmentName('...png')).toBe('png');
    expect(safeAttachmentName('nul.txt')).toBe('_nul.txt');
    expect(safeAttachmentName('???.pdf')).toBe('___.pdf');
    const long = safeAttachmentName(`${'a'.repeat(150)}.webp`);
    expect(long).toBe(`${'a'.repeat(95)}.webp`);
    for (const n of ['a/b/c.png', 'weird*name?.json', `${'ü'.repeat(120)}.md`]) expect(attachmentNameProblem(safeAttachmentName(n)), n).toBeNull();
  });

  it('gives a clash -2, -3, … before the extension, in any letter case', () => {
    expect(uniqueAttachmentName('mockup.png', [])).toBe('mockup.png');
    expect(uniqueAttachmentName('mockup.png', ['Mockup.PNG'])).toBe('mockup-2.png');
    expect(uniqueAttachmentName('mockup.png', ['mockup.png', 'mockup-2.png'])).toBe('mockup-3.png');
    expect(uniqueAttachmentName('README', ['readme'])).toBe('README-2');
    expect(uniqueAttachmentName(`${'a'.repeat(96)}.png`, [`${'a'.repeat(96)}.png`])).toBe(`${'a'.repeat(94)}-2.png`);
  });

  it('a list holds safe names, each once, at most 20', () => {
    expect(attachmentListProblem(['a.png', 'b.md'])).toBeNull();
    expect(attachmentListProblem(['a.png', 'A.png'])).toBe('"A.png" is attached twice. Keep one.');
    expect(attachmentListProblem(['../a.png'])).toMatch(/isn't a safe attachment name/);
    expect(attachmentListProblem(Array.from({ length: MAX_ATTACHMENTS + 1 }, (_, i) => `f${i}.md`))).toBe('at most 20 attachments; remove 1.');
  });
});

describe('attachment rules, review fixes', () => {
  it('knows only its own extensions, never prototype keys', () => {
    for (const name of ['x.constructor', 'x.__proto__', 'x.toString', 'x.hasOwnProperty']) {
      expect(attachmentKind(name), name).toBeUndefined();
      expect(imageMediaType(name), name).toBeUndefined();
      expect(attachmentFileProblem(name, 5), name).toMatch(/can't be attached/);
    }
  });

  it('never makes a name over 100 characters, even with a very long extension', () => {
    for (const n of [`a.${'b'.repeat(150)}`, `${'a'.repeat(50)}.${'b'.repeat(95)}`, `x.${'é'.repeat(100)}`]) {
      const safe = safeAttachmentName(n);
      expect([...safe].length, n).toBeLessThanOrEqual(100);
      expect(attachmentNameProblem(safe), n).toBeNull();
    }
    const long = `a.${'b'.repeat(95)}`;
    for (const taken of [[long], [long, `a-2.${'b'.repeat(95)}`]]) {
      const unique = uniqueAttachmentName(long, taken);
      expect([...unique].length).toBeLessThanOrEqual(100);
      expect(attachmentNameProblem(unique)).toBeNull();
      expect(taken.map((t) => t.toLowerCase())).not.toContain(unique.toLowerCase());
    }
  });

  it('treats a decomposed and a composed letter as the same name', () => {
    const decomposed = 'gro\u0308\u00dfe.csv';
    expect(safeAttachmentName(decomposed)).toBe('größe.csv');
    expect(attachmentListProblem(['gr\u00f6\u00dfe.csv', 'GR\u00d6\u00dfE.csv'])).toBe('"GR\u00d6\u00dfE.csv" is attached twice. Keep one.');
    expect(uniqueAttachmentName('\u00fc.md', ['u\u0308.md'])).toBe('\u00fc-2.md');
  });

  it('refuses a list name that is not in its composed (NFC) form', () => {
    expect(attachmentListProblem(['gro\u0308\u00dfe.csv'])).toBe('"gro\u0308\u00dfe.csv" must be written in its composed form (for example "\u00f6", not "o" and a separate accent), because files are saved under composed names.');
    expect(attachmentListProblem(['gr\u00f6\u00dfe.csv'])).toBeNull();
  });

  it('refuses a Windows device name with spaces before the dot', () => {
    expect(attachmentNameProblem('CON .txt')).toBe(`"CON .txt" can't be used as an attachment name on Windows. Rename the file.`);
    expect(attachmentNameProblem('nul  .md')).toMatch(/Windows/);
    expect(safeAttachmentName('nul  .md')).toBe('_nul.md');
    expect(attachmentNameProblem(safeAttachmentName('CON .txt'))).toBeNull();
  });

  it('refuses dots, NUL, separators and drive letters as names', () => {
    for (const name of ['..', '.', 'a\u0000b.png', 'a/b.png', 'a\\b.png', 'C:x']) expect(attachmentNameProblem(name), name).toMatch(/isn't a safe attachment name/);
  });
});

