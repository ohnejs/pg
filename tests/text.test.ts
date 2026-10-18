import { deepStrictEqual } from 'node:assert';
import { describe, it } from 'node:test';
import { foldCase } from 'ohnejs/utils';

import { foldExpression } from '../src/text.ts';
import { testURL, withClient } from './_postgres.ts';

const SAMPLES = [
  'Hello World',
  'Café',
  `Cafe${String.fromCodePoint(0x301)}`,
  'Straße',
  'STRASSE',
  'ẞ',
  'İstanbul',
  'ıi',
  'ΣΟΦΙΑΣ',
  'σοφιας',
  'Łódź',
  'Þór',
  'Ðorđe',
  'Ørsted',
  'ÆSIR',
  'Œuvre',
  'ǅemal',
  'ﬁnance',
  'ﬀ',
  'Ｈｅｌｌｏ',
  'Йод',
  'ЇЖАК',
  'Ўсё',
  'Ёлка',
  'ガギグ',
  'ｶﾞｷﾞ',
  'パン',
  '한국어',
  'हिन्दी',
  '中文',
  'Ⅻ',
  '①',
];

const MARK_RANGES = [
  [0x300, 0x370],
  [0x8d3, 0x900],
  [0x1ab0, 0x1b00],
  [0x1dc0, 0x1e00],
  [0x20d0, 0x2100],
  [0xfe20, 0xfe30],
  [0xc0, 0x250],
];

/**
 * Folds every string on the server through `foldExpression`, in order.
 */
function serverFolds(strings: string[]): Promise<string[]> {
  return withClient(testURL, async (client) => {
    const { rows } = await client.query<{ folded: string }>(
      `SELECT ${foldExpression('"t"."value"')} AS "folded" ` +
        `FROM unnest($1::text[]) WITH ORDINALITY AS "t"("value", "n") ORDER BY "t"."n"`,
      [strings],
    );
    return rows.map(({ folded }) => folded);
  });
}

/**
 * A seeded generator of floats in `[0, 1)`, so a failing fuzz run reproduces.
 */
function seededRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
}

/**
 * `count` seeded strings of one to eight code points, each drawn by `point` from a float in `[0, 1)`.
 */
function fuzz(seed: number, count: number, point: (draw: number) => number): string[] {
  const random = seededRandom(seed);
  return Array.from({ length: count }, () => {
    const length = 1 + Math.floor(random() * 8);
    return String.fromCodePoint(...Array.from({ length }, () => point(random())));
  });
}

/**
 * Whether two folds differ only in the order of combining marks.
 * Node and Postgres ship different Unicode versions, and a mark one of them does not know never reorders.
 */
function isMarkReordering(expected: string, actual: string): boolean {
  const a = [...expected];
  const b = [...actual];
  if (a.length !== b.length || a.toSorted().join('') !== b.toSorted().join('')) return false;
  return a.every((char, i) => char === b[i] || (/\p{M}/u.test(char) && /\p{M}/u.test(b[i])));
}

/**
 * The strings whose server fold differs from `foldCase` beyond a reordering of marks.
 */
async function drift(strings: string[]): Promise<string[]> {
  const folds = await serverFolds(strings);
  return strings.filter((text, i) => {
    const expected = foldCase(text);
    return folds[i] !== expected && !isMarkReordering(expected, folds[i]);
  });
}

describe('foldExpression', () => {
  it('folds every sample exactly as `foldCase`', async () => {
    deepStrictEqual(await serverFolds(SAMPLES), SAMPLES.map(foldCase));
  });

  it('folds random non-ASCII BMP text as `foldCase`', async () => {
    const strings = fuzz(0x6f686e65, 3000, (draw) => {
      const point = 0x80 + Math.floor(draw * (0x10000 - 0x80 - 0x800));
      return point < 0xd800 ? point : point + 0x800;
    });
    deepStrictEqual(await drift(strings), []);
  });

  it('drifts from `foldCase` only in the order of combining marks', async () => {
    const strings = fuzz(1, 3000, (draw) => {
      const scaled = draw * MARK_RANGES.length;
      const [from, to] = MARK_RANGES[Math.floor(scaled)];
      return from + Math.floor((scaled % 1) * (to - from));
    });
    deepStrictEqual(await drift(strings), []);
  });
});
