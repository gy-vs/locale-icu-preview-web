import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {AlertTriangle, CheckCircle2, Clock, Languages, Plus, Save, Trash2, XCircle} from 'lucide-react';
import {analyzeMessage} from '../shared/icu/index';
import type {Diagnostic, ParamSignature, Signature} from '../shared/icu/index';
import {
  addScenario,
  applyAnalysis,
  applySaveResult,
  createPreviewState,
  flattenSignature,
  rebaseSignature,
  removeScenario,
  renameScenario,
  setScenarioValue,
} from './previewState';
import type {PreviewState} from './previewState';

type MessageRow = {
  key: string;
  value: string;
  source: string;
  revision: number;
  signature: Signature | null;
  diagnostics: Diagnostic[];
  sourceSignature: Signature | null;
  sourceRevision: number;
};

type LocaleInfo = {locale: string; source: boolean; pluralCategories: string[]};

export default function App() {
  const [locale, setLocale] = useState('fr-FR');
  const [locales, setLocales] = useState<LocaleInfo[]>([]);
  const [items, setItems] = useState<MessageRow[]>([]);
  const [enItems, setEnItems] = useState<MessageRow[]>([]);
  const [selected, setSelected] = useState('welcome');
  const [draft, setDraft] = useState('');
  const [status, setStatus] = useState('Ready');
  const [previewStates, setPreviewStates] = useState<Record<string, PreviewState>>({});
  const editorRef = useRef<HTMLTextAreaElement>(null);
  /** True only when the draft was typed for the current locale/key (guards autosave against locale switches). */
  const dirtyRef = useRef(false);

  const active = useMemo(() => items.find(item => item.key === selected), [items, selected]);
  const sourceMessage = useMemo(
    () => enItems.find(item => item.key === selected)?.value,
    [enItems, selected],
  );

  // Live, local analysis of the draft — this powers instant preview.
  const analysis = useMemo(
    () => analyzeMessage(draft, {locale, sourceMessage: locale === 'en' ? undefined : sourceMessage}),
    [draft, locale, sourceMessage],
  );
  const analysisRef = useRef(analysis);
  analysisRef.current = analysis;

  const preview = previewStates[selected] ?? createPreviewState();
  const setPreviewFor = useCallback((key: string, fn: (state: PreviewState) => PreviewState) => {
    setPreviewStates(prev => ({...prev, [key]: fn(prev[key] ?? createPreviewState())}));
  }, []);
  /** Apply a scenario mutation, then re-render previews from the latest analysis. */
  const updatePreview = useCallback(
    (fn: (state: PreviewState) => PreviewState) => {
      setPreviewFor(selected, state => applyAnalysis(fn(state), analysisRef.current, locale));
    },
    [selected, locale, setPreviewFor],
  );

  useEffect(() => {
    fetch('/api/locales').then(r => r.json()).then(setLocales);
    fetch('/api/messages?locale=en').then(r => r.json()).then(setEnItems);
  }, []);

  useEffect(() => {
    fetch('/api/messages?locale=' + locale).then(r => r.json()).then((rows: MessageRow[]) => {
      setItems(rows);
      const item = rows.find(row => row.key === selected);
      dirtyRef.current = false;
      setDraft(String(item?.value ?? ''));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locale]);

  useEffect(() => {
    if (active) {
      dirtyRef.current = false;
      setDraft(String(active.value ?? ''));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.key]);

  // Re-render previews whenever the live analysis (or locale) changes.
  useEffect(() => {
    setPreviewFor(selected, state => applyAnalysis(state, analysis, locale));
  }, [analysis, locale, selected, setPreviewFor]);

  // Autosave with the scenario baseline signature so the server can detect drift.
  useEffect(() => {
    if (!active || !dirtyRef.current || draft === String(active.value ?? '')) return;
    setStatus('Saving…');
    const timer = window.setTimeout(() => {
      const baseSignature = (previewStates[selected] ?? createPreviewState()).baseSignature;
      fetch('/api/messages/' + active.key, {
        method: 'PUT',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({locale, value: draft, revision: active.revision, baseSignature}),
      })
        .then(async response => {
          if (response.status === 409) {
            const conflict = await response.json();
            setItems(rows => rows.map(row => (row.key === active.key ? {...row, ...conflict.current} : row)));
            setStatus('Conflict: the server has a newer revision (your draft was kept)');
            return;
          }
          const saved: MessageRow & {signatureChanged: boolean} = await response.json();
          setItems(rows => rows.map(row => (row.key === saved.key ? {...row, ...saved} : row)));
          if (locale === 'en') {
            setEnItems(rows => rows.map(row => (row.key === saved.key ? {...row, ...saved} : row)));
          }
          setPreviewFor(selected, state => applySaveResult(state, saved));
          setStatus(saved.signatureChanged ? 'Saved — server re-parse produced a different signature' : 'Saved');
        })
        .catch(() => setStatus('Save failed'));
    }, 250);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, active?.key, locale]);

  const revealRange = (diagnostic: Diagnostic) => {
    const textarea = editorRef.current;
    if (!textarea) return;
    textarea.focus();
    textarea.setSelectionRange(diagnostic.start, diagnostic.end);
  };

  const flatParams = useMemo(() => flattenSignature(analysis.signature), [analysis]);

  return (
    <main className="shell">
      <header className="topbar">
        <Languages size={20}/>
        <span className="brand">Locale Workbench</span>
        <small>ICU message editor</small>
      </header>
      <section className="workspace">
        <aside className="pane">
          <div className="toolbar">
            <select value={locale} onChange={event => setLocale(event.target.value)} aria-label="Locale">
              {locales.map(info => (
                <option key={info.locale} value={info.locale}>
                  {info.locale}{info.source ? ' (source)' : ''}
                </option>
              ))}
            </select>
          </div>
          <div className="list">
            {items.map(item => {
              const errors = item.diagnostics.filter(d => d.severity === 'error').length;
              const warnings = item.diagnostics.filter(d => d.severity === 'warning').length;
              return (
                <button
                  className={selected === item.key ? 'active' : ''}
                  key={item.key}
                  onClick={() => setSelected(item.key)}
                >
                  {item.key}
                  <br/>
                  <small>from {item.source} · rev {item.revision}</small>
                  {errors > 0 && <span className="badge error">{errors} err</span>}
                  {errors === 0 && warnings > 0 && <span className="badge warning">{warnings} warn</span>}
                </button>
              );
            })}
          </div>
        </aside>

        <section className="pane">
          <div className="toolbar">
            <button className="primary"><Save size={15}/> Autosave</button>
            <span className="status">{status}</span>
          </div>
          <textarea
            ref={editorRef}
            aria-label="Translation"
            value={draft}
            onChange={event => {
              dirtyRef.current = true;
              setDraft(event.target.value);
            }}
            spellCheck={false}
          />
          <h2>Diagnostics</h2>
          {analysis.diagnostics.length === 0 && (
            <p className="ok-line"><CheckCircle2 size={15}/> No issues — signature matches the source.</p>
          )}
          <ul className="diagnostics">
            {analysis.diagnostics.map((diagnostic, index) => (
              <li key={index}>
                <button className={`diagnostic ${diagnostic.severity}`} onClick={() => revealRange(diagnostic)}>
                  {diagnostic.severity === 'error' ? <XCircle size={14}/> : <AlertTriangle size={14}/>}
                  <span>{diagnostic.message}</span>
                  <code>[{diagnostic.start}, {diagnostic.end})</code>
                </button>
              </li>
            ))}
          </ul>
          <h3>Parameter signature</h3>
          <pre className="signature">{JSON.stringify(analysis.signature.params, null, 2)}</pre>
        </section>

        <section className="pane">
          <h2>Preview</h2>
          <p>
            <span className="pill">{locale}</span>{' '}
            <span className="pill muted">
              plural: {locales.find(info => info.locale === locale)?.pluralCategories.join(', ') || '…'}
            </span>
          </p>

          {preview.invalid && (
            <div className="invalid-banner" role="alert">
              <AlertTriangle size={15}/>
              <span>Parameter signature changed — existing scenarios are invalidated, their values are kept.</span>
              <button onClick={() => updatePreview(state => rebaseSignature(state, analysis.signature))}>
                Rebase scenarios
              </button>
            </div>
          )}

          {!analysis.ok && (
            <p className="stale-note"><Clock size={14}/> The draft does not parse — showing the last valid preview, marked stale.</p>
          )}

          <div className="toolbar">
            <button onClick={() => updatePreview(state => addScenario(state))}><Plus size={14}/> Add scenario</button>
          </div>

          {preview.scenarios.length === 0 && <p className="muted-text">No scenarios yet — add one to preview parameter values.</p>}

          {preview.scenarios.map(scenario => {
            const render = preview.renders[scenario.id];
            return (
              <div className="scenario" key={scenario.id}>
                <div className="scenario-head">
                  <input
                    className="scenario-name"
                    value={scenario.name}
                    aria-label="Scenario name"
                    onChange={event => updatePreview(state => renameScenario(state, scenario.id, event.target.value))}
                  />
                  <button
                    className="icon"
                    aria-label="Delete scenario"
                    onClick={() => updatePreview(state => removeScenario(state, scenario.id))}
                  >
                    <Trash2 size={14}/>
                  </button>
                </div>

                <div className="param-grid">
                  {Object.entries(flatParams).map(([name, sig]) => (
                    <ParamInput
                      key={name}
                      name={name}
                      sig={sig}
                      value={scenario.values[name] ?? ''}
                      onChange={value => updatePreview(state => setScenarioValue(state, scenario.id, name, value))}
                    />
                  ))}
                  {Object.keys(flatParams).length === 0 && <small className="muted-text">This message has no parameters.</small>}
                </div>

                {render && (
                  <p className={render.stale ? 'render stale' : 'render'}>
                    {render.stale && <span className="badge warning">stale</span>}
                    {render.rendered}
                  </p>
                )}
                {render && render.missingValues.length > 0 && (
                  <small className="muted-text">missing values: {render.missingValues.join(', ')}</small>
                )}
              </div>
            );
          })}

          <h3>Saved revision</h3>
          <pre>{JSON.stringify(active ? {key: active.key, revision: active.revision, source: active.source} : null, null, 2)}</pre>
        </section>
      </section>
    </main>
  );
}

function ParamInput({
  name,
  sig,
  value,
  onChange,
}: {
  name: string;
  sig: ParamSignature;
  value: string;
  onChange: (value: string) => void;
}) {
  const label = (
    <label>
      {name} <small>{sig.kind}{sig.kind === 'plural' && sig.ordinal ? ' (ordinal)' : ''}</small>
    </label>
  );
  switch (sig.kind) {
    case 'number':
    case 'plural':
      return (
        <div className="param">
          {label}
          <input type="number" value={value} onChange={event => onChange(event.target.value)}/>
        </div>
      );
    case 'date':
      return (
        <div className="param">
          {label}
          <input type="date" value={value} onChange={event => onChange(event.target.value)}/>
        </div>
      );
    case 'time':
      return (
        <div className="param">
          {label}
          <input type="time" value={value} onChange={event => onChange(event.target.value)}/>
        </div>
      );
    case 'select':
      return (
        <div className="param">
          {label}
          <select value={value} onChange={event => onChange(event.target.value)}>
            <option value="">—</option>
            {sig.options.map(option => (
              <option key={option} value={option}>{option}</option>
            ))}
          </select>
        </div>
      );
    default:
      return (
        <div className="param">
          {label}
          <input type="text" value={value} onChange={event => onChange(event.target.value)}/>
        </div>
      );
  }
}
