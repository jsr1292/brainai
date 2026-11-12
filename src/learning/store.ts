/** The learning tables (migration 34): hand-set statuses with their history, "not now" snoozes, handbook topics. */
import type { DB } from '../db.js';
import type { CheckArea, CheckStatus, HandbookTopic, LessonLevel } from './types.js';

export interface CheckRow { project: string; area: CheckArea; status: CheckStatus; note: string | null; automatic: boolean; setBy: string; setAt: string; reportAtSet?: CheckStatus | null }

export class LearningStore {
  constructor(private db: DB) {}

  checks(project: string): CheckRow[] {
    return (this.db.prepare('SELECT project, area, status, note, automatic, set_by, set_at, report_at_set FROM project_checks WHERE project = ?').all(project) as
      { project: string; area: CheckArea; status: CheckStatus; note: string | null; automatic: number; set_by: string; set_at: string; report_at_set: CheckStatus | null }[])
      .map((r) => ({ project: r.project, area: r.area, status: r.status, note: r.note, automatic: r.automatic === 1, setBy: r.set_by, setAt: r.set_at, reportAtSet: r.report_at_set }));
  }

  put(r: CheckRow): void {
    this.db.transaction(() => {
      this.db.prepare(`INSERT INTO project_checks(project, area, status, note, automatic, set_by, set_at, report_at_set) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(project, area) DO UPDATE SET status = excluded.status, note = excluded.note, automatic = excluded.automatic,
          set_by = excluded.set_by, set_at = excluded.set_at, report_at_set = excluded.report_at_set`).run(r.project, r.area, r.status, r.note, r.automatic ? 1 : 0, r.setBy, r.setAt, r.reportAtSet ?? null);
      this.db.prepare('INSERT INTO project_check_history(project, area, status, note, set_by, set_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(r.project, r.area, r.status, r.note, r.setBy, r.setAt);
    })();
  }

  snoozes(project: string): Map<CheckArea, string> {
    return new Map((this.db.prepare('SELECT area, until FROM check_snoozes WHERE project = ?').all(project) as { area: CheckArea; until: string }[]).map((r) => [r.area, r.until]));
  }

  snooze(project: string, area: CheckArea, until: string, by: string): void {
    this.db.prepare(`INSERT INTO check_snoozes(project, area, until, set_by) VALUES (?, ?, ?, ?)
      ON CONFLICT(project, area) DO UPDATE SET until = excluded.until, set_by = excluded.set_by`).run(project, area, until, by);
  }

  topics(): HandbookTopic[] {
    return (this.db.prepare('SELECT slug, title, level, page_id, projects, updated_at FROM handbook_topics ORDER BY title').all() as
      { slug: string; title: string; level: LessonLevel; page_id: string | null; projects: string; updated_at: string }[])
      .map((r) => ({ slug: r.slug, title: r.title, level: r.level, pageId: r.page_id, projects: JSON.parse(r.projects) as string[], updatedAt: r.updated_at }));
  }

  putTopic(t: HandbookTopic): void {
    this.db.prepare(`INSERT INTO handbook_topics(slug, title, level, page_id, projects, updated_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(slug) DO UPDATE SET title = excluded.title, level = excluded.level, page_id = excluded.page_id,
        projects = excluded.projects, updated_at = excluded.updated_at`).run(t.slug, t.title, t.level, t.pageId, JSON.stringify(t.projects), t.updatedAt);
  }

  /** Moves every learning row of `from` to `to`; where both have a status for an area, the newer one stays. */
  moveProject(from: string, to: string): void {
    this.db.transaction(() => {
      for (const r of this.checks(from)) {
        const there = this.db.prepare('SELECT set_at FROM project_checks WHERE project = ? AND area = ?').get(to, r.area) as { set_at: string } | undefined;
        if (!there || there.set_at < r.setAt) {
          this.db.prepare(`INSERT INTO project_checks(project, area, status, note, automatic, set_by, set_at, report_at_set) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(project, area) DO UPDATE SET status = excluded.status, note = excluded.note, automatic = excluded.automatic,
              set_by = excluded.set_by, set_at = excluded.set_at, report_at_set = excluded.report_at_set`).run(to, r.area, r.status, r.note, r.automatic ? 1 : 0, r.setBy, r.setAt, r.reportAtSet ?? null);
        }
      }
      this.db.prepare('DELETE FROM project_checks WHERE project = ?').run(from);
      this.db.prepare('UPDATE project_check_history SET project = ? WHERE project = ?').run(to, from);
      this.db.prepare(`INSERT INTO check_snoozes(project, area, until, set_by) SELECT ?, area, until, set_by FROM check_snoozes WHERE project = ?
        ON CONFLICT(project, area) DO UPDATE SET until = MAX(check_snoozes.until, excluded.until)`).run(to, from);
      this.db.prepare('DELETE FROM check_snoozes WHERE project = ?').run(from);
      for (const t of this.topics().filter((x) => x.projects.includes(from))) {
        this.putTopic({ ...t, projects: [...new Set(t.projects.map((p) => (p === from ? to : p)))] });
      }
    })();
  }
}
