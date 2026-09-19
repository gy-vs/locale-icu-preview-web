import {useEffect, useMemo, useState} from 'react';
import {Languages, Save} from 'lucide-react';

type Message = {key: string; value: string | number | boolean | null; source: string; revision: number};

export default function App() {
  const [locale, setLocale] = useState('fr-FR');
  const [items, setItems] = useState<Message[]>([]);
  const [selected, setSelected] = useState('welcome');
  const [draft, setDraft] = useState('');
  const [status, setStatus] = useState('Ready');
  const active = useMemo(() => items.find(item => item.key === selected), [items, selected]);

  useEffect(() => { fetch('/api/messages?locale=' + locale).then(r => r.json()).then((rows: Message[]) => { setItems(rows); const item = rows.find(row => row.key === selected); setDraft(String(item?.value ?? '')); }); }, [locale]);
  useEffect(() => { if (active) setDraft(String(active.value ?? '')); }, [active?.key]);
  useEffect(() => {
    if (!active || draft === String(active.value ?? '')) return;
    setStatus('Saving');
    const timer = window.setTimeout(() => {
      fetch('/api/messages/' + active.key, {method: 'PUT', headers: {'content-type': 'application/json'}, body: JSON.stringify({locale, value: draft, revision: active.revision})})
        .then(r => r.json()).then(saved => { setItems(rows => rows.map(row => row.key === saved.key ? {...row, ...saved} : row)); setDraft(String(saved.value)); setStatus('Saved'); });
    }, 180);
    return () => window.clearTimeout(timer);
  }, [draft, active?.key, locale]);

  return <main className="shell">
    <header className="topbar"><Languages size={20}/><span className="brand">Locale Workbench</span><small>Message editor</small></header>
    <section className="workspace">
      <aside className="pane"><div className="toolbar"><select value={locale} onChange={event => setLocale(event.target.value)}><option>fr-FR</option><option>en</option></select></div><div className="list">{items.map(item => <button className={selected === item.key ? 'active' : ''} key={item.key} onClick={() => setSelected(item.key)}>{item.key}<br/><small>from {item.source}</small></button>)}</div></aside>
      <section className="pane"><div className="toolbar"><button className="primary"><Save size={15}/> Autosave</button><span className="status">{status}</span></div><textarea aria-label="Translation" value={draft} onChange={event => setDraft(event.target.value)}/></section>
      <section className="pane"><h2>Preview</h2><span className="pill">{locale}</span><p>{draft.replace('{name}', 'Ari').replace('{count}', '3')}</p><h3>Revision</h3><pre>{JSON.stringify(active, null, 2)}</pre></section>
    </section>
  </main>;
}
