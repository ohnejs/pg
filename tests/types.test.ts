import { deepStrictEqual, strictEqual } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import { Pool, types } from 'pg';

import { typeParsers } from '../src/types.ts';
import { testURL } from './_postgres.ts';

describe('typeParsers', () => {
  const parseInt8 = typeParsers.getTypeParser(types.builtins.INT8);

  it('parses a safe `int8` into a number', () => {
    strictEqual(parseInt8('42'), 42);
    strictEqual(parseInt8('-9007199254740991'), -9007199254740991);
    strictEqual(parseInt8('9007199254740991'), 9007199254740991);
  });

  it('keeps an unsafe `int8` as its text', () => {
    strictEqual(parseInt8('9007199254740992'), '9007199254740992');
    strictEqual(parseInt8('-9223372036854775808'), '-9223372036854775808');
  });

  it('parses a `numeric` within the safe integers into a number', () => {
    const parseNumeric = typeParsers.getTypeParser(types.builtins.NUMERIC);
    strictEqual(parseNumeric('21'), 21);
    strictEqual(parseNumeric('5.2500000000000000'), 5.25);
    strictEqual(parseNumeric('-9007199254740991'), -9007199254740991);
  });

  it('keeps a `numeric` beyond the safe integers or without a value as its text', () => {
    const parseNumeric = typeParsers.getTypeParser(types.builtins.NUMERIC);
    strictEqual(parseNumeric('9007199254740992'), '9007199254740992');
    strictEqual(parseNumeric('-9007199254740991.5'), '-9007199254740991.5');
    strictEqual(parseNumeric('NaN'), 'NaN');
    strictEqual(parseNumeric('Infinity'), 'Infinity');
  });

  it("keeps `pg`'s parser for every other type", () => {
    strictEqual(typeParsers.getTypeParser(types.builtins.BOOL)('t'), true);
    strictEqual(typeParsers.getTypeParser(types.builtins.INT4)('7'), 7);
    strictEqual(typeParsers.getTypeParser(types.builtins.TEXT)('42'), '42');
  });

  describe('on a pool', () => {
    let pool: Pool;

    before(() => {
      pool = new Pool({ connectionString: testURL, types: typeParsers, max: 1 });
    });

    after(() => pool.end());

    it('reads `int8` columns through the parser', async () => {
      const { rows } = await pool.query(
        `SELECT 42::int8 AS "safe", 9007199254740993::int8 AS "unsafe", count(*) AS "count" FROM (VALUES (1), (2)) AS v`,
      );
      deepStrictEqual({ ...rows[0] }, { safe: 42, unsafe: '9007199254740993', count: 2 });
    });

    it('reads aggregates over `int8` and numeric literals as numbers', async () => {
      const { rows } = await pool.query(
        `SELECT sum(v) AS "sum", avg(v) AS "avg", sum(v) / count(*) AS "ratio", 2.5 AS "literal" FROM (VALUES (1::int8), (2::int8), (8::int8), (10::int8)) AS t(v)`,
      );
      deepStrictEqual({ ...rows[0] }, { sum: 21, avg: 5.25, ratio: 5.25, literal: 2.5 });
    });

    it('leaves the global parsers alone', () => {
      strictEqual(types.getTypeParser(types.builtins.INT8)('42'), '42');
      strictEqual(types.getTypeParser(types.builtins.NUMERIC)('2.5'), '2.5');
    });
  });
});
