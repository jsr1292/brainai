/**
 * Times the graph on a copy of a real database and prints only numbers: never a name or any text.
 *
 *   node --import tsx src/scripts/timeGraph.ts <copy.db>
 *
 * It builds the same stores as src/index.ts with the fake embedder (nothing is embedded: the stored vectors are used),
 * empties the meaning tables, then times the first catch-up (the first deploy), a second one (fingerprints only), one
 * save's index step, and opening the graph. Opening the copy runs the migrations on it, so never point this at a live file.
 */
import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../db.js';
import { DeviceService } from '../folders/devices.js';
import { FolderService } from '../folders/match.js';
import { GraphService } from '../graph/data.js';
import { MeaningIndex, THREAD_KINDS } from '../graph/threads.js';
import { profileFor } from '../memory/embeddingProfile.js';
import { createFakeEmbedder } from '../memory/fakeEmbedder.js';
import { MemoryService } from '../memory/service.js';
import { MemoryStore } from '../memory/store.js';
import { PageService } from '../pages/service.js';
import { PageStore } from '../pages/store.js';
import { ProjectsService } from '../projects/service.js';
import { ProjectStore } from '../projects/store.js';

const path = process.argv[2];
if (!path) {
  console.error('usage: node --import tsx src/scripts/timeGraph.ts <copy.db>');
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
const embedder = createFakeEmbedder();
const store = new MemoryStore(db, now);
const service = new MemoryService(store, embedder, { duplicateThreshold: 0.9, minRecallSimilarity: 0.8, recallConfidentSimilarity: 0.85 });
const registry = new ProjectStore(db, now);
const pages = new PageService(new PageStore(db, now), embedder, service, registry, store, now);
const folders = new FolderService(new DeviceService(db, now), registry, service, now);
const projects = new ProjectsService(registry, service, store, undefined, pages, folders);
const meaning = new MeaningIndex(db, { floor: profileFor(process.env.EMBED_MODEL).threadFloor, kinds: THREAD_KINDS, now, log: () => {} });
const graph = new GraphService({ db, projects, registry, service, pages, meaning, now });

const ms = (t0: number) => Math.round((performance.now() - t0) * 10) / 10;
const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]!; };
const times = (n: number, f: () => unknown) => Array.from({ length: n }, () => { const t0 = performance.now(); f(); return ms(t0); });

db.exec('DELETE FROM meaning_links; DELETE FROM meaning_indexed;');
let t0 = performance.now();
const cold = await meaning.catchUp();
console.log(`catch-up cold: checked ${cold.checked}, indexed ${cold.indexed} in ${ms(t0)} ms`);
t0 = performance.now();
const warm = await meaning.catchUp();
console.log(`catch-up warm: checked ${warm.checked}, indexed ${warm.indexed} in ${ms(t0)} ms`);
const fact = (db.prepare(`SELECT id FROM memories WHERE deleted_at IS NULL AND kind = 'decision' AND project IS NOT NULL LIMIT 1`).get() as { id: string }).id;
const step = times(20, () => meaning.refresh([{ kind: 'm', id: fact, anchor: '' }], { force: true }));
console.log(`one save's index step: median ${median(step)} ms, max ${Math.max(...step)} ms (20 runs)`);
t0 = performance.now();
const o = graph.overview();
console.log(`overview cold: ${ms(t0)} ms (${o.projects.length} projects, ${o.threads.length} threads, ${JSON.stringify(o).length} bytes)`);
const ov = times(20, () => graph.overview());
console.log(`overview warm: median ${median(ov)} ms, max ${Math.max(...ov)} ms (20 runs)`);
const first = o.projects[0]?.name ?? '';
const dt = times(20, () => graph.detail(first));
console.log(`detail: median ${median(dt)} ms (20 runs)`);
const li = times(20, () => graph.list());
console.log(`list: median ${median(li)} ms (20 runs)`);
db.close();
