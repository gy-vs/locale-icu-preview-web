import type {Diagnostic, IcuNode, PluralOption, SelectOption} from './types';

const ARG_TYPES = ['number', 'date', 'time', 'plural', 'select', 'selectordinal'] as const;
const PLURAL_KEYWORDS = ['zero', 'one', 'two', 'few', 'many', 'other'];

function isWhitespace(ch: string | undefined): boolean {
  return ch != null && /\s/.test(ch);
}

/**
 * Error-tolerant ICU MessageFormat parser (lenient apostrophe mode).
 *
 * - `''` yields a literal apostrophe; an apostrophe before `{`, `}` or `#`
 *   (inside a plural) starts a quoted literal run.
 * - Malformed constructs are reported as diagnostics with character ranges
 *   and recovered from (an unclosed `{...` becomes literal text) so callers
 *   always get a best-effort AST back.
 */
export function parseMessage(message: string): {nodes: IcuNode[]; diagnostics: Diagnostic[]} {
  const parser = new Parser(message);
  const nodes = parser.parseSequence(false, false);
  return {nodes, diagnostics: parser.diagnostics};
}

class Parser {
  pos = 0;
  diagnostics: Diagnostic[] = [];

  constructor(readonly message: string) {}

  private error(code: Diagnostic['code'], start: number, end: number, message: string, param?: string) {
    this.diagnostics.push({code, severity: 'error', message, start, end, param});
  }

  private warn(code: Diagnostic['code'], start: number, end: number, message: string) {
    this.diagnostics.push({code, severity: 'warning', message, start, end});
  }

  private peek(): string | undefined {
    return this.message[this.pos];
  }

  private skipWhitespace() {
    while (isWhitespace(this.peek())) this.pos++;
  }

  /**
   * Parse a run of text and arguments. When `stopAtBrace` is set, an
   * unquoted `}` terminates the sequence (option body). `inPlural` makes `#`
   * a special pound token.
   */
  parseSequence(stopAtBrace: boolean, inPlural: boolean): IcuNode[] {
    const nodes: IcuNode[] = [];
    let text = '';
    const flush = () => {
      if (text) {
        nodes.push({type: 'text', value: text});
        text = '';
      }
    };

    while (this.pos < this.message.length) {
      const ch = this.message[this.pos];

      if (ch === "'") {
        text += this.parseApostrophe(inPlural);
        continue;
      }
      if (ch === '{') {
        const node = this.parseArgument();
        if (node) {
          flush();
          nodes.push(node);
        } else {
          // Recovered: the unclosed construct is emitted as literal text.
          text += this.message.slice(this.pos);
          this.pos = this.message.length;
        }
        continue;
      }
      if (ch === '}' && stopAtBrace) {
        flush();
        return nodes;
      }
      if (ch === '#' && inPlural) {
        flush();
        nodes.push({type: 'pound', start: this.pos, end: this.pos + 1});
        this.pos++;
        continue;
      }
      text += ch;
      this.pos++;
    }
    flush();
    return nodes;
  }

  /** Consume an apostrophe sequence, returning the literal text it represents. */
  private parseApostrophe(inPlural: boolean): string {
    const start = this.pos;
    const next = this.message[this.pos + 1];
    if (next === "'") {
      this.pos += 2;
      return "'";
    }
    const startsQuote = next === '{' || next === '}' || (inPlural && next === '#');
    if (!startsQuote) {
      this.pos++;
      return "'";
    }
    // Quoted literal: consume until the closing apostrophe.
    this.pos++;
    let literal = '';
    while (this.pos < this.message.length) {
      const ch = this.message[this.pos];
      if (ch === "'") {
        if (this.message[this.pos + 1] === "'") {
          literal += "'";
          this.pos += 2;
          continue;
        }
        this.pos++;
        return literal;
      }
      literal += ch;
      this.pos++;
    }
    this.warn('UNCLOSED_QUOTE', start, this.pos, 'Unterminated quoted literal; treating the rest as literal text');
    return literal;
  }

