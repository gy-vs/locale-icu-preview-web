import {describe, expect, it} from 'vitest';
import request from 'supertest';
import {createApp} from '../src/server/index';
import {stableStringify} from '../src/shared/icu/index';

describe('message storage with signatures', () => {
  it('stores a structured signature for every message', async () => {
    const app = createApp();
    const response = await request(app).get('/api/messages?locale=en');
    expect(response.status).toBe(200);
    const cart = response.body.find((row: {key: string}) => row.key === 'cart');
    expect(cart.signature.params.count).toMatchObject({
      kind: 'plural',
      keywords: ['one', 'other'],
      exacts: [0],
    });
    const invite = response.body.find((row: {key: string}) => row.key === 'invite');
    expect(invite.signature.params.gender.kind).toBe('select');
    expect(invite.signature.params.gender.nested.count.kind).toBe('plural');
  });

  it('falls back to the source language and reports it', async () => {
    const app = createApp();
    const response = await request(app).get('/api/messages?locale=ru');
    const meeting = response.body.find((row: {key: string}) => row.key === 'meeting');
    expect(meeting.source).toBe('en');
    expect(meeting.revision).toBe(0);
  });

  it('re-parses on save and stores signature + diagnostics', async () => {
    const app = createApp();
    // French translation drops the "one" branch and the =0 exact branch.
    const value = '{count, plural, other {# articles}}';
    const put = await request(app)
      .put('/api/messages/cart')
      .send({locale: 'fr-FR', value, revision: 1});
    expect(put.status).toBe(200);
    expect(put.body.signature.params.count.keywords).toEqual(['other']);
    const codes = put.body.diagnostics.map((diagnostic: {code: string}) => diagnostic.code);
    expect(codes).toContain('MISSING_PLURAL_CATEGORY');
    expect(codes).toContain('MISSING_EXACT_MATCH');

    // Diagnostics are locatable: the range points at the plural header.
    const missing = put.body.diagnostics.find((diagnostic: {code: string}) => diagnostic.code === 'MISSING_PLURAL_CATEGORY');
    expect(value.slice(missing.start, missing.end)).toBe('{count');

    const get = await request(app).get('/api/messages?locale=fr-FR');
    const cart = get.body.find((row: {key: string}) => row.key === 'cart');
    expect(cart.diagnostics.length).toBeGreaterThan(0);
    expect(cart.revision).toBe(2);
  });

  it('recomputes translation diagnostics when the source message changes', async () => {
    const app = createApp();
    // Start from a valid French translation of the current source.
    await request(app)
      .put('/api/messages/cart')
      .send({locale: 'fr-FR', value: '{count, plural, =0 {vide} one {# article} other {# articles}}', revision: 1});
    // Source gains an exact =1 branch.
    const enCart = (await request(app).get('/api/messages?locale=en')).body.find((row: {key: string}) => row.key === 'cart');
    await request(app)
      .put('/api/messages/cart')
      .send({locale: 'en', value: '{count, plural, =0 {empty} =1 {exactly one} one {# item} other {# items}}', revision: enCart.revision});
    const frCart = (await request(app).get('/api/messages?locale=fr-FR')).body.find((row: {key: string}) => row.key === 'cart');
    const codes = frCart.diagnostics.map((diagnostic: {code: string}) => diagnostic.code);
    expect(codes).toContain('MISSING_EXACT_MATCH');
  });
});

