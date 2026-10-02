import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { renameReferences, renderTemplate, shellQuote, templateErrorMessage, templateNames, type EnvLookup } from '../src/templates';

const env: EnvLookup = (name) => ({ HOME: '/home/me', DBT_SCHEMA: 'analytics_dev' })[name];
const command = (src: string, context: Record<string, unknown> = {}) => renderTemplate(src, { mode: 'command', context, env });
const text = (src: string, context: Record<string, unknown> = {}) => renderTemplate(src, { mode: 'text', context, env });
const error = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return templateErrorMessage(e);
  }
  throw new Error('expected an error');
};

describe('shellQuote', () => {
  it('single-quotes any value for POSIX shells', () => {
    expect(shellQuote('orders v2')).toBe(`'orders v2'`);
    expect(shellQuote(`it's`)).toBe(`'it'\\''s'`);
    expect(shellQuote('')).toBe(`''`);
  });
});

describe('renderTemplate', () => {
  it('quotes every value in commands', () => {
    expect(command('dbt build -s {{ model }} --target {{ t | upper }}', { model: 'orders v2', t: 'dev' })).toBe(`dbt build -s 'orders v2' --target 'DEV'`);
  });

  it('keeps a hostile or multi-line value as one quoted argument', () => {
    expect(command('echo {{ v }}', { v: `x'; rm -rf / #\n{{ y }}` })).toBe(`echo 'x'\\''; rm -rf / #\n{{ y }}'`);
  });

  it('lets | unquoted opt out, and leaves literal text alone', () => {
    expect(command('dbt run {{ flags | unquoted }}', { flags: '--full-refresh --threads 8' })).toBe('dbt run --full-refresh --threads 8');
    expect(command('dbt run {% if full %}--full-refresh{% endif %} -s {{ m }}', { full: true, m: 'x' })).toBe(`dbt run --full-refresh -s 'x'`);
  });

  it('leaves raw blocks, whitespace control and strings containing }} intact', () => {
    expect(command(`{% raw %}{{ ref('orders') }}{% endraw %} {{ m }}`, { m: 'x' })).toBe(`{{ ref('orders') }} 'x'`);
    expect(command('{{- m -}} !', { m: 'x' })).toBe(`'x'!`);
    expect(command('{{ "}}" }}')).toBe(`'}}'`);
  });

  it('inserts values as-is in text', () => {
    expect(text('Use {{ schema }} please', { schema: `dev's` })).toBe(`Use dev's please`);
  });

  it('reads environment variables with env_var', () => {
    expect(command(`echo {{ env_var('HOME') }} {{ env_var('NOPE', 'dflt') }}`)).toBe(`echo '/home/me' 'dflt'`);
    expect(error(() => command(`echo {{ env_var('NOPE') }}`))).toBe('environment variable NOPE is not set on this machine');
  });

  it('refuses undefined output and file includes', () => {
    expect(error(() => command('echo {{ a.missing }}', { a: {} }))).toContain('attempted to output null or undefined value');
    expect(error(() => text(`{% include 'x' %}`))).toContain('template not found: x');
  });

  it('reports syntax errors', () => {
    expect(error(() => command('bad {{ x ', { x: 1 }))).toBe('expected variable end');
  });
});

describe('templateNames', () => {
  it('lists names a template uses but does not define', () => {
    const src =
      "{{ a | upper | replace('x', b) }}{% for i in items %}{{ i.name }}{{ loop.index }}{% endfor %}{% set c = d %}{{ c }}{{ env_var('X') }}{% if e is defined %}{{ f['k'] }}{% endif %}{{ g.h(j) }}{{ True }}{% raw %}{{ ref('x') }}{% endraw %}";
    expect(templateNames(src)).toEqual({ ok: true, names: ['a', 'b', 'd', 'e', 'f', 'g', 'items', 'j'] });
    expect(templateNames(`{{ ref('orders') }} {{ source('a', 'b') }}`)).toEqual({ ok: true, names: ['ref', 'source'] });
    expect(templateNames('{% for k, v in d %}{{ k }}{{ v }}{% endfor %}{{ x if y else z }}')).toEqual({ ok: true, names: ['d', 'x', 'y', 'z'] });
  });

  it('reports a syntax error instead of names', () => {
    expect(templateNames('bad {{ x ')).toEqual({ ok: false, error: 'expected variable end' });
  });
});

