import {describe, expect, it} from 'vitest';
import {
  compareSignatures,
  extractSignature,
  formatMessage,
  hashSignature,
  parseIcu,
  pluralCategoriesFor,
  pluralCategoryFor,
  type MessageSignature,
} from '../src/shared/icu';

function signatureOf(message: string): MessageSignature {
  const parsed = parseIcu(message);
  if (!parsed.ok) throw new Error(`test message does not parse: ${parsed.error.message}`);
  return extractSignature(parsed.ast);
}

function format(message: string, values: Record<string, string | number>, locale: string): string {
  const parsed = parseIcu(message);
  if (!parsed.ok) throw new Error(`test message does not parse: ${parsed.error.message}`);
  return formatMessage(parsed.ast, values, locale);
}

describe('apostrophe escaping', () => {
  it("treats '' as a literal apostrophe", () => {
    expect(format("It''s ready", {}, 'en')).toBe("It's ready");
  });

  it('treats quoted braces as literal text, not placeholders', () => {
    const signature = signatureOf("'{count}' {count}");
    expect(signature.args.map(arg => arg.name)).toEqual(['count']);
    expect(format("'{count}' {count}", {count: 3}, 'en')).toBe('{count} 3');
  });

  it("parses ''{arg}'' as a placeholder wrapped in literal apostrophes", () => {
    expect(format("''{section}''", {section: 'Intro'}, 'en')).toBe("'Intro'");
  });

  it('keeps apostrophes around placeholders inside plural branches', () => {
    const message = "{n, plural, one {It''s # file} other {It''s # files}}";
    expect(format(message, {n: 1}, 'en')).toBe("It's 1 file");
    expect(format(message, {n: 4}, 'en')).toBe("It's 4 files");
  });
});

describe('nested plural/select', () => {
  const message =
    '{gender, select, female {{count, plural, one {She shared # photo} other {She shared # photos}}} ' +
    'male {{count, plural, one {He shared # photo} other {He shared # photos}}} ' +
    'other {{count, plural, one {They shared # photo} other {They shared # photos}}}}';

  it('extracts arguments from nested branches', () => {
    const signature = signatureOf(message);
    const gender = signature.args.find(arg => arg.name === 'gender');
    const count = signature.args.find(arg => arg.name === 'count');
    expect(gender?.types).toEqual(['select']);
    expect(gender?.select?.options).toEqual(['female', 'male', 'other']);
    expect(count?.types).toEqual(['plural']);
    expect(count?.plural?.categories).toEqual(['one', 'other']);
  });

  it('formats through the nested branches', () => {
    expect(format(message, {gender: 'female', count: 1}, 'en')).toBe('She shared 1 photo');
    expect(format(message, {gender: 'male', count: 3}, 'en')).toBe('He shared 3 photos');
    expect(format(message, {gender: 'other', count: 1}, 'en')).toBe('They shared 1 photo');
  });

  it('flags a nested plural dropped by the translation', () => {
    const reference = signatureOf(message);
    const target = signatureOf(
      '{gender, select, female {Elle a partagé des photos} male {Il a partagé des photos} other {Iels ont partagé des photos}}',
    );
    const diagnostics = compareSignatures(reference, target, {locale: 'fr-FR'});
    expect(diagnostics.some(d => d.code === 'missing-argument' && d.arg === 'count')).toBe(true);
  });
});

