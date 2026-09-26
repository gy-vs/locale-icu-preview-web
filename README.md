# locale-icu-preview-web

Localization workbench for ICU MessageFormat messages. The editor parses
`{arg}`, `{n, number}`, `{d, date}`, `{t, time}`, plural/select (including
nesting, `offset:` and exact `=N` branches) and apostrophe escaping, instead
of doing naive brace substitution.

## Architecture

- `src/shared/icu/` — isomorphic ICU engine used by **both** sides so they
  never disagree:
  - `parser.ts` — error-tolerant parser producing an AST with character
    ranges; recovers from unclosed constructs so signatures remain
    best-effort available.
  - `signature.ts` — structured parameter signatures, source-vs-target
    comparison (names, types, plural/select branches) and per-locale plural
    category coverage via `Intl.PluralRules`.
  - `format.ts` — locale-aware rendering (`Intl.PluralRules`,
    `Intl.NumberFormat`, `Intl.DateTimeFormat`).
- `src/server/index.ts` — Express API. Parses on save, stores the signature
  and diagnostics per (locale, key), and re-checks every translation when the
  source message changes.
- `src/client/` — React editor: diagnostics list with click-to-select
  character ranges, per-parameter value inputs, and multiple preview
  scenarios rendered instantly by the shared engine. When the draft fails to
  parse, the last valid preview is kept and marked **stale**; when the
  parameter signature changes, scenarios are **invalidated but their values
  are kept** until the user rebases.

## API

- `GET /api/messages?locale=xx` — rows with value, revision, stored
  signature, diagnostics and the source signature.
- `PUT /api/messages/:key` — body `{locale, value, revision, baseSignature?}`.
  Re-parses and stores the signature; `409` on revision conflict;
  `signatureChanged: true` when the server-side re-parse disagrees with the
  client's `baseSignature`.
- `POST /api/preview` — body `{message, locale, values, sourceMessage?}` →
  `{ok, rendered?, missingValues?, signature, diagnostics}`; diagnostics
  carry `[start, end)` character ranges.
- `GET /api/locales` — supported locales with their CLDR plural categories.

## Scripts

- `npm run dev` — server (4174) + Vite dev server (4173)
- `npm test` — vitest suites (parser, signature, format, server, preview state)
- `npm run build` — type-check + production build
