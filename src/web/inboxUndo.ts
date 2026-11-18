import { html, type SafeHtml } from './html.js';

/** How long Undo stays valid after an answer in the Inbox. */
export const UNDO_WINDOW_MS = 2 * 60_000;

/** The one answer just given: what the status line says, and what Undo would revert (nothing, when it cannot be). */
export interface Decision {
  id: string;
  at: number;
  message: string;
  /** What Undo reverts; absent when this answer cannot be cleanly reverted. */
  undo?: { kind: 'reject-suggestion' } | { kind: 'approve-add'; memoryId: string } | { kind: 'reject-proposal' } | { kind: 'tidy-approved' } | { kind: 'tidy-rejected' };
  /** The status line has been shown once. */
  shown: boolean;
}

const slots = new WeakMap<object, Decision>();

/** Remembers the answer just given (replacing the one before: only the latest item can be undone). */
export function noteDecision(owner: object, d: Omit<Decision, 'shown'>): void {
  slots.set(owner, { ...d, shown: false });
}

/** The decision Undo may revert: the one for `id`, still inside the window. */
export function undoable(owner: object, id: string, now: number): Decision | undefined {
  const d = slots.get(owner);
  return d && d.id === id && d.undo && now - d.at <= UNDO_WINDOW_MS ? d : undefined;
}

export function clearDecision(owner: object): void { slots.delete(owner); }

/** The status line for the next screen, once (a refresh does not repeat it); null when there is none. */
export function takeStatusLine(owner: object, now: number): SafeHtml | null {
  const d = slots.get(owner);
  if (!d || d.shown || now - d.at > UNDO_WINDOW_MS) return null;
  d.shown = true;
  const undo = d.undo ? html` <form method="post" action="/inbox/undo"><input type="hidden" name="id" value="${d.id}"><button type="submit" class="linklike">Undo</button></form>` : '';
  return html`<div class="notice undo-line" role="status"><span>${d.message}</span>${undo}</div>`;
}
