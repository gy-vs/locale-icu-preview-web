import {describe, expect, it} from 'vitest';
import {parseMessage} from '../src/shared/icu/parser';
import type {IcuNode} from '../src/shared/icu/types';

function texts(nodes: IcuNode[]): string {
  return nodes.map(node => (node.type === 'text' ? node.value : '')).join('');
}

describe('icu parser', () => {
  it('parses plain text and simple arguments', () => {
    const {nodes, diagnostics} = parseMessage('Welcome, {name}!');
    expect(diagnostics).toEqual([]);
    expect(nodes).toHaveLength(3);
    expect(nodes[1]).toMatchObject({type: 'argument', name: 'name', start: 9, end: 15});
  });

  it('doubles an apostrophe into a literal one', () => {
    const {nodes, diagnostics} = parseMessage("You''ve got {count, plural, one {# message} other {# messages}}");
    expect(diagnostics).toEqual([]);
    expect(nodes[0]).toMatchObject({type: 'text', value: "You've got "});
    expect(nodes[1]).toMatchObject({type: 'plural', name: 'count'});
  });

  it('quotes braces with an apostrophe so they stay literal', () => {
    const {nodes, diagnostics} = parseMessage("Use '{name}' as a placeholder");
    expect(diagnostics).toEqual([]);
    expect(texts(nodes)).toBe('Use {name} as a placeholder');
    expect(nodes.every(node => node.type === 'text')).toBe(true);
  });

  it('quotes the pound sign inside plural bodies', () => {
    const {nodes, diagnostics} = parseMessage("{n, plural, one {'#' symbol} other {# items}}");
    expect(diagnostics).toEqual([]);
    const plural = nodes[0];
    if (plural.type !== 'plural') throw new Error('expected plural');
    expect(texts(plural.options[0].nodes)).toBe('# symbol');
    expect(plural.options[1].nodes[0]).toMatchObject({type: 'pound'});
  });

  it('treats a lone apostrophe as literal text', () => {
    const {nodes, diagnostics} = parseMessage("it's fine");
    expect(diagnostics).toEqual([]);
    expect(texts(nodes)).toBe("it's fine");
  });

  it('parses nested plural inside select inside plural', () => {
    const message =
      '{n, plural, one {{gender, select, female {she has {m, plural, one {# cat} other {# cats}}} other {they have cats}}} other {many}}';
    const {nodes, diagnostics} = parseMessage(message);
    expect(diagnostics).toEqual([]);
    const outer = nodes[0];
    if (outer.type !== 'plural') throw new Error('expected outer plural');
    const select = outer.options[0].nodes[0];
    if (select.type !== 'select') throw new Error('expected nested select');
    const innerPlural = select.options[0].nodes[1];
    if (innerPlural.type !== 'plural') throw new Error('expected inner plural');
    expect(innerPlural.name).toBe('m');
    expect(innerPlural.options.map(option => option.selector)).toEqual(['one', 'other']);
  });

  it('captures exact =N branches and offsets', () => {
    const {nodes, diagnostics} = parseMessage('{n, plural, offset:1 =0 {nobody} =2 {a pair} other {# people}}');
    expect(diagnostics).toEqual([]);
    const plural = nodes[0];
    if (plural.type !== 'plural') throw new Error('expected plural');
    expect(plural.offset).toBe(1);
    expect(plural.options[0]).toMatchObject({selector: '0', exact: true});
    expect(plural.options[1]).toMatchObject({selector: '2', exact: true});
    expect(plural.options[2]).toMatchObject({selector: 'other', exact: false});
  });

  it('reports a missing other branch with a locatable range', () => {
    const message = '{n, plural, one {one thing}}';
    const {diagnostics} = parseMessage(message);
    const missing = diagnostics.find(diagnostic => diagnostic.code === 'MISSING_OTHER');
    expect(missing).toBeDefined();
    expect(missing!.severity).toBe('error');
    expect(message.slice(missing!.start, missing!.end)).toBe('{n');
  });

  it('reports missing other for select as well', () => {
    const {diagnostics} = parseMessage('{g, select, female {she} male {he}}');
    expect(diagnostics.some(diagnostic => diagnostic.code === 'MISSING_OTHER')).toBe(true);
  });

  it('rejects duplicate option selectors', () => {
    const {diagnostics} = parseMessage('{n, plural, one {a} one {b} other {c}}');
    expect(diagnostics.some(diagnostic => diagnostic.code === 'PARSE_DUPLICATE_OPTION')).toBe(true);
  });

  it('rejects malformed exact matches', () => {
    const {diagnostics} = parseMessage('{n, plural, =x {bad} other {ok}}');
    expect(diagnostics.some(diagnostic => diagnostic.code === 'PARSE_BAD_EXACT_MATCH')).toBe(true);
  });

  it('recovers from an unclosed brace by treating the rest as text', () => {
    const {nodes, diagnostics} = parseMessage('Hello {name');
    expect(diagnostics.some(diagnostic => diagnostic.code === 'PARSE_UNCLOSED_ARGUMENT')).toBe(true);
    expect(texts(nodes)).toBe('Hello {name');
  });

  it('recovers from an unclosed plural option list', () => {
    const {nodes, diagnostics} = parseMessage('{n, plural, one {x} other {y}');
    expect(diagnostics.some(diagnostic => diagnostic.code.startsWith('PARSE_'))).toBe(true);
    // Best effort: the plural node is still available for signature extraction.
    expect(nodes[0]).toMatchObject({type: 'plural', name: 'n'});
  });

  it('treats # outside a plural as literal text', () => {
    const {nodes, diagnostics} = parseMessage('Issue #42');
    expect(diagnostics).toEqual([]);
    expect(texts(nodes)).toBe('Issue #42');
  });

  it('parses typed arguments with styles', () => {
    const {nodes, diagnostics} = parseMessage('{d, date, medium} {t, time, short} {v, number, percent}');
    expect(diagnostics).toEqual([]);
    expect(nodes[0]).toMatchObject({type: 'date', name: 'd', style: 'medium'});
    expect(nodes[2]).toMatchObject({type: 'time', name: 't', style: 'short'});
    expect(nodes[4]).toMatchObject({type: 'number', name: 'v', style: 'percent'});
  });

  it('flags unknown argument types', () => {
    const {diagnostics} = parseMessage('{x, boolean}');
    expect(diagnostics.some(diagnostic => diagnostic.code === 'PARSE_UNKNOWN_ARGUMENT_TYPE')).toBe(true);
  });
});
