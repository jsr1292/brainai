/**
 * A sample brain with made-up content, for trying Cairn and for the README's screenshots. The owner, Alex, is
 * invented: a librarian in Berlin who runs a garden club's website, a small home server and a seed-swap phone app.
 * The facts are spread over the last eight days, so the week review has something to show.
 *
 *   npm run demo:seed -- <new data folder>     writes <folder>/memory.db (refuses one that exists)
 *   npm run demo:code                          prints the sign-in code for the demo account
 *
 * The demo account signs in with the password "try-cairn-demo" and the code from demo:code. That login is public, so the
 * seed only writes into a new or empty folder; never use the folder for real data.
 */
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { OwnerAuth } from '../auth/owner.js';
import { writeBackupStatus } from '../backupStatus.js';
import { totpAt } from '../auth/totp.js';
import { openDb } from '../db.js';
import { DiscussionService } from '../discussions/service.js';
import { DiscussionStore } from '../discussions/store.js';
import { MeaningIndex, THREAD_FLOOR, THREAD_KINDS } from '../graph/threads.js';
import { createLocalEmbedder, type Embedder } from '../memory/embedder.js';
import { MemoryService } from '../memory/service.js';
import { MemoryStore } from '../memory/store.js';
import type { Actor } from '../memory/types.js';
import { PageService } from '../pages/service.js';
import { PageStore } from '../pages/store.js';
import { ProjectStore } from '../projects/store.js';
import type { Area } from '../projects/types.js';

export const DEMO_PASSWORD = 'try-cairn-demo';
/** A fixed secret, so demo:code works without a QR code. Only ever for the demo account. */
export const DEMO_TOTP_SECRET = 'CAIRNDEMOCAIRNDEMOCAIRNDEMOCAIRN';

const DAY = 86_400_000;
const owner: Actor = { type: 'owner' };
const claudeCode: Actor = { type: 'ai', name: 'Claude Code' };
const codex: Actor = { type: 'ai', name: 'Codex' };
const claude: Actor = { type: 'ai', name: 'Claude' };
const chatgpt: Actor = { type: 'ai', name: 'ChatGPT' };

interface DemoProject {
  name: string; area: Area; oneLiner: string; runsOn: string[]; state?: 'open' | 'idea' | 'parked' | 'done'; pinned?: boolean;
}

const PROJECTS: DemoProject[] = [
  { name: 'garden-club-site', area: 'apps', oneLiner: "The garden club's website: plot bookings, events and the newsletter", runsOn: ['minipc', 'cloudflare'], pinned: true },
  { name: 'seed-swap', area: 'apps', oneLiner: 'An iPhone app for swapping seeds with other club members', runsOn: ['iphone'], pinned: true },
  { name: 'homelab', area: 'home', oneLiner: 'The mini PC at home: Docker, backups to the NAS, a tunnel for the outside', runsOn: ['minipc', 'nas'] },
  { name: 'solar-planner', area: 'home', oneLiner: 'Plans when the battery charges, from the weather and the tariff', runsOn: ['pi'] },
  { name: 'library-shifts', area: 'work', oneLiner: 'A small tool that turns the library rota into calendar invites', runsOn: ['mac'] },
  { name: 'dotfiles', area: 'tools', oneLiner: 'Shell, editor and terminal settings shared between the Macs', runsOn: ['mac'] },
  { name: 'reading-list', area: 'personal', oneLiner: 'Books to read and notes on the ones finished', runsOn: [] },
  { name: 'recipe-box', area: 'apps', oneLiner: 'Family recipes, searchable by what is in the fridge', runsOn: [], state: 'idea' },
  { name: 'photo-archive', area: 'home', oneLiner: 'Twenty years of photos, deduplicated, on the NAS', runsOn: ['nas'], state: 'parked' },
];

