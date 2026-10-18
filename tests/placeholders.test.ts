import { strictEqual } from 'node:assert';
import { describe, it } from 'node:test';

import { numberPlaceholders } from '../src/placeholders.ts';

describe('numberPlaceholders', () => {
  it('numbers placeholders left to right', () => {
    strictEqual(numberPlaceholders('SELECT ? + ?, ?'), 'SELECT $1 + $2, $3');
    strictEqual(numberPlaceholders('?'), '$1');
    strictEqual(numberPlaceholders('SELECT 1'), 'SELECT 1');
  });

  it('skips plain strings, where only a doubled quote escapes', () => {
    strictEqual(numberPlaceholders(`SELECT '?', ?`), `SELECT '?', $1`);
    strictEqual(numberPlaceholders(`SELECT 'it''s ?', ?`), `SELECT 'it''s ?', $1`);
    strictEqual(
      numberPlaceholders(String.raw`SELECT 'a\', ?, '?'`),
      String.raw`SELECT 'a\', $1, '?'`,
    );
  });

  it('skips escape strings with backslash escapes', () => {
    strictEqual(numberPlaceholders(String.raw`SELECT E'\' ?', ?`), String.raw`SELECT E'\' ?', $1`);
    strictEqual(
      numberPlaceholders(String.raw`SELECT e'it''s \\', ?`),
      String.raw`SELECT e'it''s \\', $1`,
    );
  });

  it('reads a quote after an identifier ending in `E` as a plain string', () => {
    strictEqual(numberPlaceholders(String.raw`SELECT CASE'\', ?`), String.raw`SELECT CASE'\', $1`);
  });

  it('skips Unicode strings like plain ones', () => {
    strictEqual(
      numberPlaceholders(String.raw`SELECT U&'\0041 ?', ?`),
      String.raw`SELECT U&'\0041 ?', $1`,
    );
  });

  it('skips quoted identifiers with doubled quotes', () => {
    strictEqual(
      numberPlaceholders('SELECT "a?" FROM "t""?" WHERE x = ?'),
      'SELECT "a?" FROM "t""?" WHERE x = $1',
    );
  });

  it('skips line comments to the end of the line', () => {
    strictEqual(numberPlaceholders('SELECT ? -- why?\n, ?'), 'SELECT $1 -- why?\n, $2');
    strictEqual(numberPlaceholders('SELECT ? -- why?'), 'SELECT $1 -- why?');
  });

  it('skips nested block comments', () => {
    strictEqual(numberPlaceholders('SELECT /* ? /* ? */ ? */ ?'), 'SELECT /* ? /* ? */ ? */ $1');
    strictEqual(numberPlaceholders('SELECT 2/?'), 'SELECT 2/$1');
  });

  it('skips dollar-quoted bodies, tagged or not', () => {
    strictEqual(numberPlaceholders('SELECT $$ ? $$, ?'), 'SELECT $$ ? $$, $1');
    strictEqual(numberPlaceholders('SELECT $fn$ ? $x$ ? $fn$, ?'), 'SELECT $fn$ ? $x$ ? $fn$, $1');
  });

  it('reads a `$` inside an identifier as part of it', () => {
    strictEqual(
      numberPlaceholders('SELECT "UX__a$b" FROM a$b$ WHERE x = ? AND y$ = ?'),
      'SELECT "UX__a$b" FROM a$b$ WHERE x = $1 AND y$ = $2',
    );
  });

  it('leaves positional parameters alone', () => {
    strictEqual(numberPlaceholders('SELECT $1, ?'), 'SELECT $1, $1');
  });

  it('runs an unterminated token to the end', () => {
    strictEqual(numberPlaceholders(`SELECT ?, '?`), `SELECT $1, '?`);
    strictEqual(numberPlaceholders('SELECT ?, /* ?'), 'SELECT $1, /* ?');
    strictEqual(numberPlaceholders('SELECT ?, $q$ ?'), 'SELECT $1, $q$ ?');
  });
});
