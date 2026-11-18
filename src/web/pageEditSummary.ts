/** Activity: what a page edit changed, in a few words: the section it happened in and the first changed line. */
export interface PageEditSummary { heading: string | null; line: string | null }

const SHORT = 110;
const trim = (s: string): string => { const t = s.replace(/\s+/g, ' ').trim(); return t.length > SHORT ? `${t.slice(0, SHORT).replace(/\s+\S*$/, '')}…` : t; };

/** Compares two versions of a page body line by line from the top; null when the text is the same. */
export function pageEditSummary(before: string, after: string): PageEditSummary | null {
  const a = before.split('\n'), b = after.split('\n');
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  if (i >= a.length && i >= b.length) return null;
  // Past the end of the new text the edit removed lines: name the section they were in.
  const inNew = i < b.length;
  const lines = inNew ? b : a;
  let at = Math.min(i, lines.length - 1);
  if (inNew) while (at < lines.length - 1 && lines[at]!.trim() === '') at++;
  let heading: string | null = null;
  for (let j = at; j >= 0; j--) {
    const h = /^ {0,3}#{1,6}[ \t]+(.*?)[ \t#]*$/.exec(lines[j]!);
    if (h?.[1]) { heading = h[1].replace(/[*_`]/g, '').trim(); break; }
  }
  const isHeading = (l: string) => /^ {0,3}#{1,6}[ \t]/.test(l);
  const changed = inNew ? lines.slice(i).find((l) => l.trim() !== '' && !isHeading(l)) : undefined;
  return { heading: heading ? trim(heading) : null, line: inNew ? (changed ? trim(changed) : null) : 'Removed text' };
}