export async function seedDemo(dataDir: string, embedder: Embedder, today = Date.now()): Promise<{ facts: number; pages: number }> {
  // A new or empty folder only: the demo login is public, so it must never sit next to anything real.
  if (existsSync(dataDir) && readdirSync(dataDir).length > 0) {
    throw new Error(`refusing: ${dataDir} is not empty; the demo only writes into a new folder (delete it to seed again)`);
  }
  mkdirSync(dataDir, { recursive: true });
  const path = join(dataDir, 'memory.db');
  const db = openDb(path);
  let t = today - 8 * DAY;
  const now = () => new Date(t);
  const at = (daysAgo: number, hour = 10) => { t = today - daysAgo * DAY + (hour - 12) * 3_600_000; };
  const date = (daysAgo: number) => new Date(today - daysAgo * DAY).toISOString().slice(0, 10);

  const store = new MemoryStore(db, now);
  const service = new MemoryService(store, embedder, { duplicateThreshold: 0.97, minRecallSimilarity: 0.2, recallConfidentSimilarity: 0.5 });
  const registry = new ProjectStore(db, now);
  const pages = new PageService(new PageStore(db, now), embedder, service, registry, store, now);
  const meaning = new MeaningIndex(db, { floor: THREAD_FLOOR, kinds: THREAD_KINDS, now, log: () => {} });
  service.setMeaningHook(meaning);
  pages.setMeaningHook(meaning);
  const discussions = new DiscussionService(new DiscussionStore(db, now), service, () => [], now);
  let facts = 0, pageCount = 0;
  const save = async (actor: Actor, kind: 'decision' | 'summary' | 'roadmap' | 'profile', project: string | undefined, content: string) => {
    const r = await service.remember({ kind, content, ...(project ? { project } : {}) }, actor);
    if (r.status !== 'saved') throw new Error(`demo fact not saved (${r.status}): ${content}`);
    facts++;
  };
  const roadmap = async (actor: Actor, project: string, content: string) => {
    const existing = store.list({ project, kind: 'roadmap' });
    if (existing.length) {
      const r = await service.update(existing[0]!.id, { content }, actor);
      if (r.status !== 'updated') throw new Error(`demo roadmap not updated (${r.status}): ${project}`);
    }
    else await save(actor, 'roadmap', project, content);
  };

  at(8, 9);
  for (const p of PROJECTS) {
    registry.create(p.name, { state: p.state === 'idea' ? 'idea' : 'open', oneLiner: p.oneLiner, area: p.area }, 'owner');
    if (p.runsOn.length) registry.setInfo(p.name, { runsOn: p.runsOn }, 'owner');
    if (p.pinned) registry.pin(p.name, 'owner');
  }

  // The owner's profile: what every assistant loads first.
  for (const line of [
    'Alex is a librarian in Berlin and builds small apps in the evenings.',
    'Prefers short answers with an example over long explanations.',
    'Codes with Claude Code and Codex; uses Claude and ChatGPT on the phone.',
    'Runs the website and the plot bookings for the Lindenhof garden club.',
  ]) await save(owner, 'profile', undefined, line);

  // garden-club-site: a week of real progress.
  at(8, 10);
  await save(owner, 'decision', 'garden-club-site', 'garden-club-site uses SvelteKit with SQLite: one small server, no database to run separately.');
  await roadmap(claudeCode, 'garden-club-site', `Done: plot booking form (${date(12)})\nNow: member sign-in (1/4)\nNext: newsletter signup; event calendar\nLater: photo gallery\nWaiting on you: pick the colour scheme for the header`);
  at(7, 15);
  await save(claudeCode, 'decision', 'garden-club-site', 'garden-club-site signs members in with an emailed link, not passwords: the club has no one to reset them.');
  at(6, 11);
  await save(codex, 'decision', 'garden-club-site', 'garden-club-site sends email through the club’s existing mailbox over SMTP; no new email service.');
  await roadmap(codex, 'garden-club-site', `Done: plot booking form (${date(12)}); sign-in links by email (${date(6)})\nNow: member sign-in (2/4)\nNext: newsletter signup; event calendar\nLater: photo gallery\nWaiting on you: pick the colour scheme for the header`);
  at(4, 17);
  await save(claudeCode, 'decision', 'garden-club-site', 'garden-club-site keeps bookings for 12 months, then deletes them: the committee agreed that is enough.');
  at(2, 10);
  await roadmap(claudeCode, 'garden-club-site', `Done: plot booking form (${date(12)}); sign-in links by email (${date(6)}); members page (${date(2)})\nNow: member sign-in (3/4)\nNext: newsletter signup; event calendar\nLater: photo gallery\nWaiting on you: pick the colour scheme for the header; ask the committee about the privacy notice (by ${date(-3)})`);
  await save(claudeCode, 'summary', 'garden-club-site', 'garden-club-site status: sign-in works end to end on the test server; the session timeout and the logout page are left.');

  // seed-swap: the phone app.
  at(7, 20);
  await save(owner, 'decision', 'seed-swap', 'seed-swap is SwiftUI only, iOS 18 and later; no Android until the club asks for it.');
  await roadmap(claudeCode, 'seed-swap', `Done: seed list and search (${date(10)})\nNow: TestFlight build 0.3 (2/5)\nNext: swap requests; photos of the packets\nWaiting on you: send the TestFlight link to three club members`);
  at(5, 21);
  await save(claudeCode, 'decision', 'seed-swap', 'seed-swap stores everything on the phone with SwiftData and syncs through iCloud; no server of its own.');
  at(3, 20);
  await save(codex, 'decision', 'seed-swap', 'seed-swap scans packet barcodes with VisionKit, so no camera code of our own.');
  await roadmap(codex, 'seed-swap', `Done: seed list and search (${date(10)}); barcode scan (${date(3)})\nNow: TestFlight build 0.3 (3/5)\nNext: swap requests; photos of the packets\nWaiting on you: send the TestFlight link to three club members`);

  // homelab.
  at(8, 19);
  await save(owner, 'decision', 'homelab', 'homelab runs everything in Docker Compose on the mini PC; one folder per service.');
  await save(claude, 'decision', 'homelab', 'homelab backs up every night to the NAS with restic, and once a week to the cloud, encrypted.');
  await roadmap(claude, 'homelab', `Done: restic to the NAS (${date(9)})\nNow: weekly cloud copy (1/2)\nNext: test a full restore\nLater: second disk in the mini PC`);
  at(5, 9);
  await save(claude, 'decision', 'homelab', 'homelab reaches the outside only through a Cloudflare Tunnel; no ports open on the router.');
  at(1, 22);
  await roadmap(claudeCode, 'homelab', `Done: restic to the NAS (${date(9)}); weekly cloud copy (${date(1)})\nNow: test a full restore (0/3)\nNext: second disk in the mini PC\nWaiting on you: write down the restic password on paper and put it in the drawer`);

  // solar-planner.
  at(6, 18);
  await save(chatgpt, 'decision', 'solar-planner', 'solar-planner charges the battery from the grid only when the night tariff is below 15 cents.');
  await roadmap(codex, 'solar-planner', `Done: read the tariff every hour (${date(15)})\nNow: weather forecast input (2/3)\nNext: a weekly report of what it saved`);
  at(2, 19);
  await save(codex, 'decision', 'solar-planner', 'solar-planner keeps 2 kWh in the battery for the evening, whatever the forecast says.');

  // library-shifts and dotfiles.
  at(6, 13);
  await save(owner, 'decision', 'library-shifts', 'library-shifts reads the rota spreadsheet and creates calendar invites; it never edits the rota itself.');
  await roadmap(codex, 'library-shifts', `Done: read the rota (${date(6)})\nNow: calendar invites (1/2)\nNext: a reminder the evening before`);
  at(4, 21);
  await save(claudeCode, 'decision', 'dotfiles', 'dotfiles are linked with GNU Stow; one folder per tool.');

  // reading-list (personal) and the parked and idea projects.
  at(5, 22);
  await save(claude, 'decision', 'reading-list', 'reading-list: next up is "The Overstory", then "Braiding Sweetgrass".');
  at(3, 9);
  await save(chatgpt, 'decision', 'recipe-box', 'recipe-box idea: search by ingredients with a photo of the fridge; start with 30 family recipes.');
  registry.setState('photo-archive', 'parked', 'owner');

  // Pages: what a project is and how it is run, with a diagram.
  at(5, 16);
  await pages.create({
    title: "garden-club-site — the garden club's website", project: 'garden-club-site', body: [
      '## What it does', 'Members book a plot for the season, see the events and get the newsletter. The committee edits the events and the plot map.',
      '', '## Stack and where it lives', 'SvelteKit and SQLite in one container on the mini PC, reached through the Cloudflare Tunnel.', '',
      '```mermaid', 'flowchart TD', '  M[Member on the phone] --> CF[Cloudflare Tunnel]', '  CF --> APP[SvelteKit app]', '  APP --> DB[(SQLite)]',
      '  APP --> MAIL[Club mailbox]', '  DB --> BK[Nightly backup to the NAS]', '```', '',
      '## Run, build and deploy', '`docker compose up -d --build` in `~/garden-club-site` on the mini PC.', '',
      '## Key decisions', `- ${date(7)}: sign-in by emailed link, not passwords.`, `- ${date(4)}: bookings are deleted after 12 months.`, '',
      '## Gotchas and lessons', '- The club mailbox limits sending to 100 emails an hour: the newsletter must go out in batches.',
    ].join('\n'),
  }, 'owner');
  pageCount++;
  at(4, 12);
  await pages.create({
    title: 'homelab — the mini PC at home', project: 'homelab', body: [
      '## What it does', 'Runs the club website, the solar planner and the backups, in Docker.', '',
      '## Stack and where it lives', '```mermaid', 'flowchart TD', '  R[Router] --> MP[Mini PC]', '  MP --> D[Docker Compose]',
      '  D --> S1[garden-club-site]', '  D --> S2[solar-planner]', '  MP --> NAS[(NAS)]', '  NAS --> CL[Weekly encrypted cloud copy]', '```', '',
      '## Run, build and deploy', 'Each service has its own folder with a `compose.yml`.', '',
      '## Gotchas and lessons', '- Keep one disk free for restores; a restore needs as much space as the backup.',
    ].join('\n'),
  }, 'owner');
  pageCount++;

  // A discussion two assistants answered.
  at(2, 14);
  const d = discussions.open({ name: 'Claude Code', model: 'Claude Opus', access: 'full' }, {
    title: 'Newsletter: build it in, or use a mailing service?', project: 'garden-club-site',
    question: 'The club wants a monthly newsletter for about 120 members. Should garden-club-site send it itself, or should we use a mailing service?',
  });
  discussions.reply({ name: 'Claude Code', model: 'Claude Opus', access: 'full' }, d.id, { text: 'Build it in: 120 members fit the club mailbox if we send in batches of 50, and members are already in our database. A service would mean a second list to keep in sync.' });
  at(2, 15);
  discussions.reply({ name: 'Codex', model: 'GPT', access: 'full' }, d.id, { text: 'Agree for now. Add an unsubscribe link from day one, and switch to a service only if the list passes 500 or the mailbox starts bouncing.' });

  at(0, 8);
  await meaning.catchUp();
  // Last night's backup, export and git copy and this week's off-site copy, as the scripts would report them, so the demo dashboard is not all warnings.
  writeBackupStatus(dataDir, 'nightly', {
    at: new Date(today - 6 * 3_600_000).toISOString(), ok: true, copies: [{ where: 'NAS', result: 'copied' }],
    counts: { facts, pages: pageCount },
  });
  writeBackupStatus(dataDir, 'offsite', { at: new Date(today - 2 * DAY).toISOString(), ok: true, where: 'cloud' });
  for (const job of ['git-backup-status.json', 'export-status.json']) {
    writeFileSync(join(dataDir, job), JSON.stringify({ at: new Date(today - 5 * 3_600_000).toISOString(), ok: true }));
  }
  db.close();
  return { facts, pages: pageCount };
}

