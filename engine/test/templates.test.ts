import { describe, expect, it } from 'vitest';
import { quoteCommandTemplate, renameReferences, renderTemplate, shellQuote, templateErrorMessage, templateNames, type EnvLookup } from '../src/templates';

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

describe('quoteCommandTemplate', () => {
  it('wraps each expression in the quoting filter', () => {
    expect(quoteCommandTemplate('a {{ x }} b {{ y | unquoted }}')).toBe('a {{ (x) | _shq }} b {{ y | unquoted }}');
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
