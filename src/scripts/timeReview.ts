/**
 * Times one weekly review build on a copy of a real database and prints only numbers: never a name or any text.
 *
 *   node --import tsx src/scripts/timeReview.ts <copy.db> [monday]
 *
 * Opening the copy runs the migrations on it (migration 20 included), so never point this at the live file. The
 * default week is the last finished week before the newest memory. The clock is set to the later of the newest memory
 * and the week's end plus 8 hours, so a week after the copy was taken can still be built as a finished week.
 */
import { performance } from 'node:perf_hooks';
import { openDb } from '../db.js';
import { DeviceService } from '../folders/devices.js';
import { FolderService } from '../folders/match.js';
import { GrowthService } from '../growth/service.js';
import { GrowthStore } from '../growth/store.js';
import { shiftWeek, weekOf } from '../memory/digest.js';
import { createFakeEmbedder } from '../memory/fakeEmbedder.js';
import { QUIET_DAYS, MemoryService } from '../memory/service.js';
import { MemoryStore } from '../memory/store.js';
import { PageService } from '../pages/service.js';
import { PageStore } from '../pages/store.js';
import { isLifeArea } from '../projects/service.js';
import { ProjectStore } from '../projects/store.js';
import { buildReview, liveWindow, windowFor, type BuildSources } from '../review/build.js';
import { ReviewService } from '../review/service.js';
import { ReviewStore } from '../review/store.js';

const [path, mondayArg] = process.argv.slice(2);
if (!path) {
  console.error('usage: node --import tsx src/scripts/timeReview.ts <copy.db> [monday]');
  process.exit(2);
}

const DAY_MS = 86_400_000;
const db = openDb(path);
const newest = (db.prepare('SELECT max(created_at) AS at FROM memories').get() as { at: string | null }).at;
if (newest === null) throw new Error('the copy has no memories');
const monday = mondayArg ?? shiftWeek(weekOf(new Date(newest)).monday, -1);
const win = windowFor(monday);
let t = Math.max(Date.parse(newest), win.end.getTime() + 8 * 3_600_000);
const now = () => new Date(t);

const embedder = createFakeEmbedder();
const store = new MemoryStore(db, now);
const service = new MemoryService(store, embedder, { duplicateThreshold: 0.9, minRecallSimilarity: 0.2, recallConfidentSimilarity: 0.2 });
const registry = new ProjectStore(db, now);
const devices = new DeviceService(db, now);
const folders = new FolderService(devices, registry, service, now);
const pages = new PageService(new PageStore(db, now), embedder, service, registry, store, now);
const growth = new GrowthService(new GrowthStore(db, now), embedder, service, registry, store, { duplicateThreshold: 0.9 }, now);
const reviews = new ReviewStore(db);
const hasGrants = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'oauth_grants'").get() !== undefined;
const grants = () => (hasGrants
  ? db.prepare('SELECT COALESCE(g.name, c.display_name, c.client_name) AS clientName, g.created_at AS createdAt FROM oauth_grants g JOIN oauth_clients c ON c.client_id = g.client_id').all() as { clientName: string; createdAt: string }[]
  : []);
const sources: BuildSources = { reviews, memories: store, registry, folders, grants, growth: true };

const time = (fn: () => unknown, runs: number): { median: number; max: number } => {
  for (let i = 0; i < 3; i++) fn();
  const ms: number[] = [];
  for (let i = 0; i < runs; i++) {
    const s = performance.now();
    fn();
    ms.push(performance.now() - s);
  }
  ms.sort((a, b) => a - b);
  return { median: ms[Math.floor(runs / 2)]!, max: ms[runs - 1]! };
};
const f1 = (n: number) => n.toFixed(1);

const week = time(() => buildReview(sources, win), 20);
console.log(`week ${monday}: median ${f1(week.median)} ms, max ${f1(week.max)} ms (20 runs)`);
const live = time(() => buildReview(sources, liveWindow(now())), 20);
console.log(`so far: median ${f1(live.median)} ms, max ${f1(live.max)} ms (20 runs)`);