describe('renameReferences', () => {
  it('renames variable references inside tags only', () => {
    expect(renameReferences('Use schema {{ schema }} {% if schema %}x{% endif %}', 'schema', 'target')).toBe('Use schema {{ target }} {% if target %}x{% endif %}');
  });

  it('leaves attributes, filters and raw blocks alone', () => {
    expect(renameReferences('{{ a.schema }} {{ x | schema }} {% raw %}{{ schema }}{% endraw %}', 'schema', 'target')).toBe(
      '{{ a.schema }} {{ x | schema }} {% raw %}{{ schema }}{% endraw %}',
    );
  });

  it('works across lines and returns broken templates unchanged', () => {
    expect(renameReferences('line\r\n  {{ schema }}', 'schema', 'target')).toBe('line\r\n  {{ target }}');
    expect(renameReferences('{{ "unterminated', 'schema', 'target')).toBe('{{ "unterminated');
  });
});

describe('command quoting by shell context', () => {
  it('quotes values even when raw blocks hold unbalanced tags', () => {
    // The raw text's lone `"` opens a double quote, so the value is escaped for that context (the shell then rejects the unterminated quote).
    expect(command('echo {% raw %}{{ " }}{% endraw %} {{ v }}', { v: 'a b' })).toBe('echo {{ " }} a b');
    expect(command('printf %s {% raw %}{{ "{% endraw %}" }}{{ v }}', { v: '$(echo PWNED)' })).toBe(`printf %s {{ "" }}'$(echo PWNED)'`);
  });

  it('only exempts the value | unquoted is applied to', () => {
    expect(command('echo {{ v ~ w | unquoted }}', { v: 'x;', w: ' echo INJECTED' })).toBe(`echo 'x; echo INJECTED'`);
    expect(command('echo {{ v if c else w | unquoted }}', { v: 'x;', w: 'y z', c: true })).toBe(`echo 'x;'`);
  });

  it('does not repair syntax errors', () => {
    expect(() => command('echo {{ v) ~ (w }}', { v: 'a', w: 'b' })).toThrow();
  });

  it('adapts to quotes the author wrote around the expression', () => {
    expect(command(`printf %s '{{ v }}'`, { v: `it's $(x)` })).toBe(`printf %s 'it'\\''s $(x)'`);
    expect(command('printf %s "{{ v }}"', { v: 'a"$b`c\\' })).toBe('printf %s "a\\"\\$b\\`c\\\\"');
    expect(command(`dbt run --vars '{"schema": "{{ v }}"}'`, { v: 'dev' })).toBe(`dbt run --vars '{"schema": "dev"}'`);
  });

  it('refuses contexts it cannot quote safely', () => {
    expect(error(() => command('echo \\{{ v }}', { v: 'x' }))).toBe('A \\ right before {{ }} would cancel its quoting. Remove the backslash.');
    expect(error(() => command('echo "$(cat {{ f }})"', { f: 'x' }))).toBe(C);
    expect(error(() => command('cat <<EOF\n{{ v }}\nEOF', { v: 'x' }))).toBe("{{ }} after a heredoc (<<) can't be quoted safely. Pass the value as an argument instead.");
    expect(command('cat <<<{{ v }}', { v: 'a b' })).toBe(`cat <<<'a b'`);
  });

  it('quotes a {% set %} capture once', () => {
    expect(command('{% set s %}{{ v }}-x{% endset %}echo {{ s }}', { v: 'a b' })).toBe(`echo 'a b-x'`);
  });

  it('refuses | safe in commands', () => {
    expect(error(() => command('echo {{ v | safe }}', { v: 'x' }))).toBe('Use | unquoted to insert a value without quotes.');
  });

  it('keeps error lines identical in both modes', () => {
    const src = '{{\n v\n}}\n{% bogus %}';
    expect(error(() => command(src, { v: 'x' }))).toBe(error(() => text(src, { v: 'x' })));
  });
});

const A = 'A \\ right before {{ }} would cancel its quoting. Remove the backslash.';
const B = "{{ }} after a heredoc (<<) can't be quoted safely. Pass the value as an argument instead.";
const C = "{{ }} after a backtick, $((, ${, $' or $\" can't be quoted safely. Put the value before them, or outside them.";
const D = "{{ }} inside a # comment isn't allowed.";