describe('exact number branches', () => {
  const message = '{n, plural, =0 {nothing} one {one thing} other {# things}}';

  it('prefers the exact =N branch over the keyword category', () => {
    // In French 0 selects the "one" category; the =0 branch must still win.
    expect(format(message, {n: 0}, 'fr-FR')).toBe('nothing');
    expect(format(message, {n: 1}, 'fr-FR')).toBe('one thing');
    expect(format(message, {n: 2}, 'fr-FR')).toBe('2 things');
  });

  it('records exact branches in the signature', () => {
    const signature = signatureOf(message);
    expect(signature.args[0].plural?.exact).toEqual([0]);
    expect(signature.args[0].plural?.categories).toEqual(['one', 'other']);
  });

  it('diagnoses a missing exact branch with the plural element range', () => {
    const reference = signatureOf(message);
    const targetMessage = '{n, plural, one {un} other {plusieurs}}';
    const target = signatureOf(targetMessage);
    const diagnostics = compareSignatures(reference, target, {locale: 'fr-FR'});
    const missing = diagnostics.find(d => d.code === 'missing-plural-exact');
    expect(missing?.branch).toBe('=0');
    expect(missing?.severity).toBe('error');
    expect(missing?.range).toEqual({start: 0, end: targetMessage.length});
  });

  it('diagnoses an extra exact branch as a warning anchored on the branch', () => {
    const reference = signatureOf('{n, plural, one {one} other {#}}');
    const targetMessage = '{n, plural, =0 {rien} one {un} other {plusieurs}}';
    const target = signatureOf(targetMessage);
    const diagnostics = compareSignatures(reference, target, {locale: 'fr-FR'});
    const extra = diagnostics.find(d => d.code === 'extra-plural-exact');
    expect(extra?.severity).toBe('warning');
    expect(extra?.branch).toBe('=0');
    // The range points at the "=0" branch body inside the message.
    expect(targetMessage.slice(extra!.range.start, extra!.range.end)).toBe('{rien}');
  });
});

describe('missing other clause', () => {
  it('rejects plural without other, with a character range', () => {
    const message = '{n, plural, one {x}}';
    const parsed = parseIcu(message);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error.code).toBe('parse-error');
      expect(parsed.error.message).toContain('MISSING_OTHER_CLAUSE');
      expect(parsed.error.range.start).toBeGreaterThanOrEqual(0);
      expect(parsed.error.range.start).toBeLessThanOrEqual(message.length);
    }
  });

  it('rejects select without other', () => {
    const parsed = parseIcu('{g, select, female {x}}');
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error.message).toContain('MISSING_OTHER_CLAUSE');
  });

  it('reports unterminated arguments with a range', () => {
    const parsed = parseIcu('hello {name');
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error.range.start).toBeGreaterThan(0);
  });
});

describe('locale-specific plural categories', () => {
  it('exposes CLDR categories per locale', () => {
    expect(pluralCategoriesFor('en')).toEqual(['one', 'other']);
    expect(pluralCategoriesFor('ru')).toEqual(['few', 'many', 'one', 'other']);
    expect(pluralCategoriesFor('ar')).toEqual(['few', 'many', 'one', 'other', 'two', 'zero']);
    expect(pluralCategoriesFor('ja')).toEqual(['other']);
  });

  it('selects categories per locale rules', () => {
    expect(pluralCategoryFor('fr-FR', 'cardinal', 0)).toBe('one');
    expect(pluralCategoryFor('en', 'cardinal', 0)).toBe('other');
    expect(pluralCategoryFor('ar', 'cardinal', 0)).toBe('zero');
    expect(pluralCategoryFor('ar', 'cardinal', 2)).toBe('two');
    expect(pluralCategoryFor('ru', 'cardinal', 5)).toBe('many');
    expect(pluralCategoryFor('ru', 'cardinal', 2)).toBe('few');
  });

  it('renders the same draft under different locale rules', () => {
    const message = '{n, plural, one {# un} other {# autres}}';
    expect(format(message, {n: 0}, 'fr-FR')).toBe('0 un');
    expect(format(message, {n: 0}, 'en')).toBe('0 autres');
  });

  it('requires the target locale categories even when the source lacks them', () => {
    const reference = signatureOf('{n, plural, one {# item} other {# items}}');
    const target = signatureOf('{n, plural, one {# элемент} other {# элементов}}');
    const diagnostics = compareSignatures(reference, target, {locale: 'ru'});
    const missing = diagnostics.filter(d => d.code === 'missing-plural-category').map(d => d.branch);
    expect(missing.sort()).toEqual(['few', 'many']);
    expect(diagnostics.every(d => d.severity === 'error')).toBe(true);
  });

  it('warns about categories the locale can never select', () => {
    const target = signatureOf('{n, plural, one {x} few {y} other {z}}');
    const diagnostics = compareSignatures(null, target, {locale: 'en'});
    const invalid = diagnostics.find(d => d.code === 'invalid-plural-category');
    expect(invalid?.branch).toBe('few');
    expect(invalid?.severity).toBe('warning');
  });

  it('does not demand source categories the target locale cannot select', () => {
    const reference = signatureOf('{n, plural, one {# item} other {# items}}');
    const target = signatureOf('{n, plural, other {# 件}}');
    const diagnostics = compareSignatures(reference, target, {locale: 'ja'});
    expect(diagnostics.filter(d => d.severity === 'error')).toEqual([]);
  });
});

