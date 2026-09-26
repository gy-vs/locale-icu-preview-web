import {analyzeMessage, formatMessage, stableStringify} from '../shared/icu/index';
import type {Analysis, ParamSignature, Signature, Values} from '../shared/icu/index';

/** A named set of parameter values the user can preview the draft with. */
export type Scenario = {id: string; name: string; values: Record<string, string>};

export type ScenarioRender = {
  rendered: string;
  missingValues: string[];
  /** True when the draft no longer parses and this is the last valid render. */
  stale: boolean;
};

export type PreviewState = {
  scenarios: Scenario[];
  /** stableStringify of the signature the scenarios were validated against. */
  baseSignature: string | null;
  /** True when the current draft's signature differs from baseSignature. */
  invalid: boolean;
  renders: Record<string, ScenarioRender>;
};

export function createPreviewState(): PreviewState {
  return {scenarios: [], baseSignature: null, invalid: false, renders: {}};
}

let nextId = 1;
export function addScenario(state: PreviewState, name?: string): PreviewState {
  const scenario: Scenario = {
    id: 'sc' + nextId++,
    name: name?.trim() || `Scenario ${state.scenarios.length + 1}`,
    values: {},
  };
  return {...state, scenarios: [...state.scenarios, scenario]};
}

export function removeScenario(state: PreviewState, id: string): PreviewState {
  const renders = {...state.renders};
  delete renders[id];
  return {...state, scenarios: state.scenarios.filter(scenario => scenario.id !== id), renders};
}

export function renameScenario(state: PreviewState, id: string, name: string): PreviewState {
  return {
    ...state,
    scenarios: state.scenarios.map(scenario => (scenario.id === id ? {...scenario, name} : scenario)),
  };
}

/**
 * Record a parameter value. Values are kept verbatim (keyed by parameter
 * name) even when the signature changes, so nothing the user typed is lost.
 */
export function setScenarioValue(state: PreviewState, id: string, param: string, value: string): PreviewState {
  return {
    ...state,
    scenarios: state.scenarios.map(scenario =>
      scenario.id === id ? {...scenario, values: {...scenario.values, [param]: value}} : scenario,
    ),
  };
}

/**
 * Fold a fresh draft analysis into the preview state.
 *
 * - Parse OK: every scenario is re-rendered for the locale; a signature
 *   different from the baseline marks the state invalid (values are kept).
 * - Parse failed: existing renders are kept and flagged stale.
 */
export function applyAnalysis(state: PreviewState, analysis: Analysis, locale: string): PreviewState {
  if (!analysis.ok) {
    const renders = Object.fromEntries(
      Object.entries(state.renders).map(([id, render]) => [id, {...render, stale: true}]),
    );
    return {...state, renders};
  }

  const signatureKey = stableStringify(analysis.signature);
  const invalid = state.baseSignature != null && state.baseSignature !== signatureKey;
  const renders: Record<string, ScenarioRender> = {};
  for (const scenario of state.scenarios) {
    const coerced = coerceValues(analysis.signature, scenario.values);
    const result = formatMessage(analysis.nodes, coerced, locale);
    renders[scenario.id] = {rendered: result.rendered, missingValues: result.missingValues, stale: false};
  }
  return {
    ...state,
    baseSignature: state.baseSignature ?? signatureKey,
    invalid,
    renders,
  };
}

/**
 * Reconcile with the authoritative server result after a save. The server's
 * re-parse wins: if it disagrees with the scenario baseline the state becomes
 * invalid (again without touching user values).
 */
export function applySaveResult(state: PreviewState, saved: {signature: Signature | null}): PreviewState {
  const serverKey = stableStringify(saved.signature);
  return {
    ...state,
    invalid: state.baseSignature != null && state.baseSignature !== serverKey,
  };
}

/** Accept the current signature as the new baseline, keeping all values. */
export function rebaseSignature(state: PreviewState, signature: Signature): PreviewState {
  return {...state, baseSignature: stableStringify(signature), invalid: false};
}

/** Convert raw string inputs into typed values according to the signature. */
export function coerceValues(signature: Signature, raw: Record<string, string>): Values {
  const flat = flattenSignature(signature);
  const values: Values = {};
  for (const [name, text] of Object.entries(raw)) {
    if (text === '') continue;
    const kind = flat[name]?.kind;
    switch (kind) {
      case 'number':
      case 'plural': {
        const num = Number(text);
        if (Number.isFinite(num)) values[name] = num;
        break;
      }
      case 'date':
        values[name] = text;
        break;
      case 'time':
        values[name] = `2000-01-01T${text}`;
        break;
      default:
        values[name] = text;
    }
  }
  return values;
}

/** Flatten nested parameter signatures so every referenced parameter appears once. */
export function flattenSignature(signature: Signature): Record<string, ParamSignature> {
  const flat: Record<string, ParamSignature> = {};
  const visit = (params: Record<string, ParamSignature>) => {
    for (const [name, sig] of Object.entries(params)) {
      flat[name] ??= sig;
      if (sig.kind === 'plural' || sig.kind === 'select') visit(sig.nested);
    }
  };
  visit(signature.params);
  return flat;
}
