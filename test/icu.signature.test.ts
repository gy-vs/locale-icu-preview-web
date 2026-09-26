import {describe, expect, it} from 'vitest';
import {
  analyzeMessage,
  buildTargetIndex,
  checkLocaleCoverage,
  compareSignatures,
  extractSignature,
  parseMessage,
} from '../src/shared/icu/index';
import type {Diagnostic, Signature} from '../src/shared/icu/index';

function signatureOf(message: string): Signature {
  return extractSignature(parseMessage(message).nodes).signature;
}

function compare(sourceMessage: string, targetMessage: string): Diagnostic[] {
  const source = signatureOf(sourceMessage);
  const parsedTarget = parseMessage(targetMessage);
  const target = extractSignature(parsedTarget.nodes).signature;
  return compareSignatures(source, target, buildTargetIndex(parsedTarget.nodes), targetMessage.length);
}

describe('signature extraction', () => {
  it('captures plural keywords, exact matches and offset', () => {
    const signature = signatureOf('{count, plural, offset:1 =0 {none} one {# item} other {# items}}');
    expect(signature.params.count).toMatchObject({
      kind: 'plural',
      offset: 1,
      keywords: ['one', 'other'],
      exacts: [0],
      ordinal: false,
    });
  });

  it('captures select options and nested parameters', () => {
    const signature = signatureOf(
      '{gender, select, female {{host} invited {count, plural, one {# person} other {# people}}} other {{host} invited you}}',
    );
    const gender = signature.params.gender;
    expect(gender).toMatchObject({kind: 'select', options: ['female', 'other']});
    if (gender.kind !== 'select') throw new Error('expected select');
    expect(gender.nested.host).toEqual({kind: 'string'});
    expect(gender.nested.count).toMatchObject({kind: 'plural', keywords: ['one', 'other']});
  });

  it('captures number/date/time argument types', () => {
    const signature = signatureOf('{v, number, percent} {d, date, medium} {t, time, short} {s}');
    expect(signature.params.v).toEqual({kind: 'number'});
    expect(signature.params.d).toEqual({kind: 'date'});
    expect(signature.params.t).toEqual({kind: 'time'});
    expect(signature.params.s).toEqual({kind: 'string'});
  });

  it('flags conflicting types for the same parameter', () => {
    const {diagnostics} = extractSignature(parseMessage('{x} {x, number}').nodes);
    expect(diagnostics.some(diagnostic => diagnostic.code === 'PARAM_TYPE_CONFLICT')).toBe(true);
  });
});

describe('signature comparison (source vs target)', () => {
  it('reports parameters missing from the target, located at the message end', () => {
    const target = 'Bienvenue !';
    const diagnostics = compare('Welcome, {name}!', target);
    const missing = diagnostics.find(diagnostic => diagnostic.code === 'MISSING_PARAM');
    expect(missing).toBeDefined();
    expect(missing!.severity).toBe('error');
    expect(missing!.param).toBe('name');
    expect(missing!.start).toBe(target.length);
  });

  it('reports extra parameters in the target as warnings with ranges', () => {
    const target = 'Bonjour {name} {extra}';
    const diagnostics = compare('Hello {name}', target);
    const extra = diagnostics.find(diagnostic => diagnostic.code === 'EXTRA_PARAM');
    expect(extra).toBeDefined();
    expect(extra!.severity).toBe('warning');
    expect(target.slice(extra!.start, extra!.end)).toBe('{extra}');
  });

  it('reports type mismatches located at the target argument', () => {
    const target = '{count} éléments';
    const diagnostics = compare('{count, plural, one {# item} other {# items}}', target);
    const mismatch = diagnostics.find(diagnostic => diagnostic.code === 'TYPE_MISMATCH');
    expect(mismatch).toBeDefined();
    expect(target.slice(mismatch!.start, mismatch!.end)).toBe('{count}');
  });

  it('reports missing plural categories, pointing at the plural header', () => {
    const target = '{count, plural, other {# articles}}';
    const diagnostics = compare('{count, plural, one {# item} other {# items}}', target);
    const missing = diagnostics.find(diagnostic => diagnostic.code === 'MISSING_PLURAL_CATEGORY');
    expect(missing).toBeDefined();
    expect(missing!.message).toContain('"one"');
    expect(target.slice(missing!.start, missing!.end)).toBe('{count');
  });

  it('reports missing exact =N branches', () => {
    const diagnostics = compare(
      '{count, plural, =0 {empty} other {# items}}',
      '{count, plural, other {# éléments}}',
    );
    const missing = diagnostics.find(diagnostic => diagnostic.code === 'MISSING_EXACT_MATCH');
    expect(missing).toBeDefined();
    expect(missing!.message).toContain('=0');
  });

  it('reports extra plural categories as warnings', () => {
    const diagnostics = compare(
      '{count, plural, other {# items}}',
      '{count, plural, one {# artículo} few {# algunos} other {# artículos}}',
    );
    const codes = diagnostics.map(diagnostic => diagnostic.code);
    expect(codes).toContain('EXTRA_PLURAL_CATEGORY');
    expect(diagnostics.find(diagnostic => diagnostic.code === 'EXTRA_PLURAL_CATEGORY')!.severity).toBe('warning');
  });

  it('reports missing select options', () => {
    const diagnostics = compare(
      '{gender, select, female {she} male {he} other {they}}',
      '{gender, select, female {elle} other {iels}}',
    );
    const missing = diagnostics.find(diagnostic => diagnostic.code === 'MISSING_SELECT_OPTION');
    expect(missing).toBeDefined();
    expect(missing!.message).toContain('"male"');
  });

  it('compares nested parameters inside branches', () => {
    const diagnostics = compare(
      '{gender, select, female {{host} invited you} other {{host} invited you}}',
      '{gender, select, female {invitée} other {invité}}',
    );
    const missing = diagnostics.filter(diagnostic => diagnostic.code === 'MISSING_PARAM');
    expect(missing).toHaveLength(1);
    expect(missing[0].param).toBe('host');
    expect(missing[0].message).toContain('gender');
  });
});

