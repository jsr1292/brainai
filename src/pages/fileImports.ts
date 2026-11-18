import type { DB } from '../db.js';
import type { Clock } from '../clock.js';

export interface FileImport { pageId: string; fileName: string; importedAt: string }

/** Which pages were made from an uploaded file (C4): the page view says so. */
export class FileImports {
  constructor(private db: DB, private now: Clock) {}
  mark(pageId: string, fileName: string): void {
    this.db.prepare('INSERT OR REPLACE INTO page_file_imports(page_id, file_name, imported_at) VALUES (?, ?, ?)').run(pageId, fileName, this.now().toISOString());
  }
  get(pageId: string): FileImport | undefined {
    const r = this.db.prepare('SELECT page_id, file_name, imported_at FROM page_file_imports WHERE page_id = ?').get(pageId) as { page_id: string; file_name: string; imported_at: string } | undefined;
    return r && { pageId: r.page_id, fileName: r.file_name, importedAt: r.imported_at };
  }
}
