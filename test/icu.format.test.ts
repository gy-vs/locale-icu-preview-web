import {describe, expect, it} from 'vitest';
import {formatMessage, parseMessage, tryFormat} from '../src/shared/icu/index';

function render(message: string, values: Record<string, string | number>, locale = 'en'): string {
  const {nodes, diagnostics} = parseMessage(message);
  expect(diagnostics.filter(diagnostic => diagnostic.severity === 'error')).toEqual([]);
  return formatMessage(nodes, values, locale).rendered;
}

describe('plural rendering per locale', () => {
  const message = '{count, plural, one {# item} other {# items}}';

  it('selects one/other in English', () => {
    expect(render(message, {count: 1})).toBe('1 item');
    expect(render(message, {count: 2})).toBe('2 items');
  });

  it('treats 0 as "one" in French', () => {
    expect(render('{count, plural, one {# élément} other {# éléments}}', {count: 0}, 'fr-FR')).toBe('0 élément');
    expect(render('{count, plural, one {# élément} other {# éléments}}', {count: 2}, 'fr-FR')).toBe('2 éléments');
  });

  it('selects few/many in Russian', () => {
    const ru = '{count, plural, one {# штука} few {# штуки} many {# штук} other {# штуки}}';
    expect(render(ru, {count: 1}, 'ru')).toBe('1 штука');
    expect(render(ru, {count: 2}, 'ru')).toBe('2 штуки');
    expect(render(ru, {count: 5}, 'ru')).toBe('5 штук');
    expect(render(ru, {count: 1.5}, 'ru')).toBe('1,5 штуки');
  });

  it('selects zero/two in Arabic', () => {
    const ar = '{n, plural, zero {لا شيء} one {واحد} two {اثنان} few {# أشياء} many {# شيئًا} other {# شيء}}';
    const num = (value: number) => new Intl.NumberFormat('ar').format(value);
    expect(render(ar, {n: 0}, 'ar')).toBe('لا شيء');
    expect(render(ar, {n: 2}, 'ar')).toBe('اثنان');
    expect(render(ar, {n: 3}, 'ar')).toBe(`${num(3)} أشياء`);
    expect(render(ar, {n: 11}, 'ar')).toBe(`${num(11)} شيئًا`);
  });

  it('always uses other in Japanese', () => {
    expect(render('{n, plural, other {# 個}}', {n: 1}, 'ja')).toBe('1 個');
    expect(render('{n, plural, other {# 個}}', {n: 5}, 'ja')).toBe('5 個');
  });

  it('prefers exact =N branches over categories', () => {
    const cart = '{count, plural, =0 {Your cart is empty} one {# item} other {# items}}';
    expect(render(cart, {count: 0})).toBe('Your cart is empty');
    expect(render(cart, {count: 1})).toBe('1 item');
    // French would pick "one" for 0, but the exact branch wins.
    expect(render(cart, {count: 0}, 'fr-FR')).toBe('Your cart is empty');
  });

  it('applies offset to both # and category selection', () => {
    const msg = '{n, plural, offset:1 =0 {nobody} one {just you} other {you and # others}}';
    expect(render(msg, {n: 0})).toBe('nobody');
    expect(render(msg, {n: 2})).toBe('just you');
    expect(render(msg, {n: 4})).toBe('you and 3 others');
  });

  it('supports ordinal plurals', () => {
    const ord = '{n, selectordinal, one {#st} two {#nd} few {#rd} other {#th}}';
    expect(render(ord, {n: 1})).toBe('1st');
    expect(render(ord, {n: 2})).toBe('2nd');
    expect(render(ord, {n: 3})).toBe('3rd');
    expect(render(ord, {n: 11})).toBe('11th');
  });
});

describe('select and nesting', () => {
  it('selects branches with other fallback', () => {
    const msg = '{gender, select, female {she} male {he} other {they}}';
    expect(render(msg, {gender: 'female'})).toBe('she');
    expect(render(msg, {gender: 'unknown'})).toBe('they');
  });

  it('renders nested plural inside select with shared values', () => {
    const msg =
      '{gender, select, female {{host} invited you and {count, plural, offset:1 =0 {nobody else} one {# other person} other {# other people}} to her party} ' +
      'other {{host} invited you and {count, plural, offset:1 =0 {nobody else} one {# other person} other {# other people}} to their party}}';
    // Exact =N matches the input value itself, before the offset is applied.
    expect(render(msg, {gender: 'female', host: 'Ann', count: 0})).toBe('Ann invited you and nobody else to her party');
    expect(render(msg, {gender: 'x', host: 'Bo', count: 3})).toBe('Bo invited you and 2 other people to their party');
  });
});

describe('number, date and time formatting', () => {
  it('formats percent and integer styles', () => {
    expect(render('{v, number, percent}', {v: 0.42})).toBe('42%');
    expect(render('{v, number, integer}', {v: 3.7})).toBe('4');
  });

  it('formats numbers per locale', () => {
    const formatted = render('{v, number}', {v: 1234.5}, 'fr-FR');
    expect(formatted).toBe(new Intl.NumberFormat('fr-FR').format(1234.5));
    expect(formatted).not.toBe('1234.5');
  });

  it('formats currency styles', () => {
    expect(render('{v, number, currency/USD}', {v: 3})).toBe(
      new Intl.NumberFormat('en', {style: 'currency', currency: 'USD'}).format(3),
    );
  });

  it('formats dates per locale and style', () => {
    const iso = '2026-09-26T12:00:00Z';
    expect(render('{d, date, medium}', {d: iso}, 'fr-FR')).toBe(
      new Intl.DateTimeFormat('fr-FR', {dateStyle: 'medium'}).format(new Date(iso)),
    );
    expect(render('{t, time, short}', {t: iso}, 'en')).toBe(
      new Intl.DateTimeFormat('en', {timeStyle: 'short'}).format(new Date(iso)),
    );
  });
});

describe('apostrophes and placeholders', () => {
  it('renders escaped apostrophes literally', () => {
    expect(render("You''ve got mail", {})).toBe("You've got mail");
  });

  it('renders quoted braces literally, ignoring values', () => {
    expect(render("'{name}'", {name: 'Ari'})).toBe('{name}');
  });

  it('renders placeholders and reports missing values', () => {
    const result = tryFormat('Welcome, {name}! You have {count, plural, one {# msg} other {# msgs}}', {}, 'en');
    expect(result).not.toBeNull();
    expect(result!.rendered).toBe('Welcome, {name}! You have {count}');
    expect(result!.missingValues).toEqual(expect.arrayContaining(['name', 'count']));
  });

  it('returns null from tryFormat when the message does not parse', () => {
    expect(tryFormat('{count, plural, one {x}', {}, 'en')).toBeNull();
  });
});
