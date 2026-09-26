import {useEffect, useMemo, useRef, useState} from 'react';
import {AlertTriangle, CheckCircle2, Languages, Plus, Save, X} from 'lucide-react';
import {
  compareSignatures,
  extractSignature,
  formatMessage,
  hashSignature,
  parseIcu,
  pluralCategoryFor,
  sampleValueForArg,
  type ArgSignature,
  type Diagnostic,
  type MessageSignature,
} from '../shared/icu';

interface Row {
  key: string;
  revision: number;
  value: string;
  source: string;
  sourceValue: string;
  parseOk: boolean;
  diagnostics: Diagnostic[];
  referenceSignature: MessageSignature | null;
  referenceHash: string | null;
}

type ScenarioValues = Record<string, string | number | null>;

interface Scenario {
  id: string;
  name: string;
  locale: string;
  values: ScenarioValues;
  /** Signature hash the values were last reviewed against. */
  signatureHash: string | null;
  /** Last successfully rendered preview, kept when the draft stops parsing. */
  lastValid?: {rendered: string; at: number};
}

interface RenderState {
  rendered: string | null;
  /** True when the draft no longer parses and `rendered` is the last valid output. */
  stale: boolean;
  /** True when the message signature changed since the scenario values were reviewed. */
  outdated: boolean;
}

const FALLBACK_LOCALES = ['en', 'fr-FR', 'ru', 'ar'];

function newId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2);
}

function ArgEditor(props: {
  arg: ArgSignature;
  value: string | number | null;
  locale: string;
  onChange: (value: string | number | null) => void;
}) {
  const {arg, value, locale, onChange} = props;
  const types = arg.types;
  let input;
  if (types.includes('select')) {
    input = (
      <select value={value == null ? '' : String(value)} onChange={event => onChange(event.target.value || null)}>
        <option value="">— unset —</option>
        {(arg.select?.options ?? []).map(option => (
          <option key={option} value={option}>{option}</option>
        ))}
      </select>
    );
  } else if (types.includes('plural') || types.includes('number')) {
    input = (
      <input
        type="number"
        step="any"
        value={value == null ? '' : value}
        onChange={event => onChange(event.target.value === '' ? null : Number(event.target.value))}
      />
    );
  } else if (types.includes('date')) {
    input = <input type="date" value={value == null ? '' : String(value)} onChange={event => onChange(event.target.value || null)} />;
  } else if (types.includes('time')) {
    input = <input type="time" value={value == null ? '' : String(value)} onChange={event => onChange(event.target.value || null)} />;
  } else {
    input = <input type="text" value={value == null ? '' : String(value)} onChange={event => onChange(event.target.value || null)} />;
  }
  const category =
    arg.plural && typeof value === 'number' && Number.isFinite(value)
      ? pluralCategoryFor(locale, arg.plural.pluralType, value)
      : null;
  return (
    <label className="arg">
      <span className="arg-name">
        {arg.name} <small>{types.join(' · ')}</small>
      </span>
      <span className="arg-input">
        {input}
        {category && <span className="pill" title={`Plural category in ${locale}`}>→ {category}</span>}
      </span>
    </label>
  );
}

