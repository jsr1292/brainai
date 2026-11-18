/**
 * Rows of a saved copy that BrainAI would never have written. A restored file brings its own table definitions, so its
 * CHECK constraints prove nothing: the rows themselves are checked. Names become folder and file names when the brain is
 * exported (Save a copy, Remove BrainAI), so none may climb out of its folder.
 */
import Database from 'better-sqlite3';
import { PROJECT_RE } from '../memory/service.js';
import { EXT } from '../images/clean.js';
import { PAGE_AREAS } from '../pages/types.js';
import { AREAS } from '../projects/types.js';
import { SKILL_NAME_RE, skillFilePathOk } from '../skills/types.js';
import { shown } from './shown.js';

const IMAGE_ID_RE = /^[0-9a-f]{24}$/;

type Rule = { table: string; column: string; ok: (v: string) => boolean };

const projectOk = (v: string): boolean => PROJECT_RE.test(v);

const RULES: Rule[] = [
  { table: 'skills', column: 'name', ok: (v) => SKILL_NAME_RE.test(v) },
  { table: 'skill_files', column: 'path', ok: skillFilePathOk },
  { table: 'memories', column: 'project', ok: projectOk },
  { table: 'pages', column: 'project', ok: projectOk },
  { table: 'projects', column: 'name', ok: projectOk },
  { table: 'project_aliases', column: 'alias', ok: projectOk },
  { table: 'project_aliases', column: 'project', ok: projectOk },
  { table: 'pages', column: 'area', ok: (v) => (PAGE_AREAS as readonly string[]).includes(v) },
  { table: 'images', column: 'id', ok: (v) => IMAGE_ID_RE.test(v) },
  { table: 'images', column: 'type', ok: (v) => Object.hasOwn(EXT, v) },
  { table: 'projects', column: 'area', ok: (v) => (AREAS as readonly string[]).includes(v) },
];

/** The first `<table>.<column>: <value>` that breaks the rules the app enforces on writing, or null. */
export function restoredRowsProblem(dbPath: string): string | null {
  const db = new Database(dbPath, { readonly: true });
  try {
    for (const { table, column, ok } of RULES) {
      const columns = db.pragma(`table_info(${table})`) as { name: string }[];
      // SQLite matches names without regard to case, so a column declared NAME still answers to `name`.
      const found = columns.find((c) => c.name.toLowerCase() === column);
      if (!found) continue; // an older file lacks this table or column
      const rows = db.prepare(`SELECT DISTINCT "${found.name}" AS v FROM "${table}" WHERE "${found.name}" IS NOT NULL`).all() as { v: unknown }[];
      for (const { v } of rows) {
        if (typeof v !== 'string' || !ok(v)) return `${table}.${column}: ${shown(v)}`;
      }
    }
    return null;
  } finally {
    db.close();
  }
}
