/**
 * The Markdown line for a picture (round 2 section 12): `![description](/images/<id>.<ext> "caption")`. The description
 * and caption can't break out of it: brackets and line breaks become spaces, a double quote in the caption a single one.
 */
export const MAX_DESCRIPTION = 300;

// A backslash would escape the closing bracket or quote, and a backtick could open a code span over the address.
export const cleanAlt = (raw: string): string => raw.replace(/[[\]\r\n\\`]+/g, ' ').replace(/ {2,}/g, ' ').trim().slice(0, MAX_DESCRIPTION);
export const cleanTitle = (raw: string): string => raw.replace(/[\r\n\\`]+/g, ' ').replace(/"/g, "'").replace(/ {2,}/g, ' ').trim().slice(0, MAX_DESCRIPTION);

export function pictureLine(alt: string, img: { id: string; ext: string }, title?: string | null): string {
  const t = title ? cleanTitle(title) : '';
  return `![${cleanAlt(alt)}](/images/${img.id}.${img.ext}${t ? ` "${t}"` : ''})`;
}
