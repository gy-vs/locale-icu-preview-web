import type {Diagnostic, IcuNode, ParamSignature, Signature} from './types';

type Range = {start: number; end: number};

/** Index of where each parameter occurs, used to point diagnostics at the target message. */
export type TargetIndex = {
  paramRanges: Map<string, Range[]>;
  pluralNodes: Map<string, Array<Extract<IcuNode, {type: 'plural'}>>>;
  selectNodes: Map<string, Array<Extract<IcuNode, {type: 'select'}>>>;
};

export function buildTargetIndex(nodes: IcuNode[], index: TargetIndex = freshIndex()): TargetIndex {
  for (const node of nodes) {
    if (node.type === 'argument' || node.type === 'number' || node.type === 'date' || node.type === 'time') {
      push(index.paramRanges, node.name, {start: node.start, end: node.end});
    } else if (node.type === 'plural') {
      push(index.paramRanges, node.name, {start: node.start, end: node.end});
      const list = index.pluralNodes.get(node.name) ?? [];
      list.push(node);
      index.pluralNodes.set(node.name, list);
      for (const option of node.options) buildTargetIndex(option.nodes, index);
    } else if (node.type === 'select') {
      push(index.paramRanges, node.name, {start: node.start, end: node.end});
      const list = index.selectNodes.get(node.name) ?? [];
      list.push(node);
      index.selectNodes.set(node.name, list);
      for (const option of node.options) buildTargetIndex(option.nodes, index);
    }
  }
  return index;
}

function freshIndex(): TargetIndex {
  return {paramRanges: new Map(), pluralNodes: new Map(), selectNodes: new Map()};
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V) {
  const list = map.get(key) ?? [];
  list.push(value);
  map.set(key, list);
}

/** Extract the structured parameter signature of a parsed message. */
export function extractSignature(nodes: IcuNode[]): {signature: Signature; diagnostics: Diagnostic[]} {
  const diagnostics: Diagnostic[] = [];
  const params: Record<string, ParamSignature> = {};

  const merge = (name: string, incoming: ParamSignature, range: Range) => {
    const existing = params[name];
    if (!existing) {
      params[name] = incoming;
      return;
    }
    if (existing.kind !== incoming.kind) {
      diagnostics.push({
        code: 'PARAM_TYPE_CONFLICT',
        severity: 'error',
        message: `Parameter "${name}" is used both as ${existing.kind} and ${incoming.kind}`,
        start: range.start,
        end: range.end,
        param: name,
      });
      return;
    }
    if (existing.kind === 'plural' && incoming.kind === 'plural') {
      existing.keywords = union(existing.keywords, incoming.keywords);
      existing.exacts = union(existing.exacts, incoming.exacts);
      mergeNested(existing.nested, incoming.nested);
    } else if (existing.kind === 'select' && incoming.kind === 'select') {
      existing.options = union(existing.options, incoming.options);
      mergeNested(existing.nested, incoming.nested);
    }
  };

  const mergeNested = (target: Record<string, ParamSignature>, source: Record<string, ParamSignature>) => {
    for (const [name, sig] of Object.entries(source)) {
      const existing = target[name];
      if (!existing) target[name] = sig;
      else if (existing.kind === 'plural' && sig.kind === 'plural') {
        existing.keywords = union(existing.keywords, sig.keywords);
        existing.exacts = union(existing.exacts, sig.exacts);
        mergeNested(existing.nested, sig.nested);
      } else if (existing.kind === 'select' && sig.kind === 'select') {
        existing.options = union(existing.options, sig.options);
        mergeNested(existing.nested, sig.nested);
      }
    }
  };

  const walk = (list: IcuNode[]) => {
    for (const node of list) {
      switch (node.type) {
        case 'argument':
          merge(node.name, {kind: 'string'}, node);
          break;
        case 'number':
          merge(node.name, {kind: 'number'}, node);
          break;
        case 'date':
          merge(node.name, {kind: 'date'}, node);
          break;
        case 'time':
          merge(node.name, {kind: 'time'}, node);
          break;
        case 'plural': {
          const nested: Record<string, ParamSignature> = {};
          for (const option of node.options) {
            const inner = extractSignature(option.nodes);
            diagnostics.push(...inner.diagnostics);
            mergeNested(nested, inner.signature.params);
          }
          merge(
            node.name,
            {
              kind: 'plural',
              ordinal: node.ordinal,
              offset: node.offset,
              keywords: optionKeywords(node.options),
              exacts: optionExacts(node.options),
              nested,
            },
            node,
          );
          break;
        }
        case 'select': {
          const nested: Record<string, ParamSignature> = {};
          for (const option of node.options) {
            const inner = extractSignature(option.nodes);
            diagnostics.push(...inner.diagnostics);
            mergeNested(nested, inner.signature.params);
          }
          merge(node.name, {kind: 'select', options: optionKeywords(node.options), nested}, node);
          break;
        }
      }
    }
  };

  walk(nodes);
  return {signature: {params}, diagnostics};
}