  /**
   * Parse `{...}` starting at the current position. Returns null when the
   * construct is unclosed; the position is left at the opening brace so the
   * caller can emit the remainder as literal text.
   */
  private parseArgument(): IcuNode | null {
    const start = this.pos;
    const checkpoint = this.pos;
    this.pos++; // consume '{'
    this.skipWhitespace();

    const name = this.readName();
    if (name == null || name === '') {
      this.error('PARSE_UNCLOSED_ARGUMENT', start, this.pos, 'Expected an argument name after "{"');
      this.pos = checkpoint;
      return null;
    }
    this.skipWhitespace();

    const ch = this.peek();
    if (ch === '}') {
      this.pos++;
      return {type: 'argument', name, start, end: this.pos};
    }
    if (ch !== ',') {
      this.error('PARSE_UNCLOSED_ARGUMENT', start, this.pos, `Expected "," or "}" after argument "${name}"`, name);
      this.pos = checkpoint;
      return null;
    }
    this.pos++; // consume ','
    this.skipWhitespace();

    const typeStart = this.pos;
    const type = this.readIdentifier();
    if (!type) {
      this.error('PARSE_EXPECTED_ARGUMENT_TYPE', typeStart, this.pos, `Expected an argument type for "${name}"`, name);
      this.pos = checkpoint;
      return null;
    }
    if (!(ARG_TYPES as readonly string[]).includes(type)) {
      this.error('PARSE_UNKNOWN_ARGUMENT_TYPE', typeStart, this.pos, `Unknown argument type "${type}"`, name);
      this.pos = checkpoint;
      return null;
    }
    this.skipWhitespace();

    if (type === 'number' || type === 'date' || type === 'time') {
      let style: string | null = null;
      if (this.peek() === ',') {
        this.pos++;
        const styleStart = this.pos;
        while (this.pos < this.message.length && this.peek() !== '}') this.pos++;
        style = this.message.slice(styleStart, this.pos).trim() || null;
      }
      if (this.peek() !== '}') {
        this.error('PARSE_UNCLOSED_ARGUMENT', start, this.pos, `Unclosed "${type}" argument "${name}"`, name);
        this.pos = checkpoint;
        return null;
      }
      this.pos++;
      return {type, name, style, start, end: this.pos} as IcuNode;
    }

    // plural / selectordinal / select: options follow after a comma.
    if (this.peek() !== ',') {
      this.error('PARSE_EMPTY_SELECTOR', this.pos, this.pos, `Expected "," before the options of "${name}"`, name);
      this.pos = checkpoint;
      return null;
    }
    this.pos++;
    this.skipWhitespace();

    if (type === 'select') {
      const options = this.parseOptions(name, false);
      if (!options) {
        this.pos = checkpoint;
        return null;
      }
      this.expectClosingBrace(start, name, 'select');
      const node: IcuNode = {type: 'select', name, options: options as SelectOption[], start, end: this.pos};
      this.checkHasOther(node);
      return node;
    }

    // plural / selectordinal
    const ordinal = type === 'selectordinal';
    let offset = 0;
    if (this.message.startsWith('offset:', this.pos)) {
      this.pos += 'offset:'.length;
      this.skipWhitespace();
      const offsetStart = this.pos;
      const raw = this.readNumberLiteral();
      if (raw == null) {
        this.error('PARSE_BAD_OFFSET', offsetStart, this.pos, `Invalid plural offset for "${name}"`, name);
      } else {
        offset = Number(raw);
      }
      this.skipWhitespace();
    }
    const options = this.parseOptions(name, true);
    if (!options) {
      this.pos = checkpoint;
      return null;
    }
    this.expectClosingBrace(start, name, type);
    const node: IcuNode = {type: 'plural', name, ordinal, offset, options: options as PluralOption[], start, end: this.pos};
    this.checkHasOther(node);
    return node;
  }

