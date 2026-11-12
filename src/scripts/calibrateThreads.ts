/**
 * Calibrates the graph's thread floor on a copy of a real database and prints only counts and timings: never a name,
 * a word or any text unless --samples is passed (words are content; only the owner passes it, on their own computer).
 *
 *   node --import tsx src/scripts/calibrateThreads.ts <copy.db> [--samples] [--floors 0.84,0.85,...]
 *
 * --floors: the floors to try (default e5's range; another search model needs its own, see embeddingProfile.ts).
 *
 * Opening the copy runs the migrations on it, and every run empties and rebuilds its meaning tables with the real
 * index (MeaningIndex.catchUp, not chooseLinks: the stored set is a superset of it), so never point this at a live file.
 */
import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../db.js';
import { MeaningIndex, topThreads } from '../graph/threads.js';
import type { Kind } from '../memory/types.js';

const args = process.argv.slice(2);
const path = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--floors');
const samples = args.includes('--samples');
const floorsArg = args[args.indexOf('--floors') + 1];
const floors = args.includes('--floors') && floorsArg ? floorsArg.split(',').map(Number) : [0.84, 0.85, 0.86, 0.87, 0.88];
if (floors.some((f) => !Number.isFinite(f))) { console.error(`--floors takes numbers, got ${floorsArg}`); process.exit(2); }
if (!path) {
  console.error('usage: node --import tsx src/scripts/calibrateThreads.ts <copy.db> [--samples]');
  process.exit(2);
}
// Never the live database (DATA_DIR's memory.db, or anything inside this repo): copy it elsewhere first.
const live = resolve(process.env.DATA_DIR ?? 'data', 'memory.db');
const repo = fileURLToPath(new URL('../..', import.meta.url));
if (resolve(path) === live || resolve(path).startsWith(repo)) {
  console.error('refusing: this writes the meaning tables of the file it opens; copy the database elsewhere first');
  process.exit(2);
}

const db = openDb(path);
const now = () => new Date();
const open = (db.prepare("SELECT name FROM projects WHERE state = 'open'").all() as { name: string }[]).map((r) => r.name);
const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length === 0 ? 0 : s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2; };

for (const kinds of [['decision'], ['decision', 'summary']] as Kind[][]) {
  for (const floor of floors) {
    const started = performance.now();
    db.exec('DELETE FROM meaning_links; DELETE FROM meaning_indexed;');
    const meaning = new MeaningIndex(db, { floor, kinds, now, log: () => {} });
    const r = await meaning.catchUp();
    const threads = topThreads(meaning.threadPairs());
    const per = new Map<string, number>();
    for (const t of threads) for (const p of [t.a, t.b]) per.set(p, (per.get(p) ?? 0) + 1);
    const counts = open.map((p) => per.get(p) ?? 0);
    const links = (db.prepare('SELECT COUNT(*) AS n FROM meaning_links WHERE similarity >= ?').get(floor) as { n: number }).n;
    // Threads all of whose stored links join two statuses: they would link on the shared shape of a status alone.
    const summaryOnly = db.prepare(`
      WITH l AS (
        SELECT COALESCE(aa.project, ma.project) AS pa, COALESCE(ab.project, mb.project) AS pb, ma.kind AS ka, mb.kind AS kb
        FROM meaning_links x
        JOIN memories ma ON x.a_kind = 'm' AND ma.id = x.a_id LEFT JOIN project_aliases aa ON aa.alias = ma.project
        JOIN memories mb ON x.b_kind = 'm' AND mb.id = x.b_id LEFT JOIN project_aliases ab ON ab.alias = mb.project
        WHERE x.similarity >= ?)
      SELECT MIN(pa, pb) AS a, MAX(pa, pb) AS b, SUM(ka = 'summary' AND kb = 'summary') AS s, COUNT(*) AS n FROM l GROUP BY 1, 2`).all(floor) as { a: string; b: string; s: number; n: number }[];
    const allSummary = new Set(summaryOnly.filter((x) => x.s === x.n).map((x) => `${x.a}\u0000${x.b}`));
    const sOnly = threads.filter((t) => allSummary.has(`${t.a}\u0000${t.b}`)).length;
    console.log(`kinds=${kinds.join('+')} floor=${floor} items=${r.checked} links=${links} threads=${threads.length} `
      + `open: median=${median(counts)} none=${counts.filter((c) => c === 0).length} over6=${counts.filter((c) => c > 6).length} `
      + `with-words=${threads.filter((t) => t.words.length > 0).length} summary-only=${sOnly} ms=${Math.round(performance.now() - started)}`);
    if (samples) for (const t of threads.slice(0, 15)) console.log(`  ${t.a} – ${t.b}: ${t.links} links, ${t.words.join(', ') || 'related by meaning'}`);
  }
}
db.close();
