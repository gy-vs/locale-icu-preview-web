import express from 'express';
import {fileURLToPath} from 'node:url';

type Values = Record<string, string | number | boolean | null>;
const translations: Record<string, Values> = {
  en: {welcome: 'Welcome, {name}', optional: 'Optional note', count: '{count} items'},
  'fr-FR': {welcome: 'Bienvenue, {name}', optional: '', count: '{count} elements'},
};
const revisions: Record<string, number> = {welcome: 3, optional: 2, count: 5};

function resolve(locale: string, key: string) { const own = translations[locale]?.[key]; return {value: own ?? translations.en[key], source: own == null ? 'en' : locale}; }

export function createApp() {
  const app = express();
  app.use(express.json({limit: '512kb'}));
  app.get('/api/bootstrap', (_req, res) => res.json({kind: 'locale', count: Object.keys(translations.en).length}));
  app.get('/api/messages', (req, res) => {
    const locale = String(req.query.locale || 'fr-FR');
    res.json(Object.keys(translations.en).map(key => ({key, revision: revisions[key], ...resolve(locale, key)})));
  });
  app.put('/api/messages/:key', async (req, res) => {
    await new Promise(resolveDelay => setTimeout(resolveDelay, req.body.value?.length % 2 ? 180 : 30));
    const locale = String(req.body.locale || 'fr-FR');
    translations[locale] ??= {};
    translations[locale][req.params.key] = req.body.value;
    revisions[req.params.key] = (revisions[req.params.key] || 0) + 1;
    res.json({key: req.params.key, value: req.body.value, revision: revisions[req.params.key]});
  });
  app.post('/api/preview', (req, res) => {
    const rendered = String(req.body.message || '').replace(/{(w+)}/g, (_all, key) => String(req.body.values?.[key] ?? ('{' + key + '}')));
    res.json({rendered, diagnostics: []});
  });
  return app;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  createApp().listen(4174, '127.0.0.1', () => console.log('server http://127.0.0.1:4174'));
}
