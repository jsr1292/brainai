/** Test data for the Moved from Outline screens: pages as the one-off importer left them, with their records. */
import type { DB } from '../db.js';
import type { MemoryService } from '../memory/service.js';
import type { PageService } from '../pages/service.js';
import type { Area } from '../projects/types.js';

export interface MovedDoc { id: string; collection: string; title: string; text: string; updatedAt: string }
const AREAS: Record<string, Area | 'start'> = { 'Start here': 'start', Apps: 'apps', 'Home & infrastructure': 'home', Tools: 'tools', Work: 'work', Personal: 'personal' };

/** Creates each page as "Outline import" (under its project when the title starts with one) and records it as moved. */
export async function seedMoved(d: { pages: PageService; memories: MemoryService; db: DB; now: () => Date }, docs: MovedDoc[]): Promise<void> {
  for (const doc of docs) {
    const prefix = doc.title.includes(' — ') ? doc.title.slice(0, doc.title.indexOf(' — ')).trim() : '';
    const real = prefix ? d.memories.projectNamed(prefix) : '';
    const project = real && d.memories.listProjects().some((x) => x.project === real) ? real : null;
    const p = await d.pages.create({ title: doc.title, project: project ?? undefined, area: project ? undefined : AREAS[doc.collection] ?? 'start', body: doc.text }, 'Outline import', { importedAt: doc.updatedAt });
    d.db.prepare(`INSERT INTO page_imports(outline_id, page_id, collection, title, original, outline_updated_at, imported_at, status, reason)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'imported', NULL)`).run(doc.id, p.id, doc.collection, doc.title, doc.text, doc.updatedAt, d.now().toISOString());
  }
}
