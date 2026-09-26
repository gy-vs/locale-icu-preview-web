/**
 * Shared ICU MessageFormat engine types.
 * Used by both the server (authoritative parse on save) and the client
 * (instant preview while typing), so both sides always agree.
 */

export type IcuNode =
  | {type: 'text'; value: string}
  | {type: 'argument'; name: string; start: number; end: number}
  | {type: 'number'; name: string; style: string | null; start: number; end: number}
  | {type: 'date'; name: string; style: string | null; start: number; end: number}
  | {type: 'time'; name: string; style: string | null; start: number; end: number}
  | {type: 'plural'; name: string; ordinal: boolean; offset: number; options: PluralOption[]; start: number; end: number}
  | {type: 'select'; name: string; options: SelectOption[]; start: number; end: number}
  | {type: 'pound'; start: number; end: number};

export type PluralOption = {
  /** Keyword ('one', 'other', ...) or exact match without '=' ('0', '1.5'). */
  selector: string;
  /** True when the selector came from an explicit `=N` match. */
  exact: boolean;
  nodes: IcuNode[];
  /** Range of the whole option (selector through closing brace). */
  start: number;
  end: number;
  /** Range of just the selector token, for pinpoint diagnostics. */
  selectorStart: number;
  selectorEnd: number;
};

export type SelectOption = {
  selector: string;
  nodes: IcuNode[];
  start: number;
  end: number;
  selectorStart: number;
  selectorEnd: number;
};

export type DiagnosticSeverity = 'error' | 'warning' | 'info';

export type Diagnostic = {
  code:
    | 'PARSE_UNCLOSED_ARGUMENT'
    | 'PARSE_UNCLOSED_OPTION'
    | 'PARSE_EXPECTED_ARGUMENT_TYPE'
    | 'PARSE_UNKNOWN_ARGUMENT_TYPE'
    | 'PARSE_BAD_EXACT_MATCH'
    | 'PARSE_BAD_OFFSET'
    | 'PARSE_EMPTY_SELECTOR'
    | 'PARSE_DUPLICATE_OPTION'
    | 'UNCLOSED_QUOTE'
    | 'MISSING_OTHER'
    | 'PARAM_TYPE_CONFLICT'
    | 'MISSING_PARAM'
    | 'EXTRA_PARAM'
    | 'TYPE_MISMATCH'
    | 'PLURAL_KIND_MISMATCH'
    | 'MISSING_PLURAL_CATEGORY'
    | 'EXTRA_PLURAL_CATEGORY'
    | 'MISSING_EXACT_MATCH'
    | 'EXTRA_EXACT_MATCH'
    | 'MISSING_SELECT_OPTION'
    | 'EXTRA_SELECT_OPTION'
    | 'MISSING_LOCALE_CATEGORY'
    | 'UNUSED_CATEGORY';
  severity: DiagnosticSeverity;
  message: string;
  /** Half-open character range [start, end) into the analyzed message. */
  start: number;
  end: number;
  /** Parameter name this diagnostic refers to, when applicable. */
  param?: string;
};

/** Structured parameter signature extracted from a parsed message. */
export type ParamSignature =
  | {kind: 'string'}
  | {kind: 'number'}
  | {kind: 'date'}
  | {kind: 'time'}
  | {
      kind: 'plural';
      ordinal: boolean;
      offset: number;
      /** Keyword selectors present, e.g. ['one', 'other']. */
      keywords: string[];
      /** Exact `=N` selectors present, as numbers. */
      exacts: number[];
      /** Signatures of parameters referenced inside any option body. */
      nested: Record<string, ParamSignature>;
    }
  | {
      kind: 'select';
      options: string[];
      nested: Record<string, ParamSignature>;
    };

export type Signature = {params: Record<string, ParamSignature>};

export type Values = Record<string, string | number | boolean | null | undefined>;

export type Analysis = {
  /** True when no error-severity diagnostic was produced. */
  ok: boolean;
  nodes: IcuNode[];
  signature: Signature;
  diagnostics: Diagnostic[];
};