const service14 = new ReviewService({ store: reviews, memories: store, service, registry, folders, pages, growth, grants }, now, (line) => console.log(line.replace(/^weekly review \S+/, 'first ensure:')));
const first = service14.ensure(monday, 'owner');
t += 60_000;
const again = service14.ensure(monday, 'owner');
console.log(`stored once: ${first !== undefined && again !== undefined && first.builtAt === again.builtAt ? 'yes'
  : 'no (outside the weeks that can be stored: before the first memory, or not finished)'}`);

// A week that can't be stored is still counted from a direct build.
const shown = again ?? { monday, body: buildReview(sources, win), builtAt: now().toISOString() };
const body = shown.body;
const view = service14.present(shown, monday === service14.lastMonday() ? 'last' : 'older', { kind: 'owner' });
const all = <T>(c: { shown: T[]; folded: T[] }) => [...c.shown, ...c.folded];
const row = (name: string) => registry.get(name);
const byMigration = (name: string) => row(name)?.createdBy === 'migration';

// Facts only (no registry floor, no Mac): did the project's last fact cross the quiet line inside this week?
const aliases = new Map(service.aliases().map((a) => [a.alias, a.project]));
const folded = (m: Map<string, string>) => {
  const out = new Map<string, string>();
  for (const [k, v] of m) { const n = aliases.get(k) ?? k; const had = out.get(n); out.set(n, had && had > v ? had : v); }
  return out;
};
const startIso = win.start.toISOString();
const endIso = win.end.toISOString();
const factsAtStart = folded(reviews.lastTouched(startIso));
const factsAtEnd = folded(reviews.lastTouched(endIso));
const line = (iso: string) => new Date(Date.parse(iso) - QUIET_DAYS * DAY_MS).toISOString();
const crossed = (name: string) => {
  const s = factsAtStart.get(name);
  const e = factsAtEnd.get(name) ?? s;
  return s !== undefined && e !== undefined && s > line(startIso) && e <= line(endIso);
};

const quietMigration = body.projects.filter((p) => p.quiet && byMigration(p.project));
const finishedMigration = body.projects.filter((p) => (p.quiet || p.back) && byMigration(p.project) && ['done', 'archived'].includes(row(p.project)!.state));
const newMigration = body.projects.filter((p) => byMigration(p.project) && p.chips.some((c) => c === 'new-idea' || c === 'new-project'));
const capped = [view.waiting.late, view.waiting.after, view.quiet, view.back, view.decided, view.safety];
const lifeNames = registry.list().filter((p) => isLifeArea(p)).map((p) => p.name)
  .filter((name) => new RegExp(`(^|[^a-z0-9-])${name.replace(/[-]/g, '\\-')}([^a-z0-9-]|$)`).test(view.lineSentence));

const counts: [string, number][] = [
  ['projects moved', view.moved.length + view.movedMore.length],
  ['steps', view.moved.reduce((a, m) => a + m.done.length + m.moreSteps, 0)],
  ['late', all(view.waiting.late).length],
  ['due after', all(view.waiting.after).length],
  ['undated', view.waiting.undated],
  ['went quiet', all(view.quiet).length],
  ['back', all(view.back).length],
  ['decisions', all(view.decided).length],
  ['pages', view.moved.reduce((a, m) => a + m.pagesUpdated, 0)],
  ['growth parts', view.growth ? Number(view.growth.strength !== null) + Number(view.growth.improve !== null) : 0],
  ['safety notes', all(view.safety).length],
  ['chips', view.chips.length],
  ['stored projects (full scope)', body.projects.length],
  ['migration-made projects shown as new (must be 0)', newMigration.length],
  ['migration-made projects in went quiet', quietMigration.length],
  ['  of those, quiet without their facts crossing the line (must be 0)', quietMigration.filter((p) => !crossed(aliases.get(p.project) ?? p.project)).length],
  ['done or archived migration-made projects in went quiet or back (must be 0)', finishedMigration.length],
  ['largest folded count in any capped list', Math.max(view.movedMore.length, ...capped.map((c) => c.folded.length))],
  ['life-area names in the line (must be 0)', lifeNames.length],
  ['week is empty (1 = yes)', Number(view.empty)],
];
for (const [k, v] of counts) console.log(`${k}: ${v}`);
db.close();
