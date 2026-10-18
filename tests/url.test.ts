import { strictEqual } from 'node:assert';
import { describe, it } from 'node:test';

import { isPostgresURL } from '../src/url.ts';

describe('isPostgresURL', () => {
  it('accepts both schemes in any case', () => {
    strictEqual(isPostgresURL('postgres://localhost/app'), true);
    strictEqual(isPostgresURL('postgresql://u:p@db.internal:5433/app?sslmode=require'), true);
    strictEqual(isPostgresURL('POSTGRES://localhost/app'), true);
    strictEqual(isPostgresURL('postgres:///app?host=/var/run/postgresql'), true);
  });

  it('refuses SQLite targets and other schemes', () => {
    strictEqual(isPostgresURL(':memory:'), false);
    strictEqual(isPostgresURL('file:data.db'), false);
    strictEqual(isPostgresURL('.data/ohne.db'), false);
    strictEqual(isPostgresURL('mysql://localhost/app'), false);
    strictEqual(isPostgresURL('postgres:localhost/app'), false);
    strictEqual(isPostgresURL(' postgres://localhost/app'), false);
  });
});
