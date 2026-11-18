/**
 * "Worked a lot, saved nothing" (B1 capture): an app that read the memory many times in the last week but never saved
 * anything is probably not being reminded to. Worked out from the tool-call log (who called what, never the arguments),
 * only when Settings renders.
 */
/** Memory reads at which an app counts as having used the memory a lot. */
export const QUIET_READS = 20;
export const QUIET_WINDOW_DAYS = 7;
/** Calls that read the memory. load_profile and list_skills are not counted: every conversation starts with them. */
const READS = new Set(['recall', 'project_brief', 'recent_work', 'whats_left', 'read_page', 'list_pages', 'list_projects']);
/** Calls that put something in (or hold something for the owner). */
const SAVES = new Set(['remember', 'update_memory', 'suggest_memories']);

export interface QuietApp { app: string; reads: number }

/** `calls`: the log's rows for the window, per app and tool. `connected`: the names of the live connections (others are left out). */
export function quietApps(calls: { client: string; tool: string; count: number }[], connected: string[]): QuietApp[] {
  const live = new Set(connected.map((n) => n.toLowerCase()));
  const by = new Map<string, { reads: number; saves: number }>();
  for (const c of calls) {
    const x = by.get(c.client) ?? { reads: 0, saves: 0 };
    if (READS.has(c.tool)) x.reads += c.count;
    if (SAVES.has(c.tool)) x.saves += c.count;
    by.set(c.client, x);
  }
  return [...by]
    .filter(([app, x]) => live.has(app.toLowerCase()) && x.reads >= QUIET_READS && x.saves === 0)
    .map(([app, x]) => ({ app, reads: x.reads }))
    .sort((a, b) => b.reads - a.reads || a.app.localeCompare(b.app));
}
