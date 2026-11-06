import { STOPWORDS } from '../memory/stopwords.js';
import { plainText } from '../pages/markdown.js';

/** Lowercase, no accents, words (letters and digits of any script) separated by single spaces: the search normalisation. */
export const normalWords = (s: string): string =>
  s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/** The words of a text that can explain a thread: no stopwords, nothing under 3 letters, none of `exclude`. */
export function wordList(text: string, exclude: ReadonlySet<string>): string[] {
  return normalWords(text).split(' ').filter((w) => w.length >= 3 && !STOPWORDS.has(w) && !exclude.has(w));
}

/**
 * A page section as words for threads: its heading and text with fenced code blocks (``` or ~~~ up to the closing
 * fence) left out, so diagrams and code never make two projects look related.
 */
export function sectionText(heading: string, text: string): string {
  const kept: string[] = [];
  let fence: { char: string; len: number } | null = null;
  for (const line of text.split('\n')) {
    const m = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (m && m[1]![0] === fence.char && m[1]!.length >= fence.len && line.trim() === m[1]) fence = null;
      continue;
    }
    if (m) { fence = { char: m[1]![0]!, len: m[1]!.length }; continue; }
    kept.push(line);
  }
  return plainText(`${heading}\n${kept.join('\n')}`, 4000);
}

/**
 * How many items each word appears in, for rarity. Built once from every current item and added to as items are
 * re-indexed; never subtracted until a restart (an edited item's old words stay counted, which barely moves a weight).
 */
export class WordCounts {
  private counts = new Map<string, number>();
  private n = 0;

  add(text: string): void {
    this.n++;
    for (const w of new Set(wordList(text, new Set()))) this.counts.set(w, (this.counts.get(w) ?? 0) + 1);
  }

  get items(): number {
    return this.n;
  }

  df(word: string): number {
    return this.counts.get(word) ?? 0;
  }

  /** Smoothed, so a word no item had yet (it came in through an edit) still gets a finite number. */
  rarity(word: string): number {
    return Math.log((this.n + 1) / (this.df(word) + 1));
  }
}

export const WORD_BAR = 1.0;
export const MAX_WORDS = 2;

/**
 * Up to two words that say why two projects are related: words on both sides, scored by how often they appear on the
 * side where they are rarer times how rare they are across all items. Only words that clear WORD_BAR.
 */
export function threadWords(sideA: readonly string[], sideB: readonly string[], counts: WordCounts, exclude: ReadonlySet<string>): string[] {
  const tf = (side: readonly string[]) => {
    const m = new Map<string, number>();
    for (const t of side) for (const w of wordList(t, exclude)) m.set(w, (m.get(w) ?? 0) + 1);
    return m;
  };
  const a = tf(sideA);
  const b = tf(sideB);
  const scored: { w: string; s: number }[] = [];
  for (const [w, ta] of a) {
    const tb = b.get(w);
    if (tb === undefined) continue;
    const s = Math.min(ta, tb) * counts.rarity(w);
    if (s >= WORD_BAR) scored.push({ w, s });
  }
  scored.sort((x, y) => y.s - x.s || (x.w < y.w ? -1 : x.w > y.w ? 1 : 0));
  return scored.slice(0, MAX_WORDS).map((x) => x.w);
}
