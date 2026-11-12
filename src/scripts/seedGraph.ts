/**
 * A made-up brain for checking the graph's speed: `n` projects across the areas and states, with decisions that
 * relate across projects, roadmaps with waiting items, places and pages. For local checks only (the iPhone check runs
 * against a copy seeded with 200 projects); never run in production.
 *
 *   node --import tsx src/scripts/seedGraph.ts <new.db> [n=200]
 *
 * It refuses a path that exists, so it never touches a real database.
 */
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { openDb } from '../db.js';
import { MeaningIndex, THREAD_KINDS, type MeaningHook } from '../graph/threads.js';
import { profileFor } from '../memory/embeddingProfile.js';
import { createFakeEmbedder } from '../memory/fakeEmbedder.js';
import { MemoryService } from '../memory/service.js';
import { MemoryStore } from '../memory/store.js';
import { PageService } from '../pages/service.js';
import { PageStore } from '../pages/store.js';
import { ProjectStore } from '../projects/store.js';
import { AREAS, type Area } from '../projects/types.js';

const OWNER = { type: 'owner' } as const;
const NAMES = ['atlas', 'beacon', 'cellar', 'dune', 'ember', 'fjord', 'garden', 'harbor', 'island', 'jigsaw', 'kiln', 'lantern', 'meadow', 'nimbus', 'orchard', 'pixel', 'quarry', 'river', 'summit', 'tundra'];
const PLACES = ['homeserver', 'pi', 'mac', 'iphone', 'cloudflare', 'nas', 'office'];
/** Ten words each; one varies per fact, so two facts of a topic sit at about 0.9 with the fake embedder. */
const TOPICS = [
  'restic copies the nas backups every night with a check',
  'cloudflare tunnel keeps the site online behind the home router',
  'swiftui screens share one model for the iphone and ipad',
  'docker compose runs the stack on the mini pc server',
  'oauth sign in protects every assistant connection to the brain',
  'solar battery planner keeps two kwh back for the evening',
  'codex builds the feature and claude reviews every pull request',
  'sqlite file holds the data with a nightly encrypted copy',
  'testflight build goes to the testers before the store release',
  'home assistant reads the sensors over zigbee on the pi',
  'postgres move waits for the aws account and the template',
  'karst ride telemetry syncs from the phone after each session',
];
const VARY = ['today', 'again', 'safely', 'quickly', 'quietly', 'weekly', 'daily', 'later', 'first', 'always'];

/** A small seeded PRNG (mulberry32), so the same seed gives the same brain. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Role = 'pinned' | 'idea' | 'parked' | 'done' | 'archived' | 'personal' | 'open';

export async function seedGraph(
  d: { registry: ProjectStore; service: MemoryService; pages: PageService; meaning: MeaningIndex },
  n: number,
  opts: { seed?: number } = {},
): Promise<{ projects: number; facts: number; pages: number }> {
  const rnd = prng(opts.seed ?? 1);
  const pickOf = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
  const share = (f: number) => Math.max(1, Math.ceil(n * f));
  // Each share rounded up, so even n = 40 has every state; the rest are open.
  const roles: Role[] = [];
  const push = (r: Role, k: number) => { for (let i = 0; i < k; i++) roles.push(r); };
  push('pinned', Math.min(6, n));
  push('idea', share(0.1));
  push('parked', share(0.1));
  push('done', share(0.04));
  push('archived', share(0.04));
  push('personal', share(0.06));
  while (roles.length < n) roles.push('open');
  roles.length = n;
  // Writing with the save hook on would compare every item at each save (O(n²)): index once at the end instead.
  const quiet: MeaningHook = { factsChanged: () => {}, pageChanged: () => {}, projectChanged: () => {}, factsBroughtBack: () => {} };
  d.service.setMeaningHook(quiet);
  d.pages.setMeaningHook(quiet);
  let facts = 0, pages = 0;
  const today = Date.now();
  try {
    for (let i = 0; i < n; i++) {
      const role = roles[i]!;
      const name = `p${String(i + 1).padStart(3, '0')}-${NAMES[i % NAMES.length]}`;
      const area: Area | null = role === 'personal' ? 'personal' : rnd() < 0.05 ? null : pickOf(AREAS.filter((a) => a !== 'personal'));
      const topics = [pickOf(TOPICS), pickOf(TOPICS)];
      const oneLiner = `${name.slice(5)}: ${topics[0]}`.slice(0, 120);
      d.registry.create(name, { state: role === 'idea' ? 'idea' : 'open', oneLiner, area }, 'owner');
      d.registry.setInfo(name, { runsOn: [...new Set([pickOf(PLACES), ...(rnd() < 0.4 ? [pickOf(PLACES)] : [])])] }, 'owner');
      const count = role === 'idea' ? Math.floor(rnd() * 3) : Math.floor(rnd() * 41);
      for (let k = 0; k < count; k++) {
        const words = (k % 2 ? topics[1]! : topics[0]!).split(' ');
        words[Math.floor(rnd() * words.length)] = pickOf(VARY);
        await d.service.remember({ kind: 'decision', content: `${words.join(' ')} ${name}`, project: name }, OWNER);
        facts++;
      }
      if (role !== 'idea') {
        const waiting = Math.floor(rnd() * 12);
        const past = new Date(today - (3 + Math.floor(rnd() * 20)) * 86_400_000).toISOString().slice(0, 10);
        const items = Array.from({ length: waiting }, (_, k) => (k < 2 && rnd() < 0.3 ? `check step ${k + 1} (by ${past})` : `check step ${k + 1}`));
        await d.service.remember({ kind: 'roadmap', project: name, content: `Now: ${topics[0]!.split(' ').slice(0, 4).join(' ')}\nNext: ${topics[1]!.split(' ').slice(0, 5).join(' ')}${items.length ? `\nWaiting on you: ${items.join('; ')}` : ''}` }, OWNER);
      }
      for (let k = 0, m = Math.floor(rnd() * 4); k < m; k++) {
        await d.pages.create({ title: `${name} notes ${k + 1}`, project: name, body: `## Plan\n${topics[0]}\n\n## Notes\n${topics[1]}` }, 'owner');
        pages++;
      }
      if (role === 'pinned') d.registry.pin(name, 'owner');
      if (role === 'parked' || role === 'done' || role === 'archived') d.registry.setState(name, role, 'owner');
    }
  } finally {
    d.service.setMeaningHook(d.meaning);
    d.pages.setMeaningHook(d.meaning);
  }
  await d.meaning.catchUp();
  return { projects: n, facts, pages };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [path, count] = process.argv.slice(2);
  if (!path) {
    console.error('usage: node --import tsx src/scripts/seedGraph.ts <new.db> [n=200]');
    process.exit(2);
  }
  if (existsSync(path)) {
    console.error('refusing: the file exists; the seed only writes a new database');
    process.exit(2);
  }
  const db = openDb(path);
  const now = () => new Date();
  const embedder = createFakeEmbedder();
  const store = new MemoryStore(db, now);
  const service = new MemoryService(store, embedder, { duplicateThreshold: 0.9, minRecallSimilarity: 0.2, recallConfidentSimilarity: 0.2 });
  const registry = new ProjectStore(db, now);
  const pages = new PageService(new PageStore(db, now), embedder, service, registry, store, now);
  const meaning = new MeaningIndex(db, { floor: profileFor(process.env.EMBED_MODEL).threadFloor, kinds: THREAD_KINDS, now, log: () => {} });
  console.log(await seedGraph({ registry, service, pages, meaning }, Number(count ?? 200)));
  db.close();
}
