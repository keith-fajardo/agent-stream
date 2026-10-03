/**
 * A glob as an anchored regular expression over `/`-separated relative paths (spec §4.2): `**` any number of folders,
 * `*` and `?` within one name, `{a,b}` alternatives, `[abc]` / `[!abc]` classes. A `\` is a Windows separator, not an
 * escape. No `path.matchesGlob`: the engine supports Node 20.11.
 */
export function globToRegExp(pattern: string): RegExp {
  return new RegExp(`^${convert(pattern.replace(/\\/g, '/'))}$`);
}

const SPECIAL = /[.+^$()|[\]{}]/;

function convert(p: string): string {
  let out = '';
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '*') {
      if (p[i + 1] === '*') {
        const atStart = i === 0 || p[i - 1] === '/';
        if (atStart && p[i + 2] === '/') {
          out += '(?:[^/]*/)*'; // `**/`: zero or more whole folders
          i += 2;
        } else if (atStart && i + 2 === p.length) {
          out += '.*'; // a trailing `**`: everything below
          i += 1;
        } else {
          out += '[^/]*'; // `a**b` acts like `*`
          i += 1;
        }
      } else out += '[^/]*';
    } else if (c === '?') out += '[^/]';
    else if (c === '[') {
      const end = p.indexOf(']', i + 1);
      if (end <= i + 1) {
        out += '\\[';
        continue;
      }
      const body = p.slice(i + 1, end);
      out += `[${body.startsWith('!') ? `^${body.slice(1)}` : body}]`;
      i = end;
    } else if (c === '{') {
      const end = closingBrace(p, i);
      if (end === -1) {
        out += '\\{';
        continue;
      }
      out += `(?:${splitTopLevel(p.slice(i + 1, end)).map(convert).join('|')})`;
      i = end;
    } else out += SPECIAL.test(c) ? `\\${c}` : c;
  }
  return out;
}

function closingBrace(p: string, open: number): number {
  let depth = 0;
  for (let i = open; i < p.length; i++) {
    if (p[i] === '{') depth++;
    else if (p[i] === '}' && --depth === 0) return i;
  }
  return -1;
}

/** `a,{b,c},d` → ['a', '{b,c}', 'd']. */
function splitTopLevel(s: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '{') depth++;
    else if (s[i] === '}') depth--;
    else if (s[i] === ',' && depth === 0) {
      parts.push(s.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(s.slice(start));
  return parts;
}