describe('locale plural-category coverage', () => {
  it('warns about Arabic categories missing from the message', () => {
    const {nodes} = parseMessage('{n, plural, one {واحد} other {كثير}}');
    const diagnostics = checkLocaleCoverage(nodes, 'ar');
    const missing = diagnostics.filter(diagnostic => diagnostic.code === 'MISSING_LOCALE_CATEGORY');
    // Arabic uses zero/one/two/few/many/other; the message only covers one/other.
    expect(missing.map(diagnostic => diagnostic.message)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('"zero"'),
        expect.stringContaining('"two"'),
        expect.stringContaining('"few"'),
        expect.stringContaining('"many"'),
      ]),
    );
    expect(missing.every(diagnostic => diagnostic.severity === 'warning')).toBe(true);
  });

  it('flags branches a locale can never select (Japanese has only "other")', () => {
    const {nodes} = parseMessage('{n, plural, one {1個} other {#個}}');
    const diagnostics = checkLocaleCoverage(nodes, 'ja');
    const unused = diagnostics.find(diagnostic => diagnostic.code === 'UNUSED_CATEGORY');
    expect(unused).toBeDefined();
    expect(unused!.message).toContain('"one"');
  });

  it('accepts a message covering exactly the locale categories', () => {
    // French selects "many" for exact millions, so all three branches are needed.
    const {nodes} = parseMessage('{n, plural, one {# élément} many {# millions} other {# éléments}}');
    expect(checkLocaleCoverage(nodes, 'fr-FR')).toEqual([]);
  });

  it('checks nested plurals too', () => {
    const {nodes} = parseMessage('{g, select, female {{n, plural, one {x} other {y}}} other {z}}');
    const diagnostics = checkLocaleCoverage(nodes, 'ar');
    expect(diagnostics.some(diagnostic => diagnostic.code === 'MISSING_LOCALE_CATEGORY')).toBe(true);
  });
});

describe('analyzeMessage pipeline', () => {
  it('combines parse, comparison and locale diagnostics, sorted by range', () => {
    const analysis = analyzeMessage('{count, plural, other {# éléments}}', {
      locale: 'fr-FR',
      sourceMessage: '{count, plural, one {# item} other {# items}}',
    });
    expect(analysis.ok).toBe(false); // missing "one" branch is an error
    expect(analysis.diagnostics.some(diagnostic => diagnostic.code === 'MISSING_PLURAL_CATEGORY')).toBe(true);
    const starts = analysis.diagnostics.map(diagnostic => diagnostic.start);
    expect([...starts].sort((a, b) => a - b)).toEqual(starts);
  });

  it('is ok for a faithful translation', () => {
    // Japanese only uses "other", so a single-branch plural is fully covered.
    const analysis = analyzeMessage('{count, plural, other {# アイテム}}', {
      locale: 'ja',
      sourceMessage: '{count, plural, other {# items}}',
    });
    expect(analysis.ok).toBe(true);
    expect(analysis.diagnostics).toEqual([]);
  });
});
