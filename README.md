# locale-icu-preview-web

Localization workbench for ICU MessageFormat messages. The editor parses
`plural` / `select` / `number` / `date` / `time` arguments instead of doing
brace-text substitution, so missing arguments and incomplete branches surface
while editing — not at runtime.

## Architecture

- **`src/shared/icu.ts`** — single source of truth used by server, client and tests:
  - `parseIcu` — wraps `@formatjs/icu-messageformat-parser` (locations captured),
    maps parser errors to located diagnostics (e.g. `MISSING_OTHER_CLAUSE`).
  - `extractSignature` — structured argument signature per message: argument names,
    element types, number/date styles, plural `=N` exact branches + keyword
    categories (+ offset, cardinal/ordinal), select options, and character ranges
    for every argument and branch. Handles nesting and apostrophe quoting.
  - `compareSignatures` — source-vs-target diagnostics with target character
    ranges: missing/extra arguments, type mismatches, missing/extra `=N` branches,
    missing/extra select options, and **locale-aware plural checks** driven by
    `Intl.PluralRules` (a Russian target must have `few`/`many`; a `few` branch in
    an English target is flagged as unreachable).
  - `formatMessage` — AST interpreter on top of `Intl.NumberFormat` /
    `Intl.DateTimeFormat` / `Intl.PluralRules` (incl. number/date skeletons,
    plural offset, `#`, exact `=N` precedence). Missing values render as
    `{placeholders}` instead of throwing.
  - `hashSignature` — location-independent identity of a signature; used to detect
    structural changes.
- **`src/server/index.ts`** — Express API; stores translations and re-parses
  authoritatively on every read/write.
- **`src/client/App.tsx`** — editor UI: diagnostics panel (click to select the
  offending range), per-scenario argument value editors, and multi-scenario
  previews rendered per locale.

## API

| Endpoint | Description |
| --- | --- |
| `GET /api/bootstrap` | `{kind, count, locales}` |
| `GET /api/messages?locale=` | Rows with `value`, `source`, `revision`, `sourceValue`, `signature`, `diagnostics`, `referenceSignature`/`referenceHash` (en) |
| `PUT /api/messages/:key` | Body `{locale, value, revision, expectedSignature?}`. `409` on stale revision. Re-parses the stored value and returns authoritative `signature`, `hash`, `diagnostics`, and `signatureChanged` (client-expected vs server-computed hash) |
| `POST /api/preview` | Body `{message, locale, values, referenceSignature?}` → `{parseOk, rendered, diagnostics, signature, hash}`; `rendered` is `null` on parse failure |

## Client semantics

- **Scenarios** — named sets of argument values + a preview locale. The same
  draft is rendered per scenario locale, so plural categories and number/date
  formatting follow that locale's rules (plural inputs show the resolved
  category, e.g. `→ few`).
- **Stale preview** — when the draft stops parsing, each scenario keeps showing
  its last valid render, badged `stale`.
- **Signature invalidation** — when the draft's signature hash changes, existing
  scenarios are marked outdated but entered values are never deleted; values for
  removed arguments are shown as `(unused, kept)` chips and re-attach if the
  argument returns. Editing a value or clicking "Mark reviewed" re-validates.
- **Save** — autosave sends the client's signature hash; the server re-parses
  and replies with its own hash (`signatureChanged` flags divergence) and a
  `409` on revision conflicts.

## Scripts

```sh
npm run dev    # tsx API on :4174 + vite on :4173 (proxy /api)
npm test       # vitest: shared-module units + supertest API tests
npm run build  # tsc --noEmit + vite build
```

## Test coverage

`test/icu.test.ts` and `test/server.test.ts` cover: escaped apostrophes
(`''`, `'{…}'` quoting), nested plural/select, exact `=N` branch precedence
and branch diagnostics, missing `other` (parse error with range), per-locale
plural categories (fr 0→`one`, ru `few`/`many`, ar `zero`/`two`, ja `other`),
plural offset, number/date skeleton formatting per locale, and the save flow —
including server re-parse inconsistency (`signatureChanged`), persisting
unparseable drafts with `parseOk: false`, and revision conflicts.
