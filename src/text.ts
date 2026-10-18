/**
 * The SQL twin of `foldCase` over `column`, step for step.
 * It runs inline, so connecting creates no function and needs no privilege.
 * `und-x-icu` lowercases every script without a locale, as JavaScript does; under `C` only ASCII would fold.
 * `й`, `ї`, and `ў` hide in private-use code points while the accents drop, then come back.
 */
export function foldExpression(column: string): string {
  const hidden = String.raw`translate(normalize(${column}, NFC), 'ЙЇЎйїў', U&'\E000\E001\E002\E000\E001\E002')`;
  const unmarked = String.raw`regexp_replace(normalize(${hidden}, NFKD), '[\u0300-\u036f]', '', 'g')`;
  const lowered = `lower(normalize(${unmarked}, NFC) COLLATE "und-x-icu")`;
  const spelled = `translate(${lowered}, 'øđłıðς', 'odlidσ')`;
  const expanded = `replace(replace(replace(replace(${spelled}, 'ß', 'ss'), 'æ', 'ae'), 'œ', 'oe'), 'þ', 'th')`;
  return String.raw`translate(${expanded}, U&'\E000\E001\E002', 'йїў')`;
}
