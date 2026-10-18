import { isUndefined } from 'ohnejs/utils';

const IDENTIFIER_CHAR = /[\w$\u0080-\uffff]/;
const COMMENT_MARK = /\/\*|\*\//g;
const DOLLAR_TAG = /\$(?:[A-Za-z_\u0080-\uffff][\w\u0080-\uffff]*)?\$/y;

/**
 * Rewrites every `?` placeholder in `sql` to `$1`, `$2`, ... from left to right.
 * A `?` inside a string, a quoted identifier, a comment, or a dollar-quoted body stays as it is.
 * Plain strings escape only `''`, as `standard_conforming_strings` requires.
 * `E'...'` strings honor backslash escapes too.
 *
 * @example
 * ```ts
 * numberPlaceholders('SELECT ? + ?')                 // -> 'SELECT $1 + $2'
 * numberPlaceholders(`SELECT '?', "a?" FROM t -- ?`) // -> `SELECT '?', "a?" FROM t -- ?`
 * numberPlaceholders('SELECT $q$ ? $q$, ?')          // -> 'SELECT $q$ ? $q$, $1'
 * ```
 */
export function numberPlaceholders(sql: string): string {
  let numbered = '';
  let count = 0;
  let from = 0;
  let index = 0;
  while (index < sql.length) {
    if (sql[index] === '?') {
      numbered += `${sql.slice(from, index)}$${++count}`;
      from = ++index;
    } else {
      index = skipToken(sql, index);
    }
  }
  return numbered + sql.slice(from);
}

/**
 * Returns the index just past the token that starts at `index`.
 * Literals, quoted identifiers, and comments are one token each; anything else is one character.
 * An unterminated token runs to the end of `sql`.
 */
function skipToken(sql: string, index: number): number {
  const char = sql[index];
  const next = sql[index + 1];
  if (char === "'") return skipQuoted(sql, index, "'", isEscapeString(sql, index));
  if (char === '"') return skipQuoted(sql, index, '"', false);
  if (char === '-' && next === '-') return endOf(sql, sql.indexOf('\n', index), 1);
  if (char === '/' && next === '*') return skipBlockComment(sql, index);
  if (char === '$' && !IDENTIFIER_CHAR.test(sql[index - 1] ?? ''))
    return skipDollarQuoted(sql, index);
  return index + 1;
}

/**
 * Skips a literal opened by `quote` at `index`, where a doubled `quote` stands for itself.
 * With `backslashes`, a backslash also escapes the character after it.
 */
function skipQuoted(sql: string, index: number, quote: string, backslashes: boolean): number {
  let cursor = index + 1;
  while (cursor < sql.length) {
    const char = sql[cursor];
    if (backslashes && char === '\\') cursor += 2;
    else if (char !== quote) cursor += 1;
    else if (sql[cursor + 1] === quote) cursor += 2;
    else return cursor + 1;
  }
  return sql.length;
}

/**
 * Whether the `'` at `index` opens an `E'...'` string: an `E` before it that starts a token.
 */
function isEscapeString(sql: string, index: number): boolean {
  const prefix = sql[index - 1];
  return (prefix === 'E' || prefix === 'e') && !IDENTIFIER_CHAR.test(sql[index - 2] ?? '');
}

/**
 * Skips a `/* ... *\/` comment at `index`, which nests in Postgres.
 */
function skipBlockComment(sql: string, index: number): number {
  let depth = 0;
  COMMENT_MARK.lastIndex = index;
  for (let mark = COMMENT_MARK.exec(sql); mark; mark = COMMENT_MARK.exec(sql)) {
    depth += mark[0] === '/*' ? 1 : -1;
    if (depth === 0) return COMMENT_MARK.lastIndex;
  }
  return sql.length;
}

/**
 * Skips a `$tag$ ... $tag$` body at `index`, or the lone `$` when no tag opens there.
 */
function skipDollarQuoted(sql: string, index: number): number {
  DOLLAR_TAG.lastIndex = index;
  const tag = DOLLAR_TAG.exec(sql)?.[0];
  if (isUndefined(tag)) return index + 1;
  return endOf(sql, sql.indexOf(tag, index + tag.length), tag.length);
}

/**
 * The index past a closing delimiter of `length` found at `found`, or the end of `sql` when none was found.
 */
function endOf(sql: string, found: number, length: number): number {
  return found === -1 ? sql.length : found + length;
}