describe('argument and type comparison', () => {
  const reference = signatureOf('{count, plural, one {# item} other {# items}} by {name}');

  it('flags missing and extra arguments', () => {
    const target = signatureOf('{total} éléments');
    const diagnostics = compareSignatures(reference, target, {locale: 'fr-FR'});
    expect(diagnostics.some(d => d.code === 'missing-argument' && d.arg === 'count')).toBe(true);
    expect(diagnostics.some(d => d.code === 'missing-argument' && d.arg === 'name')).toBe(true);
    expect(diagnostics.some(d => d.code === 'extra-argument' && d.arg === 'total')).toBe(true);
  });

  it('flags argument type mismatches anchored at the target occurrence', () => {
    const targetMessage = '{count} éléments par {name}';
    const target = signatureOf(targetMessage);
    const diagnostics = compareSignatures(reference, target, {locale: 'fr-FR'});
    const mismatch = diagnostics.find(d => d.code === 'argument-type-mismatch' && d.arg === 'count');
    expect(mismatch?.severity).toBe('error');
    expect(targetMessage.slice(mismatch!.range.start, mismatch!.range.end)).toBe('{count}');
  });

  it('flags missing select options', () => {
    const ref = signatureOf('{g, select, female {She} male {He} other {They}}');
    const target = signatureOf('{g, select, female {Elle} other {Iels}}');
    const diagnostics = compareSignatures(ref, target, {locale: 'fr-FR'});
    expect(diagnostics.some(d => d.code === 'missing-select-option' && d.branch === 'male')).toBe(true);
  });
});

describe('number, date and plural offset formatting', () => {
  it('formats number skeletons per locale', () => {
    const message = '{t, number, ::currency/USD}';
    expect(format(message, {t: 1234.5}, 'en')).toBe('$1,234.50');
    expect(format(message, {t: 1234.5}, 'fr-FR')).toContain('234,50');
  });

  it('formats classic number styles', () => {
    expect(format('{p, number, percent}', {p: 0.42}, 'en')).toBe('42%');
    expect(format('{p, number, integer}', {p: 3.7}, 'en')).toBe('4');
  });

  it('formats dates per locale', () => {
    const message = '{d, date, long}';
    expect(format(message, {d: '2026-09-26'}, 'en')).toBe('September 26, 2026');
    expect(format(message, {d: '2026-09-26'}, 'fr-FR')).toBe('26 septembre 2026');
  });

  it('applies plural offset to category selection and #', () => {
    const message = '{n, plural, offset:1 =0 {none} one {one more} other {# more}}';
    expect(format(message, {n: 0}, 'en')).toBe('none');
    expect(format(message, {n: 2}, 'en')).toBe('one more');
    expect(format(message, {n: 4}, 'en')).toBe('3 more');
  });

  it('renders placeholders for missing values instead of crashing', () => {
    expect(format('Hi {name}, {n, plural, one {# left} other {# left}}', {}, 'en')).toBe('Hi {name}, {n} left');
  });
});

describe('signature hashing', () => {
  it('is stable and independent of character positions', () => {
    const a = signatureOf('Hello {name}, you have {n, plural, one {# msg} other {# msgs}}');
    const b = signatureOf('{n, plural, one {# msg} other {# msgs}} — {name}!');
    expect(hashSignature(a)).toBe(hashSignature(b));
  });

  it('changes when the structure changes', () => {
    const a = signatureOf('{n, plural, one {# msg} other {# msgs}}');
    const renamed = signatureOf('{total, plural, one {# msg} other {# msgs}}');
    const branchAdded = signatureOf('{n, plural, =0 {none} one {# msg} other {# msgs}}');
    expect(hashSignature(a)).not.toBe(hashSignature(renamed));
    expect(hashSignature(a)).not.toBe(hashSignature(branchAdded));
  });
});
