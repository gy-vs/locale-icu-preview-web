import {
  parse,
  TYPE,
  type DateTimeSkeleton,
  type MessageFormatElement,
  type NumberSkeleton,
  type PluralElement,
  type SelectElement,
} from '@formatjs/icu-messageformat-parser';

// ---------------------------------------------------------------------------
// Types shared between server, client and tests
// ---------------------------------------------------------------------------

export interface Range {
  start: number;
  end: number;
}

export type Severity = 'error' | 'warning';

export interface Diagnostic {
  code:
    | 'parse-error'
    | 'missing-argument'
    | 'extra-argument'
    | 'argument-type-mismatch'
    | 'missing-plural-exact'
    | 'extra-plural-exact'
    | 'missing-plural-category'
    | 'invalid-plural-category'
    | 'missing-select-option'
    | 'extra-select-option';
  severity: Severity;
  message: string;
  arg?: string;
  branch?: string;
  /** Character offsets into the *target* (edited) message. */
  range: Range;
}

export type ArgType = 'argument' | 'number' | 'date' | 'time' | 'select' | 'plural';

export interface PluralSignature {
  pluralType: 'cardinal' | 'ordinal';
  offset: number;
  /** Exact `=N` branch values, sorted ascending. */
  exact: number[];
  /** Keyword branches (`one`, `other`, …), sorted. */
  categories: string[];
}

export interface SelectSignature {
  options: string[];
}

export interface ArgSignature {
  name: string;
  /** All element types this argument is used with, sorted. */
  types: ArgType[];
  /** Canonical style strings for number/date/time occurrences (`percent`, `::currency/USD`, …). */
  styles: string[];
  plural?: PluralSignature;
  select?: SelectSignature;
  /** Character ranges of every occurrence of this argument. */
  locations: Range[];
  /** First occurrence ranges per complex type, used to anchor diagnostics. */
  pluralLocation?: Range;
  selectLocation?: Range;
  /** Branch key (`one`, `=0`, `female`, …) -> range of that branch in the message. */
  branchLocations: Record<string, Range>;
}

export interface MessageSignature {
  /** Sorted by argument name. */
  args: ArgSignature[];
}

export type ParseResult =
  | {ok: true; ast: MessageFormatElement[]}
  | {ok: false; error: Diagnostic};

export type Values = Record<string, string | number | boolean | null | undefined>;

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

const PARSE_ERROR_TEXT: Record<string, string> = {
  MISSING_OTHER_CLAUSE: 'A plural/select argument must have an "other" branch',
  EXPECT_ARGUMENT_CLOSING_BRACE: 'Missing closing brace "}" for argument',
  EXPECT_PLURAL_ARGUMENT_SELECTOR: 'Expected a plural branch selector such as "one" or "=0"',
  EXPECT_SELECT_ARGUMENT_SELECTOR: 'Expected a select option selector',
  UNMATCHED_CLOSING_BRACE: 'Unmatched closing brace "}"',
  EXPECT_DATE_ARGUMENT_SKELETON: 'Invalid date/time skeleton',
  EXPECT_NUMBER_ARGUMENT_SKELETON: 'Invalid number skeleton',
};

