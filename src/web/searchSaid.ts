/** What Settings › Search last did, said once on the page it returns to. Kept here, never taken from the URL. */
let said: { text: string; at: number } | null = null;

export function saySearch(text: string): void {
  said = { text, at: Date.now() };
}

export function takeSearchSaid(): string | null {
  const s = said;
  said = null;
  return s && Date.now() - s.at < 120_000 ? s.text : null;
}
