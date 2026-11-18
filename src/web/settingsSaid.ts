/** What a Settings action just did (Back up now, the second folder), said once on the section it returns to. Kept here, never taken from the URL. */
export type SaidWhere = 'backup-now' | 'backup-copy';
const said = new Map<SaidWhere, { text: string; at: number }>();

export function saySettings(where: SaidWhere, text: string): void {
  said.set(where, { text, at: Date.now() });
}

/** The line for `where`, once. */
export function takeSettingsSaid(where: SaidWhere): string | null {
  const s = said.get(where);
  said.delete(where);
  return s && Date.now() - s.at < 120_000 ? s.text : null;
}
