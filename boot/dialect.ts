import { useDialects } from 'ohnejs';

import { PostgresDialect } from '../src/dialect.ts';

useDialects().register('postgres', new PostgresDialect());
