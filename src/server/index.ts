import express from 'express';
import {fileURLToPath} from 'node:url';
import {analyzeMessage, formatMessage, stableStringify} from '../shared/icu/index';
import type {Diagnostic, Signature, Values} from '../shared/icu/index';

const SOURCE_LOCALE = 'en';
const LOCALES = [SOURCE_LOCALE, 'fr-FR', 'ru', 'ar', 'ja'];

type StoredMessage = {
  value: string;
  revision: number;
  /** Structured parameter signature captured when the message was saved. */
  signature: Signature | null;
  /** Diagnostics against the source-language message, captured at save time. */
  diagnostics: Diagnostic[];
};

type Store = Record<string, Record<string, StoredMessage>>;

const SEED: Record<string, Record<string, {value: string; revision: number}>> = {
  en: {
    welcome: {value: 'Welcome, {name}!', revision: 3},
    cart: {value: '{count, plural, =0 {Your cart is empty} one {# item in your cart} other {# items in your cart}}', revision: 5},
    invite: {
      value:
        '{gender, select, female {{host} invited you and {count, plural, offset:1 =0 {nobody else} one {# other person} other {# other people}} to her party} ' +
        'male {{host} invited you and {count, plural, offset:1 =0 {nobody else} one {# other person} other {# other people}} to his party} ' +
        'other {{host} invited you and {count, plural, offset:1 =0 {nobody else} one {# other person} other {# other people}} to their party}}',
      revision: 2,
    },
    meeting: {value: 'Meeting on {day, date, medium} at {hour, time, short}', revision: 1},
    quota: {value: "You''ve used {used, number, percent} of your quota", revision: 4},
  },
  'fr-FR': {
    welcome: {value: 'Bienvenue, {name} !', revision: 2},
    cart: {value: '{count, plural, =0 {Votre panier est vide} one {# article} other {# articles}}', revision: 1},
  },
};

function buildStore(): Store {
  const store: Store = {};
  for (const [locale, messages] of Object.entries(SEED)) {
    store[locale] = {};
    for (const [key, seed] of Object.entries(messages)) {
      store[locale][key] = {
        value: seed.value,
        revision: seed.revision,
        signature: null,
        diagnostics: [],
      };
    }
  }
  // Parse every seed message once so signatures/diagnostics are stored.
  for (const locale of Object.keys(store)) {
    for (const key of Object.keys(store[locale])) {
      reanalyze(store, locale, key);
    }
  }
  return store;
}

/** Re-parse a stored message and refresh its signature + diagnostics. */
function reanalyze(store: Store, locale: string, key: string) {
  const entry = store[locale]?.[key];
  if (!entry) return;
  const sourceValue = store[SOURCE_LOCALE]?.[key]?.value;
  const analysis = analyzeMessage(entry.value, {
    locale,
    sourceMessage: locale === SOURCE_LOCALE ? undefined : sourceValue,
  });
  entry.signature = analysis.signature;
  entry.diagnostics = analysis.diagnostics;
}

function resolve(store: Store, locale: string, key: string) {
  const own = store[locale]?.[key];
  if (own) return {entry: own, source: locale};
  return {entry: store[SOURCE_LOCALE][key], source: SOURCE_LOCALE};
}

function toRow(store: Store, locale: string, key: string) {
  const {entry, source} = resolve(store, locale, key);
  const sourceEntry = store[SOURCE_LOCALE][key];
  return {
    key,
    value: entry.value,
    source,
    revision: source === locale ? entry.revision : 0,
    signature: entry.signature,
    diagnostics: entry.diagnostics,
    sourceSignature: sourceEntry?.signature ?? null,
    sourceRevision: sourceEntry?.revision ?? 0,
  };
}

export function createApp() {
  const store = buildStore();
  const app = express();
  app.use(express.json({limit: '512kb'}));

  app.get('/api/bootstrap', (_req, res) => {
    res.json({kind: 'locale', count: Object.keys(store[SOURCE_LOCALE]).length});
  });

  app.get('/api/locales', (_req, res) => {
    res.json(
      LOCALES.map(locale => ({
        locale,
        source: locale === SOURCE_LOCALE,
        pluralCategories: new Intl.PluralRules(locale).resolvedOptions().pluralCategories,
      })),
    );
  });

  app.get('/api/messages', (req, res) => {
    const locale = String(req.query.locale || SOURCE_LOCALE);
    res.json(Object.keys(store[SOURCE_LOCALE]).map(key => toRow(store, locale, key)));
  });

  app.put('/api/messages/:key', (req, res) => {
    const key = req.params.key;
    const locale = String(req.body.locale || SOURCE_LOCALE);
    const value = String(req.body.value ?? '');
    if (!store[SOURCE_LOCALE][key]) {
      res.status(404).json({error: 'UNKNOWN_KEY', key});
      return;
    }
    const current = store[locale]?.[key];
    const currentRevision = current?.revision ?? 0;
    if (typeof req.body.revision === 'number' && req.body.revision !== currentRevision) {
      res.status(409).json({error: 'REVISION_CONFLICT', current: toRow(store, locale, key)});
      return;
    }

    store[locale] ??= {};
    store[locale][key] = {value, revision: currentRevision + 1, signature: null, diagnostics: []};
    reanalyze(store, locale, key);
    // A source-language edit changes the baseline: re-check every translation.
    if (locale === SOURCE_LOCALE) {
      for (const otherLocale of Object.keys(store)) {
        if (otherLocale !== SOURCE_LOCALE && store[otherLocale][key]) reanalyze(store, otherLocale, key);
      }
    }

    const saved = store[locale][key];
    const signatureKey = stableStringify(saved.signature);
    const signatureChanged = typeof req.body.baseSignature === 'string' && req.body.baseSignature !== signatureKey;
    res.json({
      ...toRow(store, locale, key),
      signatureChanged,
    });
  });

  app.post('/api/preview', (req, res) => {
    const message = String(req.body.message ?? '');
    const locale = String(req.body.locale || SOURCE_LOCALE);
    const values: Values = req.body.values ?? {};
    const analysis = analyzeMessage(message, {
      locale,
      sourceMessage: typeof req.body.sourceMessage === 'string' ? req.body.sourceMessage : undefined,
    });
    if (!analysis.ok) {
      res.json({ok: false, signature: analysis.signature, diagnostics: analysis.diagnostics});
      return;
    }
    const rendered = formatMessage(analysis.nodes, values, locale);
    res.json({
      ok: true,
      rendered: rendered.rendered,
      missingValues: rendered.missingValues,
      signature: analysis.signature,
      diagnostics: analysis.diagnostics,
    });
  });

  return app;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  createApp().listen(4174, '127.0.0.1', () => console.log('server http://127.0.0.1:4174'));
}
