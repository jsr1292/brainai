/**
 * Whether this app is being removed right now (desktop only). From the moment the removal starts, before the saved
 * copy is taken, nothing may be written any more: a write after the copy would be deleted with the data folder.
 * Process-wide on purpose: the MCP endpoint and the dashboard both read it. Cleared when the removal fails before
 * its end, or when the owner cancels the app's last confirmation.
 */
let removing = false;

export const isRemoving = (): boolean => removing;
export const setRemoving = (on: boolean): void => { removing = on; };

let writing = 0;
/** Write-tool calls in progress (counted by the MCP guard once it let them through), so a removal can wait for them before the copy. */
export const beginWrite = (): void => { writing++; };
export const endWrite = (): void => { writing--; };
export const writesInFlight = (): number => writing;
/** Resolves true once no write is in progress, false if some still are after `limitMs`. */
export async function writesDrained(limitMs: number, pollMs = 50): Promise<boolean> {
  const until = Date.now() + limitMs;
  while (writing > 0) {
    if (Date.now() >= until) return false;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return true;
}

/** What a removal had already taken out when the owner said no to its last confirmation, for the one notice on Settings › Tools. */
export interface CancelNotice { tools: string[]; reach: boolean; hooks: boolean }
let notice: CancelNotice | null = null;
export const setCancelNotice = (n: CancelNotice | null): void => { notice = n; };
/** The notice once, then nothing; null when nothing was taken out. */
export function takeCancelNotice(): CancelNotice | null {
  const n = notice;
  notice = null;
  return n && (n.tools.length > 0 || n.reach || n.hooks) ? n : null;
}
