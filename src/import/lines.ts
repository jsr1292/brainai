/**
 * Guided import (C1): a pasted memory export becomes candidate lines. Pure text work; nothing here saves or sends.
 */
import { looksLikeSecret } from '../memory/secrets.js';

/** Most lines taken from one paste. */
export const MAX_PASTE_LINES = 200;
/** Fewest characters a line needs to count as a fact. */
export const MIN_LINE_CHARS = 12;
/** Most facts one import saves (the first import). */
export const MAX_IMPORT_ROWS = 100;
/** Longest candidate line (a fact is at most 1000 characters; longer lines are cut off at a word, not dropped). */
const MAX_LINE_CHARS = 1000;

export interface Candidates {
  lines: string[];
  /** Lines refused because they look like a secret. */
  secrets: number;
  /** Lines left out as empty, too short or headings. */
  skipped: number;
  /** Lines past the cap of MAX_PASTE_LINES. */
  overCap: number;
}

/** Bullets, numbering, dates in brackets (ChatGPT's "[2025-01-02]") and quote marks in front of a line. */
function clean(raw: string): string {
  let s = raw.replace(/ /g, ' ').trim();
  for (let i = 0; i < 3; i++) {
    s = s.replace(/^(?:[-*•–—·▪●○◦>]+|\d{1,3}[.)]|\(\d{1,3}\)|#{1,6})\s+/, '')
      .replace(/^\[\d{4}-\d{2}-\d{2}[^\]]*\]\s*[:\-–]?\s*/, '')
      .trim();
  }
  return s.replace(/\s+/g, ' ');
}

/** A heading such as "Work:" or "## Preferences": a short line ending in a colon. */
const isHeading = (original: string, cleaned: string): boolean => /^#{1,6}\s/.test(original.trim()) || (cleaned.endsWith(':') && cleaned.length < 40);

export function splitCandidates(text: string): Candidates {
  const out: Candidates = { lines: [], secrets: 0, skipped: 0, overCap: 0 };
  const seen = new Set<string>();
  for (const original of text.replace(/\r\n?/g, '\n').split('\n')) {
    if (original.trim() === '') continue;
    let line = clean(original);
    if (line.length < MIN_LINE_CHARS || isHeading(original, line) || /^```/.test(line)) { out.skipped++; continue; }
    if (line.length > MAX_LINE_CHARS) line = line.slice(0, MAX_LINE_CHARS).replace(/\s+\S*$/, '');
    if (looksLikeSecret(line) !== null) { out.secrets++; continue; }
    const key = line.toLowerCase();
    if (seen.has(key)) { out.skipped++; continue; }
    seen.add(key);
    if (out.lines.length >= MAX_PASTE_LINES) { out.overCap++; continue; }
    out.lines.push(line);
  }
  return out;
}

/** A line about the person themselves ("I live in…", "My sister…", "User prefers…", "Prefers…") is a profile fact; anything else a decision. */
const ABOUT_USER = /^(?:i|i'm|i’m|i've|i’ve|i'd|i’d|my|me|user|the user|prefers?|likes?|dislikes?|lives? in|name is)\b/i;
export function guessKind(line: string): 'profile' | 'decision' {
  return ABOUT_USER.test(line.trim()) ? 'profile' : 'decision';
}