export default function App() {
  const [locale, setLocale] = useState('fr-FR');
  const [locales, setLocales] = useState<string[]>(FALLBACK_LOCALES);
  const [items, setItems] = useState<Row[]>([]);
  const [selected, setSelected] = useState('welcome');
  const [draft, setDraft] = useState('');
  const [status, setStatus] = useState('Ready');
  const [scenariosByKey, setScenariosByKey] = useState<Record<string, Scenario[]>>({});
  const [activeScenarioByKey, setActiveScenarioByKey] = useState<Record<string, string>>({});
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const active = useMemo(() => items.find(item => item.key === selected), [items, selected]);

  // Live, client-side parse of the current draft.
  const parsed = useMemo(() => parseIcu(draft), [draft]);
  const signature = useMemo(() => (parsed.ok ? extractSignature(parsed.ast) : null), [parsed]);
  const signatureHash = useMemo(() => hashSignature(signature), [signature]);
  const diagnostics = useMemo<Diagnostic[]>(() => {
    if (!parsed.ok) return [parsed.error];
    return compareSignatures(active?.referenceSignature ?? null, signature!, {locale});
  }, [parsed, active?.referenceSignature, signature, locale]);

  const scenarios = scenariosByKey[selected] ?? [];
  const activeScenarioId = activeScenarioByKey[selected] ?? scenarios[0]?.id;
  const activeScenario = scenarios.find(scenario => scenario.id === activeScenarioId);

  // Per-scenario render of the *current* draft; falls back to last valid output.
  const renders = useMemo(() => {
    const map = new Map<string, RenderState>();
    for (const scenario of scenarios) {
      let rendered: string | null = null;
      if (parsed.ok) {
        try {
          rendered = formatMessage(parsed.ast, scenario.values, scenario.locale);
        } catch {
          rendered = null;
        }
      }
      const stale = !parsed.ok || rendered == null;
      map.set(scenario.id, {
        rendered: stale ? scenario.lastValid?.rendered ?? null : rendered,
        stale: stale && scenario.lastValid != null,
        outdated: scenario.signatureHash !== signatureHash,
      });
    }
    return map;
  }, [scenarios, parsed, signatureHash]);

  useEffect(() => {
    fetch('/api/bootstrap')
      .then(r => r.json())
      .then((boot: {locales?: string[]}) => {
        if (Array.isArray(boot.locales) && boot.locales.length > 0) setLocales(boot.locales);
      })
      .catch(() => undefined);
  }, []);

  const loadMessages = (targetLocale: string, keepKey: string) =>
    fetch('/api/messages?locale=' + targetLocale)
      .then(r => r.json())
      .then((rows: Row[]) => {
        setItems(rows);
        const row = rows.find(item => item.key === keepKey);
        setDraft(String(row?.value ?? ''));
      });

  useEffect(() => {
    loadMessages(locale, selected);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locale]);

  useEffect(() => {
    if (active) setDraft(String(active.value ?? ''));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.key]);

  // Autosave with server-side re-parse.
  useEffect(() => {
    if (!active || draft === String(active.value ?? '')) return;
    setStatus('Saving…');
    const sentValue = draft;
    const timer = window.setTimeout(() => {
      fetch('/api/messages/' + active.key, {
        method: 'PUT',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({
          locale,
          value: sentValue,
          revision: active.revision,
          expectedSignature: signatureHash,
        }),
      })
        .then(async res => {
          if (res.status === 409) {
            setStatus('Conflict — reloaded latest');
            await loadMessages(locale, selected);
            return;
          }
          return res.json().then(saved => {
            setItems(rows =>
              rows.map(row =>
                row.key === saved.key
                  ? {
                      ...row,
                      value: String(saved.value),
                      revision: saved.revision,
                      source: saved.source,
                      parseOk: saved.parseOk,
                      diagnostics: saved.diagnostics,
                      referenceSignature: saved.referenceSignature,
                      referenceHash: saved.referenceHash,
                    }
                  : row,
              ),
            );
            setDraft(current => (current === sentValue ? String(saved.value) : current));
            setStatus(
              saved.signatureChanged
                ? 'Saved — server re-parse differs, scenarios marked outdated'
                : saved.parseOk
                  ? 'Saved'
                  : 'Saved — message does not parse',
            );
          });
        })
        .catch(() => setStatus('Save failed'));
    }, 250);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, active?.key, locale]);

  // Seed two sample scenarios the first time a parseable message is opened.
  useEffect(() => {
    if (!signature) return;
    const hash = signatureHash;
    setScenariosByKey(previous => {
      if (previous[selected] !== undefined) return previous;
      const make = (name: string, variant: number): Scenario => ({
        id: newId(),
        name,
        locale,
        values: Object.fromEntries(signature.args.map(arg => [arg.name, sampleValueForArg(arg, variant)])),
        signatureHash: hash,
      });
      return {...previous, [selected]: [make('Scenario A', 0), make('Scenario B', 1)]};
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, signatureHash]);

  // Remember the last valid render per scenario so parse failures can show it as stale.
  useEffect(() => {
    if (!parsed.ok) return;
    setScenariosByKey(previous => {
      const list = previous[selected];
      if (!list) return previous;
      let changed = false;
      const next = list.map(scenario => {
        const render = renders.get(scenario.id);
        if (render && !render.stale && render.rendered != null && scenario.lastValid?.rendered !== render.rendered) {
          changed = true;
          return {...scenario, lastValid: {rendered: render.rendered, at: Date.now()}};
        }
        return scenario;
      });
      return changed ? {...previous, [selected]: next} : previous;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [renders]);

  const updateScenario = (id: string, update: (scenario: Scenario) => Scenario) => {
    setScenariosByKey(previous => ({
      ...previous,
      [selected]: (previous[selected] ?? []).map(scenario => (scenario.id === id ? update(scenario) : scenario)),
    }));
  };

  const setScenarioValue = (id: string, name: string, value: string | number | null) => {
    // Editing values re-validates the scenario against the current signature;
    // values for removed arguments are kept, not deleted.
    updateScenario(id, scenario => ({...scenario, values: {...scenario.values, [name]: value}, signatureHash}));
  };

  const reviewScenario = (id: string) => {
    updateScenario(id, scenario => ({...scenario, signatureHash}));
  };

  const addScenario = () => {
    if (!signature) return;
    const variant = scenarios.length;
    const scenario: Scenario = {
      id: newId(),
      name: `Scenario ${String.fromCharCode(65 + (variant % 26))}`,
      locale,
      values: Object.fromEntries(signature.args.map(arg => [arg.name, sampleValueForArg(arg, variant)])),
      signatureHash,
    };
    setScenariosByKey(previous => ({...previous, [selected]: [...(previous[selected] ?? []), scenario]}));
    setActiveScenarioByKey(previous => ({...previous, [selected]: scenario.id}));
  };

  const removeScenario = (id: string) => {
    setScenariosByKey(previous => ({...previous, [selected]: (previous[selected] ?? []).filter(s => s.id !== id)}));
  };

  const jumpTo = (diagnostic: Diagnostic) => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.focus();
    textarea.setSelectionRange(diagnostic.range.start, diagnostic.range.end);
  };

  const orphanedKeys = activeScenario && signature
    ? Object.keys(activeScenario.values).filter(name => !signature.args.some(arg => arg.name === name))
    : [];

  return (
    <main className="shell">
      <header className="topbar">
        <Languages size={20} />
        <span className="brand">Locale Workbench</span>
        <small>ICU message editor</small>
      </header>
      <section className="workspace">
        <aside className="pane">
          <div className="toolbar">
            <select value={locale} onChange={event => setLocale(event.target.value)} aria-label="Editing locale">
              {locales.map(option => (
                <option key={option}>{option}</option>
              ))}
            </select>
          </div>
          <div className="list">
            {items.map(item => {
              const errors = item.diagnostics.filter(d => d.severity === 'error').length;
              const warnings = item.diagnostics.filter(d => d.severity === 'warning').length;
              return (
                <button className={selected === item.key ? 'active' : ''} key={item.key} onClick={() => setSelected(item.key)}>
                  <span className="row">
                    <span>{item.key}</span>
                    {errors > 0 && <span className="badge error" title={`${errors} error(s)`}>{errors}</span>}
                    {warnings > 0 && <span className="badge warn" title={`${warnings} warning(s)`}>{warnings}</span>}
                  </span>
                  <small>from {item.source}</small>
                </button>
              );
            })}
          </div>
        </aside>

        <section className="pane">
          <div className="toolbar">
            <button className="primary" type="button">
              <Save size={15} /> Autosave
            </button>
            <span className="status">{status}</span>
            {active && <span className="pill">rev {active.revision}</span>}
          </div>
          {active && (
            <details className="source">
              <summary>Source (en)</summary>
              <pre>{active.sourceValue}</pre>
            </details>
          )}
          <textarea
            ref={textareaRef}
            aria-label="Translation"
            value={draft}
            onChange={event => setDraft(event.target.value)}
            spellCheck={false}
          />
          <div className="diagnostics">
            <h3>
              Diagnostics{' '}
              {diagnostics.length === 0 ? (
                <span className="ok">
                  <CheckCircle2 size={14} /> clean
                </span>
              ) : (
                <span className="pill">{diagnostics.length}</span>
              )}
            </h3>
            {diagnostics.map((diagnostic, index) => (
              <button
                type="button"
                key={index}
                className={`diag ${diagnostic.severity}`}
                onClick={() => jumpTo(diagnostic)}
                title="Click to select the affected range"
              >
                <AlertTriangle size={13} />
                <span className="diag-message">{diagnostic.message}</span>
                <small>
                  {diagnostic.code} @{diagnostic.range.start}–{diagnostic.range.end}
                </small>
              </button>
            ))}
          </div>
        </section>

        <section className="pane">
          <h2>Preview</h2>
          <div className="tabs">
            {scenarios.map(scenario => {
              const render = renders.get(scenario.id);
              return (
                <button
                  type="button"
                  key={scenario.id}
                  className={`tab ${scenario.id === activeScenarioId ? 'active' : ''}`}
                  onClick={() => setActiveScenarioByKey(previous => ({...previous, [selected]: scenario.id}))}
                >
                  {scenario.name}
                  {render?.stale && <span className="dot stale" title="Showing last valid preview" />}
                  {render?.outdated && <span className="dot outdated" title="Values need review" />}
                </button>
              );
            })}
            <button type="button" className="tab add" onClick={addScenario} disabled={!signature} title="Add scenario">
              <Plus size={14} />
            </button>
          </div>

          {activeScenario && (
            <div className="scenario">
              <div className="toolbar">
                <input
                  className="scenario-name"
                  value={activeScenario.name}
                  onChange={event => updateScenario(activeScenario.id, s => ({...s, name: event.target.value}))}
                  aria-label="Scenario name"
                />
                <select
                  value={activeScenario.locale}
                  onChange={event => updateScenario(activeScenario.id, s => ({...s, locale: event.target.value}))}
                  aria-label="Preview locale"
                >
                  {locales.map(option => (
                    <option key={option}>{option}</option>
                  ))}
                </select>
                <button type="button" onClick={() => removeScenario(activeScenario.id)} title="Delete scenario">
                  <X size={14} />
                </button>
              </div>

              {renders.get(activeScenario.id)?.outdated && (
                <div className="notice warn">
                  <AlertTriangle size={14} /> Arguments changed since these values were entered. Values are kept.
                  <button type="button" onClick={() => reviewScenario(activeScenario.id)}>Mark reviewed</button>
                </div>
              )}

              {signature ? (
                <div className="args">
                  {signature.args.map(arg => (
                    <ArgEditor
                      key={arg.name}
                      arg={arg}
                      locale={activeScenario.locale}
                      value={activeScenario.values[arg.name] ?? null}
                      onChange={value => setScenarioValue(activeScenario.id, arg.name, value)}
                    />
                  ))}
                  {signature.args.length === 0 && <p className="muted">This message has no arguments.</p>}
                  {orphanedKeys.map(name => (
                    <span key={name} className="chip" title="Kept but not used by the current message">
                      {name} (unused, kept)
                    </span>
                  ))}
                </div>
              ) : (
                <p className="muted">Fix the parse error to edit argument values.</p>
              )}

              <div className={`render ${renders.get(activeScenario.id)?.stale ? 'stale' : ''}`}>
                {renders.get(activeScenario.id)?.stale && (
                  <span className="badge stale">stale — last valid preview, draft does not parse</span>
                )}
                <p>{renders.get(activeScenario.id)?.rendered ?? '—'}</p>
              </div>
            </div>
          )}

          {scenarios.length > 1 && (
            <>
              <h3>All scenarios</h3>
              <ul className="renders">
                {scenarios.map(scenario => {
                  const render = renders.get(scenario.id);
                  return (
                    <li key={scenario.id}>
                      <span className="pill">{scenario.locale}</span> <strong>{scenario.name}</strong>{' '}
                      <span className={render?.stale ? 'stale-text' : ''}>
                        {render?.rendered ?? '—'}
                        {render?.stale && ' (stale)'}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </section>
      </section>
    </main>
  );
}
