import { deepStrictEqual } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

describe('known-dialects', () => {
  it('imports nothing but `ohnejs`, so an app type-checks without the driver types', async () => {
    const source = await readFile(new URL('../src/known-dialects.ts', import.meta.url), 'utf8');
    const specifiers = [...source.matchAll(/\bfrom\s+'([^']+)'|\bimport\s+'([^']+)'/g)].map(
      (match) => match[1] ?? match[2],
    );
    deepStrictEqual(specifiers, ['ohnejs']);
  });
});
