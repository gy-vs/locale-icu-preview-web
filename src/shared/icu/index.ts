import {formatMessage} from './format';
import {parseMessage} from './parser';
import {buildTargetIndex, checkLocaleCoverage, compareSignatures, extractSignature} from './signature';
import type {Analysis, Diagnostic} from './types';

export * from './types';
export {formatMessage} from './format';
export type {FormatResult} from './format';
export {KNOWN_PLURAL_KEYWORDS, parseMessage} from './parser';
export {buildTargetIndex, checkLocaleCoverage, compareSignatures, extractSignature} from './signature';

export type AnalyzeOptions = {
  /** Locale used for plural-category coverage checks. */
  locale?: string;
  /** Source-language message; when given, signatures are compared. */
  sourceMessage?: string;
};

/**
 * Full analysis pipeline: parse, extract the parameter signature, compare
 * against the source message (if any) and check locale plural coverage.
 */
export function analyzeMessage(message: string, options: AnalyzeOptions = {}): Analysis {
  const {nodes, diagnostics} = parseMessage(message);
  const extracted = extractSignature(nodes);
  diagnostics.push(...extracted.diagnostics);

  if (options.sourceMessage != null) {
    const source = analyzeMessage(options.sourceMessage, {locale: options.locale});
    const targetIndex = buildTargetIndex(nodes);
    diagnostics.push(...compareSignatures(source.signature, extracted.signature, targetIndex, message.length));
  }
  if (options.locale) {
    diagnostics.push(...checkLocaleCoverage(nodes, options.locale));
  }

  diagnostics.sort((a, b) => a.start - b.start || a.end - b.end);
  return {
    ok: !diagnostics.some(diagnostic => diagnostic.severity === 'error'),
    nodes,
    signature: extracted.signature,
    diagnostics,
  };
}

/** Deterministic serialization used to detect signature changes. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, v]) => JSON.stringify(key) + ':' + stableStringify(v));
  return '{' + entries.join(',') + '}';
}

/** Render a message string in one shot; returns null when it fails to parse. */
export function tryFormat(
  message: string,
  values: Record<string, string | number | boolean | null | undefined>,
  locale: string,
): {rendered: string; missingValues: string[]; diagnostics: Diagnostic[]} | null {
  const analysis = analyzeMessage(message, {locale});
  if (!analysis.ok) return null;
  const result = formatMessage(analysis.nodes, values, locale);
  return {...result, diagnostics: analysis.diagnostics};
}
