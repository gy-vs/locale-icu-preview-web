import express from 'express';
import {fileURLToPath} from 'node:url';
import {
  compareSignatures,
  extractSignature,
  formatMessage,
  hashSignature,
  parseIcu,
  type Diagnostic,
  type MessageSignature,
  type Values,
} from '../shared/icu';

const LOCALES = ['en', 'fr-FR', 'ru', 'ar'] as const;

const translations: Record<string, Record<string, string>> = {
  en: {
    welcome: 'Welcome, {name}!',
    cart: '{count, plural, =0 {Your cart is empty} one {# item in your cart} other {# items in your cart}}',
    photos:
      '{gender, select, female {{count, plural, one {She shared # photo} other {She shared # photos}}} ' +
      'male {{count, plural, one {He shared # photo} other {He shared # photos}}} ' +
      'other {{count, plural, one {They shared # photo} other {They shared # photos}}}}',
    invoice: 'Total {total, number, ::currency/USD} due {due, date, long}.',
    meeting: '{host} starts in {minutes, plural, one {# minute} other {# minutes}} at {start, time, short}.',
    quote: "It''s {percent, number, percent} ready — see ''{section}''.",
  },
  'fr-FR': {
    welcome: 'Bienvenue, {name} !',
    cart: '{count, plural, =0 {Votre panier est vide} one {# article dans le panier} many {# articles dans le panier} other {# articles dans le panier}}',
    // Intentionally drops {count}: demonstrates missing-argument diagnostics.
    photos:
      '{gender, select, female {Elle a partagé des photos} male {Il a partagé des photos} other {Iels ont partagé des photos}}',
    invoice: 'Total {total, number, ::currency/EUR} à payer le {due, date, long}.',
    meeting: '{host} commence dans {minutes, plural, one {# minute} many {# minutes} other {# minutes}} à {start, time, short}.',
    quote: "C''est prêt à {percent, number, percent} — voir ''{section}''.",
  },
  ru: {},
  ar: {},
};

const revisions: Record<string, number> = {welcome: 3, cart: 5, photos: 2, invoice: 4, meeting: 1, quote: 1};

interface Analysis {
  parseOk: boolean;
  signature: MessageSignature | null;
  hash: string | null;
  diagnostics: Diagnostic[];
}

function analyze(message: string, locale: string, reference: MessageSignature | null): Analysis {
  const parsed = parseIcu(message);
  if (!parsed.ok) {
    return {parseOk: false, signature: null, hash: null, diagnostics: [parsed.error]};
  }
  const signature = extractSignature(parsed.ast);
  return {
    parseOk: true,
    signature,
    hash: hashSignature(signature),
    diagnostics: compareSignatures(reference, signature, {locale}),
  };
}

/** Source (en) signatures, cached per key and invalidated when en is edited. */
const referenceCache = new Map<string, {signature: MessageSignature | null; hash: string | null}>();

function referenceFor(key: string) {
  let cached = referenceCache.get(key);
  if (!cached) {
    const parsed = parseIcu(translations.en[key]);
    const signature = parsed.ok ? extractSignature(parsed.ast) : null;
    cached = {signature, hash: signature ? hashSignature(signature) : null};
    referenceCache.set(key, cached);
  }
  return cached;
}

function resolve(locale: string, key: string) {
  const own = translations[locale]?.[key];
  return {value: own ?? translations.en[key], source: own == null ? 'en' : locale};
}

function rowFor(locale: string, key: string) {
  const reference = referenceFor(key);
  const {value, source} = resolve(locale, key);
  const analysis = analyze(value, locale, reference.signature);
  return {
    key,
    revision: revisions[key] ?? 0,
    value,
    source,
    sourceValue: translations.en[key],
    parseOk: analysis.parseOk,
    signature: analysis.signature,
    diagnostics: analysis.diagnostics,
    referenceSignature: reference.signature,
    referenceHash: reference.hash,
  };
}

export function createApp() {
  const app = express();
  app.use(express.json({limit: '512kb'}));

  app.get('/api/bootstrap', (_req, res) =>
    res.json({kind: 'locale', count: Object.keys(translations.en).length, locales: LOCALES}),
  );

  app.get('/api/messages', (req, res) => {
    const locale = String(req.query.locale || 'fr-FR');
    res.json(Object.keys(translations.en).map(key => rowFor(locale, key)));
  });

  app.put('/api/messages/:key', async (req, res) => {
    await new Promise(resolveDelay => setTimeout(resolveDelay, String(req.body.value ?? '').length % 2 ? 180 : 30));
    const key = req.params.key;
    if (!(key in translations.en)) {
      res.status(404).json({error: 'unknown-key', key});
      return;
    }
    const locale = String(req.body.locale || 'fr-FR');
    const clientRevision = req.body.revision;
    if (typeof clientRevision === 'number' && clientRevision !== (revisions[key] ?? 0)) {
      res.status(409).json({error: 'revision-conflict', key, revision: revisions[key] ?? 0});
      return;
    }
    const value = String(req.body.value ?? '');
    translations[locale] ??= {};
    translations[locale][key] = value;
    revisions[key] = (revisions[key] ?? 0) + 1;
    if (locale === 'en') referenceCache.delete(key);

    // Authoritative re-parse of what was actually stored.
    const reference = referenceFor(key);
    const analysis = analyze(value, locale, reference.signature);
    const expectedSignature = req.body.expectedSignature;
    res.json({
      key,
      value,
      revision: revisions[key],
      source: locale,
      parseOk: analysis.parseOk,
      signature: analysis.signature,
      hash: analysis.hash,
      diagnostics: analysis.diagnostics,
      referenceSignature: reference.signature,
      referenceHash: reference.hash,
      signatureChanged: expectedSignature != null && expectedSignature !== analysis.hash,
    });
  });

  app.post('/api/preview', (req, res) => {
    const message = String(req.body.message ?? '');
    const locale = String(req.body.locale || 'en');
    const values = (req.body.values ?? {}) as Values;
    const parsed = parseIcu(message);
    if (!parsed.ok) {
      res.json({parseOk: false, rendered: null, diagnostics: [parsed.error], signature: null, hash: null});
      return;
    }
    const signature = extractSignature(parsed.ast);
    const reference = req.body.referenceSignature as MessageSignature | null | undefined;
    res.json({
      parseOk: true,
      rendered: formatMessage(parsed.ast, values, locale),
      diagnostics: reference ? compareSignatures(reference, signature, {locale}) : [],
      signature,
      hash: hashSignature(signature),
    });
  });

  return app;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  createApp().listen(4174, '127.0.0.1', () => console.log('server http://127.0.0.1:4174'));
}