describe('conservative shell scanner', () => {
  it('refuses heredocs in any quote context, comments, and nested or exotic contexts', () => {
    expect(error(() => command("cat <<EOF\n'{{ v }}'\nEOF", { v: 'x' }))).toBe(B);
    expect(error(() => command('echo hi # {{ v }}', { v: 'x' }))).toBe(D);
    expect(error(() => command('echo "$(printf %s "{{ v }}")"', { v: 'x' }))).toBe(C);
    expect(error(() => command('echo `printf %s {{ v }}`', { v: 'x' }))).toBe(C);
    expect(error(() => command("printf %s $'{{ v }}'", { v: 'x' }))).toBe(C);
    expect(error(() => command('echo $(( {{ v }} ))', { v: 'x' }))).toBe(C);
    expect(error(() => command('echo ${x:-{{ v }}}', { v: 'x' }))).toBe(C);
    expect(error(() => command('echo "\\{{ v }}"', { v: 'x' }))).toBe(A);
  });

  it('is not fooled by an apostrophe in a comment', () => {
    expect(command("echo hi # don't\necho {{ v }}", { v: '; echo PWNED' })).toBe("echo hi # don't\necho '; echo PWNED'");
  });

  it('quotes inside a plain command substitution', () => {
    expect(command('echo $(printf %s {{ v }})', { v: 'a b' })).toBe(`echo $(printf %s 'a b')`);
    expect(command('echo $(printf %s "{{ v }}")', { v: 'a"$b' })).toBe('echo $(printf %s "a\\"\\$b")');
  });

  it('refuses a filter that mangles an inserted value', () => {
    expect(error(() => command('{% set s %}{{ v }}{% endset %}echo {{ s | upper }}', { v: 'a' }))).toBe(
      'A filter changed a value inserted with {{ }}. Apply the filter to the value itself, e.g. {{ v | upper }}.',
    );
  });

  it('is re-entrant', () => {
    const nested: EnvLookup = (name) => (name === 'X' ? renderTemplate('echo {{ w }}', { mode: 'command', context: { w: 'n n' }, env }) : undefined);
    const out = renderTemplate(`echo {{ a }} {{ env_var('X') }} {{ b }}`, { mode: 'command', context: { a: 'a a', b: 'b b' }, env: nested });
    expect(out).toBe(`echo 'a a' ${shellQuote(`echo 'n n'`)} 'b b'`);
  });
});

describe('sandbox', () => {
  const attempts = [
    `{{ constructor }}`,
    `{{ "".constructor }}`,
    `{{ range.constructor("return 1")() }}`,
    `{{ range[["constructor"]]("return 1")() }}`,
    `{{ {}.get("constructor") }}`,
    `{% set d = {} %}{{ d.get("__proto__") }}`,
    `{{ range.caller }}`,
    `{{ x.__proto__ }}`,
  ];
  it.each(attempts)('blocks %s', (src) => {
    expect(() => text(src, { x: {} })).toThrow();
    expect(() => command(src, { x: {} })).toThrow();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('keeps True, False and None', () => {
    expect(text('{{ True }} {{ False }}')).toBe('true false');
    expect(text('{% if None %}x{% endif %}')).toBe('');
  });
});

describe.skipIf(process.platform === 'win32')('real shell', () => {
  const v = `x'; echo PWNED; '$(echo PWNED)"\`\\`;
  const shells = ['/bin/sh', '/bin/zsh'].filter((s) => existsSync(s));
  const cases: [string, string | undefined][] = [
    [`printf '%s|' {{ v }}`, `${v}|`],
    [`printf '%s|' '{{ v }}'`, `${v}|`],
    [`printf '%s|' "{{ v }}"`, `${v}|`],
    [`printf '%s|' $(printf %s {{ v }})`, undefined],
    [`echo hi # don't\nprintf '%s|' {{ v }}`, `hi\n${v}|`],
  ];
  for (const sh of shells) {
    it.each(cases)(`${sh}: %s`, (src, expected) => {
      let out: string;
      try {
        out = execFileSync(sh, ['-c', command(src, { v })], { stdio: ['ignore', 'pipe', 'pipe'] }).toString();
      } catch (e) {
        out = String((e as { stdout?: Buffer }).stdout ?? ''); // an unparseable result is fine; nothing may execute
      }
      expect(out).not.toContain('PWNED\n');
      if (expected !== undefined) expect(out).toBe(expected);
    });
  }
});
