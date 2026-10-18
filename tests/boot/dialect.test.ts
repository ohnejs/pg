import { ok } from 'node:assert';
import { describe, it } from 'node:test';
import { useDialects } from 'ohnejs';

import '../../boot/dialect.ts';
import { PostgresDialect } from '../../src/dialect.ts';

describe('boot/dialect', () => {
  it('registers a PostgresDialect as postgres', () => {
    ok(useDialects().get('postgres') instanceof PostgresDialect);
  });
});
