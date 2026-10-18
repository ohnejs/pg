import type { CustomTypesConfig } from 'pg';

import { coerceToNumber, isNumber } from 'ohnejs/utils';
import { types } from 'pg';

const NUMBERS = new Set<number>([types.builtins.INT8, types.builtins.NUMERIC]);

/**
 * The type parsers every pool reads its rows with, handed to the pool instead of changed globally.
 * An `int8` or a `numeric`, such as a `sum` or an `avg` over an integer column, becomes a number.
 * It stays its text when its magnitude passes `Number.MAX_SAFE_INTEGER` or it is `NaN` or infinite.
 * Every other type keeps `pg`'s own parser.
 *
 * @example
 * ```ts
 * typeParsers.getTypeParser(types.builtins.INT8)('42')                    // -> 42
 * typeParsers.getTypeParser(types.builtins.INT8)('9007199254740993')      // -> '9007199254740993'
 * typeParsers.getTypeParser(types.builtins.NUMERIC)('5.2500000000000000') // -> 5.25
 * ```
 */
export const typeParsers: CustomTypesConfig = {
  getTypeParser(id, format) {
    return NUMBERS.has(id) && format !== 'binary' ? parseNumber : types.getTypeParser(id, format);
  },
};

/**
 * Parses number text into a number when its integer part loses no precision, else returns the text.
 */
function parseNumber(text: string): number | string {
  const value = coerceToNumber(text);
  return isNumber(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER ? value : text;
}