function union<T>(a: T[], b: T[]): T[] {
  return [...new Set([...a, ...b])];
}

function optionKeywords(options: Array<{selector: string; exact?: boolean}>): string[] {
  return options.filter(option => !option.exact).map(option => option.selector);
}

function optionExacts(options: Array<{selector: string; exact: boolean}>): number[] {
  return options.filter(option => option.exact).map(option => Number(option.selector));
}

/**
 * Compare the source-language signature against a target-language signature,
 * producing diagnostics located in the target message.
 *
 * @param targetLength Length of the target message; missing-parameter
 *   diagnostics point at the end of the message.
 */
export function compareSignatures(
  source: Signature,
  target: Signature,
  targetIndex: TargetIndex,
  targetLength: number,
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  compareParams(source.params, target.params, targetIndex, targetLength, diagnostics, '');
  return diagnostics;
}

function compareParams(
  sourceParams: Record<string, ParamSignature>,
  targetParams: Record<string, ParamSignature>,
  targetIndex: TargetIndex,
  targetLength: number,
  diagnostics: Diagnostic[],
  path: string,
) {
  for (const [name, sourceSig] of Object.entries(sourceParams)) {
    const label = path ? `${path} → ${name}` : name;
    const targetSig = targetParams[name];
    if (!targetSig) {
      diagnostics.push({
        code: 'MISSING_PARAM',
        severity: 'error',
        message: `Parameter "${label}" exists in the source message but is missing here`,
        start: targetLength,
        end: targetLength,
        param: name,
      });
      continue;
    }
    const range = firstRange(targetIndex, name, targetLength);
    if (sourceSig.kind !== targetSig.kind) {
      diagnostics.push({
        code: 'TYPE_MISMATCH',
        severity: 'error',
        message: `Parameter "${label}" is ${sourceSig.kind} in the source but ${targetSig.kind} here`,
        start: range.start,
        end: range.end,
        param: name,
      });
      continue;
    }
    if (sourceSig.kind === 'plural' && targetSig.kind === 'plural') {
      comparePlural(label, name, sourceSig, targetSig, targetIndex, targetLength, diagnostics);
    } else if (sourceSig.kind === 'select' && targetSig.kind === 'select') {
      compareSelect(label, name, sourceSig, targetSig, targetIndex, targetLength, diagnostics);
    }
  }

  for (const name of Object.keys(targetParams)) {
    if (sourceParams[name]) continue;
    const range = firstRange(targetIndex, name, targetLength);
    diagnostics.push({
      code: 'EXTRA_PARAM',
      severity: 'warning',
      message: `Parameter "${path ? path + ' → ' + name : name}" does not exist in the source message`,
      start: range.start,
      end: range.end,
      param: name,
    });
  }
}

function comparePlural(
  label: string,
  name: string,
  source: Extract<ParamSignature, {kind: 'plural'}>,
  target: Extract<ParamSignature, {kind: 'plural'}>,
  targetIndex: TargetIndex,
  targetLength: number,
  diagnostics: Diagnostic[],
) {
  const header = pluralHeaderRange(targetIndex, name, targetLength);
  if (source.ordinal !== target.ordinal) {
    diagnostics.push({
      code: 'PLURAL_KIND_MISMATCH',
      severity: 'warning',
      message: `Parameter "${label}" is ${source.ordinal ? 'ordinal' : 'cardinal'} in the source but ${target.ordinal ? 'ordinal' : 'cardinal'} here`,
      start: header.start,
      end: header.end,
      param: name,
    });
  }
  for (const keyword of source.keywords) {
    if (!target.keywords.includes(keyword)) {
      diagnostics.push({
        code: 'MISSING_PLURAL_CATEGORY',
        severity: 'error',
        message: `Plural "${label}" is missing the "${keyword}" branch present in the source`,
        start: header.start,
        end: header.end,
        param: name,
      });
    }
  }
  for (const keyword of target.keywords) {
    if (!source.keywords.includes(keyword)) {
      diagnostics.push({
        code: 'EXTRA_PLURAL_CATEGORY',
        severity: 'warning',
        message: `Plural "${label}" has a "${keyword}" branch that the source does not have`,
        start: header.start,
        end: header.end,
        param: name,
      });
    }
  }
  for (const exact of source.exacts) {
    if (!target.exacts.includes(exact)) {
      diagnostics.push({
        code: 'MISSING_EXACT_MATCH',
        severity: 'error',
        message: `Plural "${label}" is missing the exact "=${exact}" branch present in the source`,
        start: header.start,
        end: header.end,
        param: name,
      });
    }
  }
  for (const exact of target.exacts) {
    if (!source.exacts.includes(exact)) {
      diagnostics.push({
        code: 'EXTRA_EXACT_MATCH',
        severity: 'warning',
        message: `Plural "${label}" has an exact "=${exact}" branch that the source does not have`,
        start: header.start,
        end: header.end,
        param: name,
      });
    }
  }
  compareParams(source.nested, target.nested, targetIndex, targetLength, diagnostics, label);
}

