/*
 * An assistant that marks a fact owner_said must quote the owner. A fact whose text also carries the assistant's own
 * suggestion ("I suggest restic ...") is not the owner's words alone: it is held for the owner instead of saved.
 * Conservative on purpose: first-person suggestion verbs and explicit "suggested by <assistant>" wording only, so
 * the owner's own decisions ("The owner decided to use B2") never match.
 */

export const MIXED_SOURCE_REASON = "Marked as your words but reads like it includes an assistant's suggestion";

const APP = 'assistant|claude(?:\\s+code)?|codex|chatgpt|grok|gemini|cursor|ai';
const SUGGESTION = new RegExp([
  '\\b(?:i|we)\\s+(?:would\\s+|also\\s+)?(?:suggest|recommend|propose)\\b',
  '\\bwe\\s+could\\s+(?:use|try|switch\\s+to|go\\s+with|set\\s+up|add)\\b',
  `\\b(?:suggested|recommended|proposed)\\s+by\\s+(?:the\\s+)?(?:${APP})\\b`,
  `\\b(?:${APP})['\\u2019]s\\s+(?:suggestion|recommendation)\\b`,
  '\\b(?:suggestion|recommendation)\\s*:',
  '\\bsuggested\\s+(?:tools?|approach|setup|options?|plan|stack|steps?|next\\s+steps?)\\b',
  '\\b(?:suggested|proposed|recommended)\\s*:',
  '\\b(?:herramienta|enfoque|opci[oó]n|plan)\\s+(?:sugerid[ao]|recomendad[ao]|propuest[ao])\\s*:',
  '\\bsugerid[ao]s?\\s*:',
  '\\bte\\s+sugiero\\b',
  '\\bsugerencia\\s*:',
  '\\brecomiendo\\b',
  `\\b(?:sugerido|recomendado|propuesto)\\s+por\\s+(?:el\\s+|la\\s+)?(?:asistente|ia|${APP})\\b`,
].join('|'), 'i');

const GLOBAL = new RegExp(SUGGESTION.source, 'gi');
const escapeRe = (t: string): string => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * `quote`: the owner's own words (source_note); wording inside them is the owner's, never a sign of mixing. Only a
 * quote of at least 3 words, found as whole words (any case), covers a match, and only a match entirely inside it:
 * a one-word quote such as "could" never hides a suggestion.
 */
export function looksLikeAssistantSuggestion(text: string, quote?: string | null): boolean {
  const q = quote?.trim() ?? '';
  const spans: [number, number][] = [];
  if (q.split(/\s+/).length >= 3) {
    const re = new RegExp(`(?<![\\p{L}\\p{N}_])${q.split(/\s+/).map(escapeRe).join('\\s+')}(?![\\p{L}\\p{N}_])`, 'giu');
    for (const m of text.matchAll(re)) spans.push([m.index, m.index + m[0].length]);
  }
  for (const m of text.matchAll(GLOBAL)) {
    const start = m.index, end = start + m[0].length;
    if (!spans.some(([a, b]) => start >= a && end <= b)) return true;
  }
  return false;
}
