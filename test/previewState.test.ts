import {describe, expect, it} from 'vitest';
import {analyzeMessage} from '../src/shared/icu/index';
import {
  addScenario,
  applyAnalysis,
  applySaveResult,
  coerceValues,
  createPreviewState,
  flattenSignature,
  rebaseSignature,
  removeScenario,
  setScenarioValue,
} from '../src/client/previewState';
import type {PreviewState} from '../src/client/previewState';

const PLURAL = '{count, plural, =0 {no items} one {# item} other {# items}}';

function analyzed(message: string, locale = 'en') {
  return analyzeMessage(message, {locale});
}

function withScenario(state: PreviewState, values: Record<string, string> = {}): [PreviewState, string] {
  let next = addScenario(state, 'main');
  const id = next.scenarios[next.scenarios.length - 1].id;
  for (const [param, value] of Object.entries(values)) {
    next = setScenarioValue(next, id, param, value);
  }
  return [next, id];
}

describe('preview scenarios', () => {
  it('renders each scenario with the plural rules of the selected locale', () => {
    let [state, id] = withScenario(createPreviewState(), {count: '0'});
    state = applyAnalysis(state, analyzed(PLURAL, 'fr-FR'), 'fr-FR');
    // French treats 0 as "one" — but the exact =0 branch wins.
    expect(state.renders[id].rendered).toBe('no items');

    state = setScenarioValue(state, id, 'count', '2');
    state = applyAnalysis(state, analyzed(PLURAL, 'fr-FR'), 'fr-FR');
    expect(state.renders[id].rendered).toBe('2 items');

    // Same draft, same values, different locale: Russian needs more branches,
    // falls back to "other", and formats the number with its own rules.
    const ru = '{count, plural, one {# штука} few {# штуки} many {# штук} other {# штуки}}';
    state = applyAnalysis(state, analyzed(ru, 'ru'), 'ru');
    expect(state.renders[id].rendered).toBe('2 штуки');
  });

  it('keeps the last valid render and marks it stale when parsing fails', () => {
    let [state, id] = withScenario(createPreviewState(), {count: '3'});
    state = applyAnalysis(state, analyzed(PLURAL), 'en');
    expect(state.renders[id]).toMatchObject({rendered: '3 items', stale: false});

    // User types an unclosed brace — the draft no longer parses.
    const broken = analyzeMessage('{count, plural, one {# item}', {locale: 'en'});
    expect(broken.ok).toBe(false);
    state = applyAnalysis(state, broken, 'en');
    expect(state.renders[id]).toMatchObject({rendered: '3 items', stale: true});

    // Recovering clears the stale flag and renders the new draft.
    state = applyAnalysis(state, analyzed('{count, plural, one {# thing} other {# things}}'), 'en');
    expect(state.renders[id]).toMatchObject({rendered: '3 things', stale: false});
  });

  it('invalidates scenarios on signature change without deleting values', () => {
    let [state, id] = withScenario(createPreviewState(), {count: '5', name: 'Ari'});
    state = applyAnalysis(state, analyzed(PLURAL), 'en');
    expect(state.invalid).toBe(false);

    // Draft changes: plural replaced by two plain arguments.
    state = applyAnalysis(state, analyzed('{name} has {count} items'), 'en');
    expect(state.invalid).toBe(true);
    // Values are untouched even though the signature changed.
    const scenario = state.scenarios.find(s => s.id === id)!;
    expect(scenario.values).toEqual({count: '5', name: 'Ari'});
    // Rendering still works with the coerced values that still apply.
    expect(state.renders[id].rendered).toBe('Ari has 5 items');
  });

  it('rebase accepts the new signature and keeps every entered value', () => {
    let [state, id] = withScenario(createPreviewState(), {count: '5', name: 'Ari'});
    state = applyAnalysis(state, analyzed(PLURAL), 'en');
    const next = analyzed('{name} has {count} items');
    state = applyAnalysis(state, next, 'en');
    expect(state.invalid).toBe(true);

    state = rebaseSignature(state, next.signature);
    expect(state.invalid).toBe(false);
    expect(state.scenarios.find(s => s.id === id)!.values).toEqual({count: '5', name: 'Ari'});

    // A signature identical to the baseline is not invalid anymore.
    state = applyAnalysis(state, analyzed('{name} has {count} items'), 'en');
    expect(state.invalid).toBe(false);
  });

  it('applySaveResult marks the state invalid when the server re-parse disagrees', () => {
    let [state] = withScenario(createPreviewState(), {count: '5'});
    state = applyAnalysis(state, analyzed(PLURAL), 'en');
    expect(state.invalid).toBe(false);

    // Server stored a different signature than the scenario baseline.
    const serverSignature = analyzed('{count} items').signature;
    state = applySaveResult(state, {signature: serverSignature});
    expect(state.invalid).toBe(true);

    state = rebaseSignature(state, serverSignature);
    state = applySaveResult(state, {signature: serverSignature});
    expect(state.invalid).toBe(false);
  });

  it('removes scenarios together with their renders', () => {
    let [state, id] = withScenario(createPreviewState(), {count: '1'});
    state = applyAnalysis(state, analyzed(PLURAL), 'en');
    expect(state.renders[id]).toBeDefined();
    state = removeScenario(state, id);
    expect(state.scenarios).toHaveLength(0);
    expect(state.renders[id]).toBeUndefined();
  });
});

describe('value coercion and signature flattening', () => {
  it('coerces raw strings according to parameter kinds', () => {
    const signature = analyzed(
      '{n, plural, other {#}} {v, number} {d, date} {t, time} {s} {g, select, other {x}}',
    ).signature;
    const values = coerceValues(signature, {n: '3', v: '2.5', d: '2026-09-26', t: '09:30', s: 'hi', g: 'female'});
    expect(values).toEqual({
      n: 3,
      v: 2.5,
      d: '2026-09-26',
      t: '2000-01-01T09:30',
      s: 'hi',
      g: 'female',
    });
  });

  it('skips empty and non-numeric inputs', () => {
    const signature = analyzed('{n, plural, other {#}}').signature;
    expect(coerceValues(signature, {n: ''})).toEqual({});
    expect(coerceValues(signature, {n: 'abc'})).toEqual({});
  });

  it('flattens nested parameters so every input is reachable', () => {
    const signature = analyzed(
      '{g, select, female {{host} has {n, plural, one {# cat} other {# cats}}} other {none}}',
    ).signature;
    const flat = flattenSignature(signature);
    expect(Object.keys(flat).sort()).toEqual(['g', 'host', 'n']);
    expect(flat.n.kind).toBe('plural');
    expect(flat.host.kind).toBe('string');
  });
});