/** Sets the demo account's password and authenticator secret on a seeded database. */
export async function setDemoLogin(dataDir: string): Promise<void> {
  const db = openDb(join(dataDir, 'memory.db'));
  const auth = new OwnerAuth(db, () => new Date());
  await auth.setPassword(DEMO_PASSWORD);
  auth.setTotpSecret(DEMO_TOTP_SECRET);
  db.close();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [arg] = process.argv.slice(2);
  if (arg === '--code') {
    console.log(totpAt(DEMO_TOTP_SECRET, Math.floor(Date.now() / 30_000)));
  } else if (!arg || arg.startsWith('-')) {
    console.error('usage: npm run demo:seed -- <new data folder>   |   npm run demo:code');
    process.exit(2);
  } else {
    const embedder = await createLocalEmbedder({ modelDir: process.env.MODEL_DIR ?? './models', allowRemote: false });
    const r = await seedDemo(arg, embedder);
    await setDemoLogin(arg);
    console.log(`Seeded ${r.facts} facts and ${r.pages} pages in ${arg}.`);
    console.log(`Start it:  DATA_DIR=${arg} PUBLIC_URL=http://localhost:3000 npm run dev`);
    console.log(`Sign in with the password "${DEMO_PASSWORD}" and the code from: npm run demo:code`);
    console.log('This login is public: keep this folder for the sample data only, never for your own memories.');
    console.log('The sample week is dated from today: delete the folder and seed again for a fresh one.');
  }
}