describe('save-time re-parse consistency', () => {
  it('flags signatureChanged when the server re-parse differs from the client baseline', async () => {
    const app = createApp();
    // Client believes the message still has the old plural signature…
    const staleBaseline = stableStringify({
      params: {count: {kind: 'plural', ordinal: false, offset: 0, keywords: ['one', 'other'], exacts: [0], nested: {}}},
    });
    // …but saves a draft whose server-side parse has a plain string argument.
    const response = await request(app)
      .put('/api/messages/cart')
      .send({locale: 'fr-FR', value: '{count} éléments', revision: 1, baseSignature: staleBaseline});
    expect(response.status).toBe(200);
    expect(response.body.signatureChanged).toBe(true);
    expect(response.body.signature.params.count).toEqual({kind: 'string'});

    // Saving again with the now-current signature is consistent.
    const again = await request(app)
      .put('/api/messages/cart')
      .send({
        locale: 'fr-FR',
        value: '{count} éléments',
        revision: response.body.revision,
        baseSignature: stableStringify(response.body.signature),
      });
    expect(again.body.signatureChanged).toBe(false);
  });

  it('rejects stale revisions with 409 and the current server state', async () => {
    const app = createApp();
    const response = await request(app)
      .put('/api/messages/welcome')
      .send({locale: 'fr-FR', value: 'Salut, {name} !', revision: 999});
    expect(response.status).toBe(409);
    expect(response.body.error).toBe('REVISION_CONFLICT');
    expect(response.body.current.value).toBe('Bienvenue, {name} !');
    expect(response.body.current.signature.params.name).toEqual({kind: 'string'});
  });
});

describe('preview endpoint', () => {
  it('renders with the plural rules of the requested locale', async () => {
    const app = createApp();
    const message = '{count, plural, one {# штука} few {# штуки} many {# штук} other {# штуки}}';
    const five = await request(app).post('/api/preview').send({message, locale: 'ru', values: {count: 5}});
    expect(five.body.ok).toBe(true);
    expect(five.body.rendered).toBe('5 штук');
    const two = await request(app).post('/api/preview').send({message, locale: 'ru', values: {count: 2}});
    expect(two.body.rendered).toBe('2 штуки');
  });

  it('renders nested select/plural with escaped apostrophes', async () => {
    const app = createApp();
    const message = "{g, select, female {C''est {n, plural, one {sa # plante} other {ses # plantes}}} other {plantes}}";
    const response = await request(app).post('/api/preview').send({message, locale: 'fr-FR', values: {g: 'female', n: 2}});
    expect(response.body.ok).toBe(true);
    expect(response.body.rendered).toBe("C'est ses 2 plantes");
  });

  it('returns parse diagnostics with character ranges instead of a render', async () => {
    const app = createApp();
    const message = '{count, plural, one {x}';
    const response = await request(app).post('/api/preview').send({message, locale: 'en', values: {count: 1}});
    expect(response.body.ok).toBe(false);
    expect(response.body.rendered).toBeUndefined();
    const diagnostic = response.body.diagnostics.find((d: {code: string}) => d.code.startsWith('PARSE_'));
    expect(diagnostic).toBeDefined();
    expect(typeof diagnostic.start).toBe('number');
    expect(typeof diagnostic.end).toBe('number');
  });

  it('compares against the source message when provided', async () => {
    const app = createApp();
    const response = await request(app).post('/api/preview').send({
      message: 'Bonjour !',
      locale: 'fr-FR',
      values: {},
      sourceMessage: 'Hello, {name}!',
    });
    expect(response.body.ok).toBe(false);
    const missing = response.body.diagnostics.find((d: {code: string}) => d.code === 'MISSING_PARAM');
    expect(missing.start).toBe('Bonjour !'.length);
  });

  it('warns about plural categories the locale needs', async () => {
    const app = createApp();
    const response = await request(app).post('/api/preview').send({
      message: '{n, plural, one {x} other {y}}',
      locale: 'ar',
      values: {n: 1},
    });
    expect(response.body.ok).toBe(true); // warnings do not block rendering
    const codes = response.body.diagnostics.map((d: {code: string}) => d.code);
    expect(codes).toContain('MISSING_LOCALE_CATEGORY');
  });
});

describe('locales endpoint', () => {
  it('exposes plural categories per locale', async () => {
    const app = createApp();
    const response = await request(app).get('/api/locales');
    const byLocale = Object.fromEntries(response.body.map((info: {locale: string}) => [info.locale, info]));
    expect(byLocale['en'].pluralCategories).toEqual(['one', 'other']);
    expect(byLocale['ja'].pluralCategories).toEqual(['other']);
    expect(byLocale['ar'].pluralCategories).toContain('zero');
    expect(byLocale['en'].source).toBe(true);
  });
});
