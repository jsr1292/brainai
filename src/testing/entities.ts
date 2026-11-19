/**
 * Test helper: turns the HTML entities of a rendered page back into characters (`&#39;` to `'`, `&quot;` to `"`). The `html` tag
 * escapes quotes so a catalog sentence is safe in an attribute; a test that matches an English sentence with an apostrophe
 * decodes the page first: `assert.match(decodeEntities(body), /doesn't/)`.
 */
const NAMED: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', mdash: '—', ndash: '–', middot: '·', rsaquo: '›', lsaquo: '‹',
  raquo: '»', laquo: '«', copy: '©', rarr: '→', larr: '←', times: '×', bull: '•', check: '✓', ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’',
  euro: '€', trade: '™', reg: '®', deg: '°',
};
/** Named entities (the table above) and numeric ones, decimal and hex. An unknown name stays as written. */
export function decodeEntities(s: string): string {
  return s.replace(/&(?:#(\d+)|#[xX]([0-9a-fA-F]+)|([a-zA-Z][a-zA-Z0-9]*));/g, (m, dec?: string, hex?: string, name?: string) => {
    if (name !== undefined) return NAMED[name] ?? m;
    const code = dec !== undefined ? Number(dec) : parseInt(hex!, 16);
    return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : m;
  });
}


/** A page without its embedded client catalog (`<script type="application/json" id="i18n">`): that block holds every browser string in both "this Mac" and "this computer" forms, so a test of what the page says must not read it. */
export const withoutClientCatalog = (page: string): string => page.replace(/<script type="application\/json" id="i18n">[\s\S]*?<\/script>/, '');