function compareSelect(
  label: string,
  name: string,
  source: Extract<ParamSignature, {kind: 'select'}>,
  target: Extract<ParamSignature, {kind: 'select'}>,
  targetIndex: TargetIndex,
  targetLength: number,
  diagnostics: Diagnostic[],
) {
  const header = selectHeaderRange(targetIndex, name, targetLength);
  for (const option of source.options) {
    if (!target.options.includes(option)) {
      diagnostics.push({
        code: 'MISSING_SELECT_OPTION',
        severity: 'error',
        message: `Select "${label}" is missing the "${option}" option present in the source`,
        start: header.start,
        end: header.end,
        param: name,
      });
    }
  }
  for (const option of target.options) {
    if (!source.options.includes(option)) {
      diagnostics.push({
        code: 'EXTRA_SELECT_OPTION',
        severity: 'warning',
        message: `Select "${label}" has a "${option}" option that the source does not have`,
        start: header.start,
        end: header.end,
        param: name,
      });
    }
  }
  compareParams(source.nested, target.nested, targetIndex, targetLength, diagnostics, label);
}

function firstRange(index: TargetIndex, name: string, fallback: number): Range {
  return index.paramRanges.get(name)?.[0] ?? {start: fallback, end: fallback};
}

/** Range covering `{name, plural` so branch-level diagnostics point at the header. */
function pluralHeaderRange(index: TargetIndex, name: string, fallback: number): Range {
  const node = index.pluralNodes.get(name)?.[0];
  return node ? {start: node.start, end: node.start + 1 + name.length} : {start: fallback, end: fallback};
}

function selectHeaderRange(index: TargetIndex, name: string, fallback: number): Range {
  const node = index.selectNodes.get(name)?.[0];
  return node ? {start: node.start, end: node.start + 1 + name.length} : {start: fallback, end: fallback};
}

/**
 * Check that plural branches line up with the plural categories the locale
 * actually uses (via Intl.PluralRules). Missing categories are warnings
 * (fallback to "other" still works); branches the locale can never select
 * are flagged as unused.
 */
export function checkLocaleCoverage(nodes: IcuNode[], locale: string): Diagnostic[] {
  let categories: readonly string[];
  try {
    categories = new Intl.PluralRules(locale).resolvedOptions().pluralCategories;
  } catch {
    return [];
  }
  const diagnostics: Diagnostic[] = [];

  const walk = (list: IcuNode[]) => {
    for (const node of list) {
      if (node.type === 'plural') {
        const keywords = optionKeywords(node.options);
        for (const category of categories) {
          if (category !== 'other' && !keywords.includes(category)) {
            diagnostics.push({
              code: 'MISSING_LOCALE_CATEGORY',
              severity: 'warning',
              message: `Locale "${locale}" uses the plural category "${category}", but "${node.name}" has no branch for it`,
              start: node.start,
              end: node.start + 1 + node.name.length,
              param: node.name,
            });
          }
        }
        for (const keyword of keywords) {
          if (keyword !== 'other' && !categories.includes(keyword)) {
            diagnostics.push({
              code: 'UNUSED_CATEGORY',
              severity: 'info',
              message: `Locale "${locale}" never selects the plural category "${keyword}" used by "${node.name}"`,
              start: node.start,
              end: node.start + 1 + node.name.length,
              param: node.name,
            });
          }
        }
        for (const option of node.options) walk(option.nodes);
      } else if (node.type === 'select') {
        for (const option of node.options) walk(option.nodes);
      }
    }
  };

  walk(nodes);
  return diagnostics;
}
