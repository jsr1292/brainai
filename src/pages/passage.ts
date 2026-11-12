/*
 * B10: the passage of a page section that matched a search: the window of about 300 characters with the most words of
 * the query (case and accents aside), cut at spaces and marked with "…". With no word of the query in it, the section's
 * first lines, as before.
 */
import { STOPWORDS } from '../memory/stopwords.js';
import { plainText } from './markdown.js';

const SIZE = 300;
/** Room left before the first match, so the passage reads from a little before it. */
const LEAD = 60;

/** One UTF-16 unit, lower case and without its accent; the same length as the text it came from, so indexes carry over. */
const foldUnit = (c: string) => (c.normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase()[0] ?? c);
const foldWord = (w: string) => w.normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase();

/** The words of a query worth finding: as the keyword search splits them, two letters or more, no filler. */
function terms(query: string): string[] {
  return [...new Set(foldWord(query).split(/[^\p{L}\p{N}]+/u).filter((t) => t.length >= 2 && !STOPWORDS.has(t)))];
}

/** At most this much of a section is searched for the passage: plainText's patterns slow down on huge unclosed marks. */
const SCAN = 20_000;
/** At most this many matches are weighed (a two-letter word can match thousands of times). */
const MAX_HITS = 2_000;

/** The passage of a section's Markdown that best matches the query, as plain text. */
export function passage(md: string, query: string, size = SIZE): string {
  // Plain text first: links, emphasis and code marks are gone, so a window can never cut a [[link]] in two.
  const scanned = md.length > SCAN ? md.slice(0, SCAN) : md;
  const text = plainText(scanned, Math.max(scanned.length, size));
  if (text.length <= size) return text;
  const folded = Array.from({ length: text.length }, (_, i) => foldUnit(text[i]!)).join('');
  const hits: { at: number; term: number }[] = [];
  terms(query).forEach((t, term) => {
    for (let at = folded.indexOf(t); at >= 0 && hits.length < MAX_HITS; at = folded.indexOf(t, at + 1)) hits.push({ at, term });
  });
  if (hits.length === 0) return plainText(md, size);
  hits.sort((a, b) => a.at - b.at);
  // The window holding the most different query words, then the most hits; the earliest on a tie. Two pointers over
  // the sorted hits, with a count per word, so this stays linear however many hits there are.
  let best = { start: 0, distinct: -1, count: -1 };
  const per = new Map<number, number>();
  let hi = 0;
  for (let lo = 0; lo < hits.length; lo++) {
    const start = Math.max(0, Math.min(hits[lo]!.at - LEAD, text.length - size));
    while (hi < hits.length && hits[hi]!.at < start + size) { per.set(hits[hi]!.term, (per.get(hits[hi]!.term) ?? 0) + 1); hi++; }
    const inside = hi - lo;
    const distinct = per.size;
    if (distinct > best.distinct || (distinct === best.distinct && inside > best.count)) best = { start, distinct, count: inside };
    const left = hits[lo]!.term;
    const n = (per.get(left) ?? 1) - 1;
    if (n === 0) per.delete(left); else per.set(left, n);
  }
  let start = best.start;
  let end = Math.min(text.length, start + size);
  // Cut at spaces, so no word (and no character made of two units) is split.
  if (start > 0) { const sp = text.indexOf(' ', start); start = sp >= 0 && sp < end ? sp + 1 : start; }
  if (end < text.length) { const sp = text.lastIndexOf(' ', end); end = sp > start ? sp : end; }
  if (/[\uDC00-\uDFFF]/.test(text[start] ?? '')) start += 1;
  if (/[\uD800-\uDBFF]/.test(text[end - 1] ?? '')) end -= 1;
  return `${start > 0 ? '…' : ''}${text.slice(start, end).trim()}${end < text.length ? '…' : ''}`;
}
