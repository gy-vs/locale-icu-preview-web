import {describe, expect, it} from 'vitest';
import request from 'supertest';
import {createApp} from '../src/server/index';

const app = createApp();

describe('message listing with signatures', () => {
  it('returns structured signatures and diagnostics per row', async () => {
    const response = await request(app).get('/api/messages?locale=fr-FR');
    expect(response.status).toBe(200);
    const cart = response.body.find((row: {key: string}) => row.key === 'cart');
    expect(cart.referenceSignature.args[0]).toMatchObject({
      name: 'count',
      types: ['plural'],
      plural: {exact: [0], categories: ['one', 'other']},
    });
    expect(cart.diagnostics).toEqual([]);
    expect(cart.referenceHash).toMatch(/^s/);
  });

  it('diagnoses a translation that dropped a nested plural argument', async () => {
    const response = await request(app).get('/api/messages?locale=fr-FR');
    const photos = response.body.find((row: {key: string}) => row.key === 'photos');
    expect(photos.diagnostics.some((d: {code: string; arg: string}) => d.code === 'missing-argument' && d.arg === 'count')).toBe(true);
  });

  it('diagnoses missing plural categories for the target locale on fallback rows', async () => {
    const response = await request(app).get('/api/messages?locale=ru');
    const cart = response.body.find((row: {key: string}) => row.key === 'cart');
    expect(cart.source).toBe('en');
    const missing = cart.diagnostics
      .filter((d: {code: string}) => d.code === 'missing-plural-category')
      .map((d: {branch: string}) => d.branch);
    expect(missing.sort()).toEqual(['few', 'many']);
  });

  it('attaches character ranges into the edited message', async () => {
    const response = await request(app).get('/api/messages?locale=fr-FR');
    const photos = response.body.find((row: {key: string}) => row.key === 'photos');
    for (const diagnostic of photos.diagnostics) {
      expect(diagnostic.range.start).toBeGreaterThanOrEqual(0);
      expect(diagnostic.range.end).toBeLessThanOrEqual(photos.value.length);
    }
  });
});

describe('preview endpoint', () => {
  it('renders plural messages per locale rules', async () => {
    const message = '{count, plural, =0 {Your cart is empty} one {# item} other {# items}}';
    const exact = await request(app).post('/api/preview').send({message, locale: 'en', values: {count: 0}});
    expect(exact.body.rendered).toBe('Your cart is empty');
    const one = await request(app).post('/api/preview').send({message, locale: 'en', values: {count: 1}});
    expect(one.body.rendered).toBe('1 item');
    const other = await request(app).post('/api/preview').send({message, locale: 'ru', values: {count: 5}});
    expect(other.body.rendered).toBe('5 items');
  });

  it('renders the same values differently per locale formatting rules', async () => {
    const message = '{total, number, ::currency/USD} due {due, date, long}';
    const en = await request(app).post('/api/preview').send({message, locale: 'en', values: {total: 1234.5, due: '2026-09-26'}});
    expect(en.body.rendered).toBe('$1,234.50 due September 26, 2026');
    const fr = await request(app).post('/api/preview').send({message, locale: 'fr-FR', values: {total: 1234.5, due: '2026-09-26'}});
    expect(fr.body.rendered).toContain('234,50');
    expect(fr.body.rendered).toContain('26 septembre 2026');
  });

  it('returns a located parse diagnostic instead of a render for broken messages', async () => {
    const response = await request(app).post('/api/preview').send({message: '{n, plural, one {x}}', locale: 'en', values: {}});
    expect(response.body.parseOk).toBe(false);
    expect(response.body.rendered).toBeNull();
    expect(response.body.diagnostics[0].code).toBe('parse-error');
    expect(response.body.diagnostics[0].range.start).toBeGreaterThanOrEqual(0);
  });

  it('compares against a provided reference signature', async () => {
    const reference = await request(app).post('/api/preview').send({
      message: '{n, plural, one {# item} other {# items}}',
      locale: 'en',
      values: {},
    });
    const compared = await request(app).post('/api/preview').send({
      message: '{n, plural, one {# article} other {# articles}}',
      locale: 'ru',
      values: {},
      referenceSignature: reference.body.signature,
    });
    expect(compared.body.diagnostics.some((d: {code: string}) => d.code === 'missing-plural-category')).toBe(true);
  });
});

describe('save flow and server-side re-parse', () => {
  it('saves and returns the authoritative signature and diagnostics', async () => {
    const value = '{count, plural, one {# article} other {# articles}}';
    const response = await request(app)
      .put('/api/messages/cart')
      .send({locale: 'fr-FR', value, revision: 5});
    expect(response.status).toBe(200);
    expect(response.body.parseOk).toBe(true);
    expect(response.body.revision).toBe(6);
    expect(response.body.hash).toMatch(/^s/);
    // Dropped =0 and missing fr "many" are caught by the server re-parse.
    expect(response.body.diagnostics.some((d: {code: string; branch?: string}) => d.code === 'missing-plural-exact' && d.branch === '=0')).toBe(true);
    expect(response.body.diagnostics.some((d: {code: string; branch?: string}) => d.code === 'missing-plural-category' && d.branch === 'many')).toBe(true);
  });

  it('flags a mismatch between the client-expected and server-computed signature', async () => {
    const first = await request(app)
      .put('/api/messages/cart')
      .send({locale: 'fr-FR', value: '{count, plural, one {# article} other {# articles}}', expectedSignature: 'sstale'});
    expect(first.body.signatureChanged).toBe(true);

    const second = await request(app)
      .put('/api/messages/cart')
      .send({locale: 'fr-FR', value: '{count, plural, one {# article} other {# articles}}', expectedSignature: first.body.hash});
    expect(second.body.signatureChanged).toBe(false);
    expect(second.body.hash).toBe(first.body.hash);
  });

  it('persists values the client can re-read with matching diagnostics', async () => {
    const value = '{count, plural, =0 {Vide} one {# article} many {# articles} other {# articles}}';
    const put = await request(app).put('/api/messages/cart').send({locale: 'fr-FR', value});
    expect(put.body.diagnostics).toEqual([]);
    const list = await request(app).get('/api/messages?locale=fr-FR');
    const cart = list.body.find((row: {key: string}) => row.key === 'cart');
    expect(cart.value).toBe(value);
    expect(cart.diagnostics).toEqual(put.body.diagnostics);
    expect(cart.signature).toEqual(put.body.signature);
  });

  it('still stores unparseable drafts but reports parseOk=false', async () => {
    const value = '{count, plural, one {x}}';
    const response = await request(app).put('/api/messages/quote').send({locale: 'fr-FR', value});
    expect(response.status).toBe(200);
    expect(response.body.parseOk).toBe(false);
    expect(response.body.signature).toBeNull();
    expect(response.body.diagnostics[0].code).toBe('parse-error');
    const list = await request(app).get('/api/messages?locale=fr-FR');
    const quote = list.body.find((row: {key: string}) => row.key === 'quote');
    expect(quote.value).toBe(value);
    expect(quote.parseOk).toBe(false);
  });

  it('rejects stale revisions with 409', async () => {
    const response = await request(app)
      .put('/api/messages/welcome')
      .send({locale: 'fr-FR', value: 'Salut {name} !', revision: 999});
    expect(response.status).toBe(409);
    expect(response.body.error).toBe('revision-conflict');
  });

  it('rejects unknown keys with 404', async () => {
    const response = await request(app).put('/api/messages/nope').send({locale: 'fr-FR', value: 'x'});
    expect(response.status).toBe(404);
  });
});
