import type { DB } from '../db.js';

/*
 * Which facts count as current, for the graph: not deleted and not replaced (section 16, done here):
 *   - isCurrentFactSql has `AND NOT EXISTS (SELECT 1 FROM supersessions s WHERE s.old_id = <alias>.id AND s.undone_at IS NULL)`;
 *   - graphCacheKey has the supersessions MAX(id) and the count of undone rows (a replacement or its undo writes no
 *     history row, so nothing else here would change);
 *   - undoing a replacement calls MeaningHook.factsBroughtBack, which is refresh(keys, { force: true }).
 * Every fact count, decision callout and thread read of the graph goes through isCurrentFactSql; nothing else in
 * src/graph decides it. Replaced facts never appear in the graph.
 */

/** The one place the graph decides which facts count: an SQL condition on the memories row named `alias`. */
export function isCurrentFactSql(alias: string): string {
  return `${alias}.deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM supersessions s WHERE s.old_id = ${alias}.id AND s.undone_at IS NULL)`;
}

/**
 * The key of the thread cache: changes whenever an item is (re-)indexed, a fact is saved, edited, moved, forgotten or
 * brought back, a page changes, or an alias is added. Never memoryVersion() (a recall changes that) and no date.
 */
export function graphCacheKey(db: DB): string {
  return JSON.stringify(db.prepare(`SELECT
    (SELECT COUNT(*) FROM meaning_indexed) AS mi, (SELECT MAX(indexed_at) FROM meaning_indexed) AS mia, (SELECT MAX(rowid) FROM meaning_indexed) AS mir,
    (SELECT COUNT(*) FROM memories m WHERE ${isCurrentFactSql('m')}) AS m, (SELECT MAX(id) FROM memory_history) AS h,
    (SELECT COUNT(*) FROM pages WHERE deleted_at IS NULL) AS p, (SELECT MAX(updated_at) FROM pages) AS pu,
    (SELECT COUNT(*) FROM project_aliases) AS a, (SELECT MAX(added_at) FROM project_aliases) AS aa,
    (SELECT MAX(id) FROM supersessions) AS ss, (SELECT COUNT(*) FROM supersessions WHERE undone_at IS NOT NULL) AS su`).get());
}

/** Current facts per real project (profile facts counted on their own, facts with no project left out). */
export function currentFactCounts(db: DB): { byProject: Map<string, number>; profile: number } {
  const rows = db.prepare(`SELECT COALESCE(a.project, m.project) AS project, COUNT(*) AS n FROM memories m
    LEFT JOIN project_aliases a ON a.alias = m.project
    WHERE ${isCurrentFactSql('m')} AND m.kind != 'profile' AND m.project IS NOT NULL
    GROUP BY COALESCE(a.project, m.project)`).all() as { project: string; n: number }[];
  const profile = (db.prepare(`SELECT COUNT(*) AS n FROM memories m WHERE ${isCurrentFactSql('m')} AND m.kind = 'profile'`).get() as { n: number }).n;
  return { byProject: new Map(rows.map((r) => [r.project, r.n])), profile };
}

/** The newest current decisions filed under any of `projects` (statuses, tagged or not, and roadmaps left out). */
export function newestCurrentDecisions(db: DB, projects: readonly string[], limit: number): { id: string; content: string }[] {
  if (projects.length === 0) return [];
  return db.prepare(`SELECT m.id, m.content FROM memories m
    WHERE ${isCurrentFactSql('m')} AND m.kind = 'decision' AND m.project IN (${projects.map(() => '?').join(', ')})
      AND NOT EXISTS (SELECT 1 FROM json_each(m.tags) t WHERE t.value = 'status')
    ORDER BY m.created_at DESC, m.rowid DESC LIMIT ?`).all(...projects, limit) as { id: string; content: string }[];
}
