import type {} from 'ohnejs';

declare module 'ohnejs' {
  interface KnownDialects {
    /**
     * Postgres, from `@ohnejs/pg`.
     */
    postgres: true;
  }
}