  private expectClosingBrace(argStart: number, name: string, kind: string) {
    if (this.peek() === '}') {
      this.pos++;
    } else {
      // Should not happen after a successful option parse, but stay safe.
      this.error('PARSE_UNCLOSED_ARGUMENT', argStart, this.pos, `Unclosed ${kind} argument "${name}"`, name);
    }
  }

  private checkHasOther(node: Extract<IcuNode, {type: 'plural' | 'select'}>) {
    const hasOther = node.options.some(option => !('exact' in option && option.exact) && option.selector === 'other');
    if (!hasOther) {
      this.error(
        'MISSING_OTHER',
        node.start,
        Math.min(node.end, node.start + node.name.length + 1),
        `${node.type} "${node.name}" is missing the required "other" option`,
        node.name,
      );
    }
  }

  /** Parse `selector {message}` pairs until the parent's closing `}`. */
  private parseOptions(name: string, plural: boolean): Array<PluralOption | SelectOption> | null {
    const options: Array<PluralOption | SelectOption> = [];
    const seen = new Set<string>();

    for (;;) {
      this.skipWhitespace();
      const ch = this.peek();
      if (ch === '}') return options; // parent closes here; caller consumes
      if (ch == null) {
        this.error('PARSE_UNCLOSED_OPTION', this.pos, this.pos, `Unclosed option list for "${name}"`, name);
        return options.length ? options : null;
      }

      const selectorStart = this.pos;
      let selector: string;
      let exact = false;
      if (plural && ch === '=') {
        this.pos++;
        const raw = this.readNumberLiteral();
        if (raw == null) {
          this.error('PARSE_BAD_EXACT_MATCH', selectorStart, this.pos, `Invalid exact match in plural "${name}" (expected "=N")`, name);
          return options.length ? options : null;
        }
        selector = raw;
        exact = true;
      } else {
        selector = this.readIdentifier() ?? '';
        if (!selector) {
          this.error('PARSE_EMPTY_SELECTOR', selectorStart, this.pos, `Expected an option selector for "${name}"`, name);
          return options.length ? options : null;
        }
      }
      const selectorEnd = this.pos;
      const key = exact ? '=' + selector : selector;
      if (seen.has(key)) {
        this.error('PARSE_DUPLICATE_OPTION', selectorStart, selectorEnd, `Duplicate option "${key}" in "${name}"`, name);
      }
      seen.add(key);

      this.skipWhitespace();
      if (this.peek() !== '{') {
        this.error('PARSE_UNCLOSED_OPTION', selectorStart, this.pos, `Expected "{" to start the message for option "${key}"`, name);
        return options.length ? options : null;
      }
      this.pos++;
      const nodes = this.parseSequence(true, plural);
      if (this.peek() === '}') {
        this.pos++;
      } else {
        this.error('PARSE_UNCLOSED_OPTION', selectorStart, this.pos, `Unclosed message for option "${key}"`, name);
        return options.length ? options : null;
      }
      options.push({selector, exact, nodes, start: selectorStart, end: this.pos, selectorStart, selectorEnd});
    }
  }

  /** Read an argument name: any run of chars except whitespace, `{`, `}`, `,`. */
  private readName(): string | null {
    const start = this.pos;
    while (this.pos < this.message.length) {
      const ch = this.message[this.pos];
      if (isWhitespace(ch) || ch === '{' || ch === '}' || ch === ',') break;
      this.pos++;
    }
    return this.pos > start ? this.message.slice(start, this.pos) : null;
  }

  private readIdentifier(): string | null {
    const start = this.pos;
    while (this.pos < this.message.length && /[A-Za-z]/.test(this.message[this.pos])) this.pos++;
    return this.pos > start ? this.message.slice(start, this.pos) : null;
  }

  private readNumberLiteral(): string | null {
    const match = /^\d+(\.\d+)?/.exec(this.message.slice(this.pos));
    if (!match) return null;
    this.pos += match[0].length;
    return match[0];
  }
}

/** Keywords defined by CLDR for plural selection (exported for tests/UI). */
export const KNOWN_PLURAL_KEYWORDS = PLURAL_KEYWORDS;