export function parseIcu(message: string): ParseResult {
  try {
    const ast = parse(message, {captureLocation: true, requiresOtherClause: true});
    return {ok: true, ast};
  } catch (raw) {
    const err = raw as {message?: string; location?: {start: {offset: number}; end: {offset: number}}};
    const code = String(err?.message ?? 'PARSE_ERROR');
    const friendly = PARSE_ERROR_TEXT[code];
    return {
      ok: false,
      error: {
        code: 'parse-error',
        severity: 'error',
        message: friendly ? `${friendly} (${code})` : `Invalid ICU message (${code})`,
        range: {
          start: err?.location?.start.offset ?? 0,
          end: err?.location?.end.offset ?? 0,
        },
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Signature extraction
// ---------------------------------------------------------------------------

function rangeOf(el: {location?: {start: {offset: number}; end: {offset: number}} | null}): Range | undefined {
  const loc = el.location;
  return loc ? {start: loc.start.offset, end: loc.end.offset} : undefined;
}

function canonicalStyle(style: unknown): string {
  if (style == null) return '';
  if (typeof style === 'string') return style;
  const skeleton = style as NumberSkeleton | DateTimeSkeleton;
  if ('pattern' in skeleton && typeof skeleton.pattern === 'string') return `::${skeleton.pattern}`;
  if ('tokens' in skeleton && Array.isArray(skeleton.tokens)) {
    const text = skeleton.tokens
      .map(token => token.stem + (token.options?.length ? `/${token.options.join('/')}` : ''))
      .join(' ');
    return `::${text}`;
  }
  return String(style);
}

interface ArgBuilder {
  name: string;
  types: Set<ArgType>;
  styles: Set<string>;
  plural?: PluralSignature;
  select?: SelectSignature;
  locations: Range[];
  pluralLocation?: Range;
  selectLocation?: Range;
  branchLocations: Record<string, Range>;
}

function builderFor(map: Map<string, ArgBuilder>, name: string): ArgBuilder {
  let builder = map.get(name);
  if (!builder) {
    builder = {name, types: new Set(), styles: new Set(), locations: [], branchLocations: {}};
    map.set(name, builder);
  }
  return builder;
}

function recordBranch(builder: ArgBuilder, key: string, range: Range | undefined) {
  if (range && builder.branchLocations[key] == null) builder.branchLocations[key] = range;
}

function collect(elements: MessageFormatElement[], map: Map<string, ArgBuilder>) {
  for (const el of elements) {
    const range = rangeOf(el);
    switch (el.type) {
      case TYPE.literal:
      case TYPE.pound:
        break;
      case TYPE.argument: {
        const builder = builderFor(map, String(el.value));
        builder.types.add('argument');
        if (range) builder.locations.push(range);
        break;
      }
      case TYPE.number:
      case TYPE.date:
      case TYPE.time: {
        const kind: ArgType = el.type === TYPE.number ? 'number' : el.type === TYPE.date ? 'date' : 'time';
        const builder = builderFor(map, String(el.value));
        builder.types.add(kind);
        const style = canonicalStyle((el as {style?: unknown}).style);
        if (style) builder.styles.add(style);
        if (range) builder.locations.push(range);
        break;
      }
      case TYPE.select: {
        const select = el as SelectElement;
        const builder = builderFor(map, String(select.value));
        builder.types.add('select');
        if (range) {
          builder.locations.push(range);
          builder.selectLocation ??= range;
        }
        builder.select ??= {options: []};
        for (const [key, option] of Object.entries(select.options)) {
          if (!builder.select.options.includes(key)) builder.select.options.push(key);
          recordBranch(builder, key, rangeOf(option));
          collect(option.value, map);
        }
        break;
      }
      case TYPE.plural: {
        const plural = el as PluralElement;
        const builder = builderFor(map, String(plural.value));
        builder.types.add('plural');
        if (range) {
          builder.locations.push(range);
          builder.pluralLocation ??= range;
        }
        builder.plural ??= {
          pluralType: plural.pluralType === 'ordinal' ? 'ordinal' : 'cardinal',
          offset: plural.offset ?? 0,
          exact: [],
          categories: [],
        };
        for (const [key, option] of Object.entries(plural.options)) {
          if (key.startsWith('=')) {
            const exact = Number(key.slice(1));
            if (Number.isFinite(exact) && !builder.plural.exact.includes(exact)) {
              builder.plural.exact.push(exact);
            }
          } else if (!builder.plural.categories.includes(key)) {
            builder.plural.categories.push(key);
          }
          recordBranch(builder, key, rangeOf(option));
          collect(option.value, map);
        }
        break;
      }
      default:
        break;
    }
  }
}

export function extractSignature(ast: MessageFormatElement[]): MessageSignature {
  const map = new Map<string, ArgBuilder>();
  collect(ast, map);
  const args: ArgSignature[] = [...map.values()].map(builder => ({
    name: builder.name,
    types: [...builder.types].sort(),
    styles: [...builder.styles].sort(),
    ...(builder.plural
      ? {
          plural: {
            ...builder.plural,
            exact: [...builder.plural.exact].sort((a, b) => a - b),
            categories: [...builder.plural.categories].sort(),
          },
        }
      : {}),
    ...(builder.select ? {select: {options: [...builder.select.options].sort()}} : {}),
    locations: builder.locations,
    ...(builder.pluralLocation ? {pluralLocation: builder.pluralLocation} : {}),
    ...(builder.selectLocation ? {selectLocation: builder.selectLocation} : {}),
    branchLocations: builder.branchLocations,
  }));
  args.sort((a, b) => a.name.localeCompare(b.name));
  return {args};
}

/** Signature without source ranges — the stable, hashable identity of a message. */
export function stripLocations(signature: MessageSignature): MessageSignature {
  return {
    args: signature.args.map(arg => ({
      name: arg.name,
      types: arg.types,
      styles: arg.styles,
      ...(arg.plural ? {plural: arg.plural} : {}),
      ...(arg.select ? {select: arg.select} : {}),
      locations: [],
      branchLocations: {},
    })),
  };
}

export function hashSignature(signature: MessageSignature | null): string {
  if (!signature) return 'none';
  const text = JSON.stringify(stripLocations(signature));
  let hash = 5381;
  for (let index = 0; index < text.length; index += 1) {
    hash = ((hash << 5) + hash + text.charCodeAt(index)) | 0;
  }
  return 's' + (hash >>> 0).toString(36);
}

// ---------------------------------------------------------------------------
// Locale plural rules
// ---------------------------------------------------------------------------

export function pluralCategoriesFor(locale: string, pluralType: 'cardinal' | 'ordinal' = 'cardinal'): string[] {
  try {
    return [...new Intl.PluralRules(locale, {type: pluralType}).resolvedOptions().pluralCategories].sort();
  } catch {
    return ['other'];
  }
}

export function pluralCategoryFor(locale: string, pluralType: 'cardinal' | 'ordinal', value: number): string {
  try {
    return new Intl.PluralRules(locale, {type: pluralType}).select(value);
  } catch {
    return 'other';
  }
}

// ---------------------------------------------------------------------------
// Signature comparison (source/reference vs target/translation)
// ---------------------------------------------------------------------------

const ZERO: Range = {start: 0, end: 0};

function anchor(arg: ArgSignature | undefined, fallback: Range = ZERO): Range {
  return arg?.locations[0] ?? fallback;
}

/**
 * Compare a target (translation) signature against the source signature,
 * taking the *target locale's* plural rules into account. Ranges point into
 * the target message.
 */
export function compareSignatures(
  reference: MessageSignature | null,
  target: MessageSignature,
  options: {locale: string},
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const targetByName = new Map(target.args.map(arg => [arg.name, arg]));

  if (reference) {
    for (const refArg of reference.args) {
      const targetArg = targetByName.get(refArg.name);
      if (!targetArg) {
        diagnostics.push({
          code: 'missing-argument',
          severity: 'error',
          arg: refArg.name,
          message: `Argument "${refArg.name}" is used by the source message but missing here`,
          range: ZERO,
        });
        continue;
      }
      for (const refType of refArg.types) {
        if (!targetArg.types.includes(refType)) {
          diagnostics.push({
            code: 'argument-type-mismatch',
            severity: 'error',
            arg: refArg.name,
            message: `Argument "${refArg.name}" is "${refType}" in the source but ${targetArg.types.join('/')} here`,
            range: anchor(targetArg),
          });
        }
      }
      for (const targetType of targetArg.types) {
        if (!refArg.types.includes(targetType)) {
          diagnostics.push({
            code: 'argument-type-mismatch',
            severity: 'warning',
            arg: refArg.name,
            message: `Argument "${refArg.name}" is "${targetType}" here but ${refArg.types.join('/')} in the source`,
            range: anchor(targetArg),
          });
        }
      }
      if (refArg.plural && targetArg.plural) {
        for (const exact of refArg.plural.exact) {
          if (!targetArg.plural.exact.includes(exact)) {
            diagnostics.push({
              code: 'missing-plural-exact',
              severity: 'error',
              arg: refArg.name,
              branch: `=${exact}`,
              message: `Plural "${refArg.name}" is missing the exact "=${exact}" branch from the source`,
              range: targetArg.pluralLocation ?? anchor(targetArg),
            });
          }
        }
        for (const exact of targetArg.plural.exact) {
          if (!refArg.plural.exact.includes(exact)) {
            diagnostics.push({
              code: 'extra-plural-exact',
              severity: 'warning',
              arg: refArg.name,
              branch: `=${exact}`,
              message: `Plural "${refArg.name}" adds exact branch "=${exact}" which the source does not have`,
              range: targetArg.branchLocations[`=${exact}`] ?? targetArg.pluralLocation ?? anchor(targetArg),
            });
          }
        }
      }
      if (refArg.select && targetArg.select) {
        for (const option of refArg.select.options) {
          if (!targetArg.select.options.includes(option)) {
            diagnostics.push({
              code: 'missing-select-option',
              severity: 'error',
              arg: refArg.name,
              branch: option,
              message: `Select "${refArg.name}" is missing the "${option}" option from the source`,
              range: targetArg.selectLocation ?? anchor(targetArg),
            });
          }
        }
        for (const option of targetArg.select.options) {
          if (!refArg.select.options.includes(option)) {
            diagnostics.push({
              code: 'extra-select-option',
              severity: 'warning',
              arg: refArg.name,
              branch: option,
              message: `Select "${refArg.name}" adds option "${option}" which the source does not have`,
              range: targetArg.branchLocations[option] ?? targetArg.selectLocation ?? anchor(targetArg),
            });
          }
        }
      }
    }
  }

  for (const targetArg of target.args) {
    if (reference && !reference.args.some(refArg => refArg.name === targetArg.name)) {
      diagnostics.push({
        code: 'extra-argument',
        severity: 'warning',
        arg: targetArg.name,
        message: `Argument "${targetArg.name}" is not used by the source message`,
        range: anchor(targetArg),
      });
    }
    if (targetArg.plural) {
      const localeCategories = pluralCategoriesFor(options.locale, targetArg.plural.pluralType);
      for (const category of localeCategories) {
        if (!targetArg.plural.categories.includes(category)) {
          diagnostics.push({
            code: 'missing-plural-category',
            severity: 'error',
            arg: targetArg.name,
            branch: category,
            message: `Plural "${targetArg.name}" needs a "${category}" branch: locale ${options.locale} can select it`,
            range: targetArg.pluralLocation ?? anchor(targetArg),
          });
        }
      }
      for (const category of targetArg.plural.categories) {
        if (!localeCategories.includes(category)) {
          diagnostics.push({
            code: 'invalid-plural-category',
            severity: 'warning',
            arg: targetArg.name,
            branch: category,
            message: `Plural category "${category}" never matches in locale ${options.locale}`,
            range: targetArg.branchLocations[category] ?? targetArg.pluralLocation ?? anchor(targetArg),
          });
        }
      }
    }
  }

  const rank = {error: 0, warning: 1};
  diagnostics.sort((a, b) => rank[a.severity] - rank[b.severity] || a.range.start - b.range.start || a.code.localeCompare(b.code));
  return diagnostics;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

const REGION_CURRENCY: Record<string, string> = {
  US: 'USD', GB: 'GBP', JP: 'JPY', CN: 'CNY', RU: 'RUB', PL: 'PLN', BR: 'BRL', IN: 'INR',
  CA: 'CAD', AU: 'AUD', CH: 'CHF', SE: 'SEK', KR: 'KRW', MX: 'MXN', SA: 'SAR', AE: 'AED',
  EG: 'EGP', FR: 'EUR', DE: 'EUR', ES: 'EUR', IT: 'EUR', NL: 'EUR', BE: 'EUR', PT: 'EUR', AT: 'EUR', IE: 'EUR',
};

export function defaultCurrencyForLocale(locale: string): string {
  try {
    const region = new Intl.Locale(locale).maximize().region;
    if (region && REGION_CURRENCY[region]) return REGION_CURRENCY[region];
  } catch {
    /* fall through */
  }
  return 'USD';
}

const NUMBER_OPTION_KEYS = [
  'style', 'currency', 'currencyDisplay', 'currencySign', 'unit', 'unitDisplay',
  'minimumIntegerDigits', 'minimumFractionDigits', 'maximumFractionDigits',
  'minimumSignificantDigits', 'maximumSignificantDigits', 'notation', 'compactDisplay',
  'signDisplay', 'useGrouping', 'roundingIncrement', 'trailingZeroDisplay',
] as const;

const ROUNDING_MODE_MAP: Record<string, string> = {
  'ceil': 'ceil', 'floor': 'floor', 'down': 'trunc', 'up': 'expand',
  'half-even': 'halfEven', 'half-down': 'halfTrunc', 'half-up': 'halfExpand',
  'unnecessary': 'halfEven',
};

function skeletonNumberOptions(skeleton: NumberSkeleton): Intl.NumberFormatOptions {
  const parsed = (skeleton.parsedOptions ?? {}) as Record<string, unknown>;
  const options: Record<string, unknown> = {};
  for (const key of NUMBER_OPTION_KEYS) {
    if (parsed[key] !== undefined) options[key] = parsed[key];
  }
  if (typeof parsed.roundingMode === 'string' && ROUNDING_MODE_MAP[parsed.roundingMode]) {
    options.roundingMode = ROUNDING_MODE_MAP[parsed.roundingMode];
  }
  return options as Intl.NumberFormatOptions;
}

function numberFormatter(locale: string, style: unknown): Intl.NumberFormat {
  try {
    if (typeof style === 'string') {
      if (style === 'integer') return new Intl.NumberFormat(locale, {maximumFractionDigits: 0});
      if (style === 'currency') {
        return new Intl.NumberFormat(locale, {style: 'currency', currency: defaultCurrencyForLocale(locale)});
      }
      if (style === 'percent') return new Intl.NumberFormat(locale, {style: 'percent'});
      return new Intl.NumberFormat(locale);
    }
    if (style && typeof style === 'object' && 'tokens' in (style as NumberSkeleton)) {
      const options = skeletonNumberOptions(style as NumberSkeleton);
      if (options.style === 'currency' && !options.currency) {
        options.currency = defaultCurrencyForLocale(locale);
      }
      if (options.style === 'unit' && !options.unit) delete options.style;
      return new Intl.NumberFormat(locale, options);
    }
  } catch {
    /* fall through to default */
  }
  return new Intl.NumberFormat(locale);
}

const DATE_OPTION_KEYS = [
  'weekday', 'era', 'year', 'month', 'day', 'hour', 'minute', 'second',
  'timeZoneName', 'hourCycle', 'hour12', 'fractionalSecondDigits', 'dayPeriod',
] as const;

function dateTimeFormatter(locale: string, kind: 'date' | 'time', style: unknown): Intl.DateTimeFormat {
  const fallback = kind === 'date' ? {dateStyle: 'medium'} : {timeStyle: 'medium'};
  try {
    if (typeof style === 'string') {
      if (['full', 'long', 'medium', 'short'].includes(style)) {
        const preset = style as 'full' | 'long' | 'medium' | 'short';
        return new Intl.DateTimeFormat(locale, kind === 'date' ? {dateStyle: preset} : {timeStyle: preset});
      }
      return new Intl.DateTimeFormat(locale, fallback as Intl.DateTimeFormatOptions);
    }
    if (style && typeof style === 'object' && 'pattern' in (style as DateTimeSkeleton)) {
      const parsed = ((style as DateTimeSkeleton).parsedOptions ?? {}) as Record<string, unknown>;
      const options: Record<string, unknown> = {};
      for (const key of DATE_OPTION_KEYS) {
        if (parsed[key] !== undefined) options[key] = parsed[key];
      }
      if (Object.keys(options).length > 0) {
        return new Intl.DateTimeFormat(locale, options as Intl.DateTimeFormatOptions);
      }
    }
  } catch {
    /* fall through to default */
  }
  return new Intl.DateTimeFormat(locale, fallback as Intl.DateTimeFormatOptions);
}

function toDate(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value);
  if (typeof value === 'string' && value.trim() !== '') {
    const trimmed = value.trim();
    const timeMatch = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(trimmed);
    if (timeMatch) {
      return new Date(1970, 0, 1, Number(timeMatch[1]), Number(timeMatch[2]), Number(timeMatch[3] ?? 0));
    }
    // Date-only strings are interpreted as local dates, not UTC midnight.
    const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
    if (dateMatch) {
      return new Date(Number(dateMatch[1]), Number(dateMatch[2]) - 1, Number(dateMatch[3]));
    }
    const parsed = new Date(trimmed);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}

interface PluralContext {
  /** null when the argument value is missing: `#` renders as a placeholder. */
  value: number | null;
  offset: number;
  name: string;
}

function formatElements(
  elements: MessageFormatElement[],
  values: Values,
  locale: string,
  pluralStack: PluralContext[],
): string {
  let output = '';
  for (const el of elements) {
    switch (el.type) {
      case TYPE.literal:
        output += String(el.value);
        break;
      case TYPE.argument: {
        const raw = values[String(el.value)];
        output += raw == null || raw === '' ? `{${String(el.value)}}` : String(raw);
        break;
      }
      case TYPE.number: {
        const name = String(el.value);
        const raw = values[name];
        const num = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
        output += Number.isFinite(num)
          ? numberFormatter(locale, (el as {style?: unknown}).style).format(num)
          : `{${name}}`;
        break;
      }
      case TYPE.date:
      case TYPE.time: {
        const name = String(el.value);
        const date = toDate(values[name]);
        output += date
          ? dateTimeFormatter(locale, el.type === TYPE.date ? 'date' : 'time', (el as {style?: unknown}).style).format(date)
          : `{${name}}`;
        break;
      }
      case TYPE.select: {
        const select = el as SelectElement;
        const key = values[String(select.value)];
        const option = (key != null && select.options[String(key)]) || select.options.other;
        if (option) output += formatElements(option.value, values, locale, pluralStack);
        break;
      }
      case TYPE.plural: {
        const plural = el as PluralElement;
        const name = String(plural.value);
        const raw = values[name];
        const num = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
        const offset = plural.offset ?? 0;
        let option = numValid(num) ? plural.options[`=${num}`] : undefined;
        if (!option) {
          const category = numValid(num)
            ? pluralCategoryFor(locale, plural.pluralType === 'ordinal' ? 'ordinal' : 'cardinal', num - offset)
            : 'other';
          option = plural.options[category] ?? plural.options.other;
        }
        if (option) {
          pluralStack.push({value: numValid(num) ? num : null, offset, name});
          output += formatElements(option.value, values, locale, pluralStack);
          pluralStack.pop();
        }
        break;
      }
      case TYPE.pound: {
        const context = pluralStack[pluralStack.length - 1];
        if (!context) output += '#';
        else if (context.value == null) output += `{${context.name}}`;
        else output += new Intl.NumberFormat(locale).format(context.value - context.offset);
        break;
      }
      default:
        break;
    }
  }
  return output;
}

function numValid(value: number): boolean {
  return Number.isFinite(value);
}

export function formatMessage(ast: MessageFormatElement[], values: Values, locale: string): string {
  return formatElements(ast, values, locale, []);
}

// ---------------------------------------------------------------------------
// Scenario seeding helpers (used by the client)
// ---------------------------------------------------------------------------

/** Sample value for one argument; `variant` shifts plural/number samples per scenario. */
export function sampleValueForArg(arg: ArgSignature, variant: number): string | number | null {
  const pluralSamples = [2, 0, 1, 5, 1.5];
  if (arg.types.includes('plural')) return pluralSamples[variant % pluralSamples.length];
  if (arg.types.includes('number')) return variant === 0 ? 1234.56 : 42;
  if (arg.types.includes('date')) return '2026-09-26';
  if (arg.types.includes('time')) return '14:30';
  if (arg.types.includes('select')) {
    const first = arg.select?.options.find(option => option !== 'other') ?? arg.select?.options[0];
    return first ?? null;
  }
  return 'Ari';
}
