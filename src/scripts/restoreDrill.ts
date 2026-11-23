/**
 * The restore drill: proves, from nothing but the saved copies, that a brain comes back whole on a clean machine.
 *
 *   npm run drill:restore -- [--out bench-results] [--real-model] [--keep]
 *
 * It builds a source brain in a temp folder (never the owner's real data, HOME pointed at a temp folder too), records a
 * fingerprint of it, then for each way of saving a brain it makes that copy, restores it onto a new empty machine the way
 * docs/RUNBOOK.md says, starts the real app on the result and checks it against the fingerprint. The checks, with
 * PASS / FAIL / SKIPPED, are printed and written to <out>/restore-drill-<date>.json. docs/RESTORE-DRILL.md explains it.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import sharp from 'sharp';
import { backupNow } from '../backup.js';
import { latestSchema, openDb } from '../db.js';
import { profileFor } from '../memory/embeddingProfile.js';
import { createLocalEmbedder, type Embedder } from '../memory/embedder.js';
import { createFakeEmbedder } from '../memory/fakeEmbedder.js';
import type { MemoryService } from '../memory/service.js';
import type { Actor } from '../memory/types.js';
import { exportTree, writeTree } from '../pages/exportTree.js';
import { applyPendingRestore, stageRestore } from '../saved/restore.js';
import { makeSavedCopy } from '../saved/savedCopy.js';
import { totpAt } from '../auth/totp.js';
import { connectClient, loggedIn, seedSignIn, startTestApp, TEST_PASSWORD, TEST_TOTP_SECRET } from '../testing/helpers.js';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

export type Status = 'PASS' | 'FAIL' | 'SKIPPED';
export interface Check { path: string; name: string; status: Status; detail: string }
type App = Awaited<ReturnType<typeof startTestApp>>;

// ---- What the drill puts in the source brain ----

const owner: Actor = { type: 'owner' };
const claudeCode: Actor = { type: 'ai', name: 'Claude Code' };
const codex: Actor = { type: 'ai', name: 'Codex' };
const PROJECT = 'harbor-app';
const FORGOTTEN = 'Harbor app keeps login sessions in a self-hosted Redis cache.';

/** Ten fixed questions: the top 3 facts for each must be the same after a restore. */
const FACT_QUERIES = [
  'where are boat photos stored', 'which database holds the bookings', 'how is the harbor app deployed',
  'which provider sends booking emails', 'what is the payment status', 'where does the owner live',
  'what is the sailing club newsletter schedule', 'how are tide tables fetched', 'what colour is the app logo',
  'who answers customer support mail',
];
const PAGE_QUERIES = ['how the harbor app stores pictures', 'deployment steps and rollback', 'tide data source'];

/** What the source brain holds that the checks need to know by name. */
interface Source { forgottenId: string; heldIds: string[]; accessToken: string; refreshToken: string; clientId: string; pictureIds: string[] }

async function png(r: number, g: number, b: number): Promise<Buffer> {
  return sharp({ create: { width: 48, height: 32, channels: 3, background: { r, g, b } } }).png().toBuffer();
}

async function saved(service: MemoryService, input: Parameters<MemoryService['remember']>[0], actor: Actor) {
  const r = await service.remember(input, actor);
  if (r.status !== 'saved') throw new Error(`drill fixture not saved (${r.status}): ${input.content}`);
  return r.memory;
}

/** Fills the source brain through the real services and the real OAuth flow. */
async function populate(app: App): Promise<Source> {
  const { service, pages, images, discussions } = app.deps;
  const db = app.deps.db!;
  const decision = (content: string, extra: Partial<Parameters<MemoryService['remember']>[0]> = {}, actor: Actor = owner) =>
    saved(service, { kind: 'decision', content, project: PROJECT, ...extra }, actor);

  // Facts of several kinds, with a date and a source set by the owner and by assistants.
  await decision('Harbor app stores boat photos in an S3-compatible bucket in Frankfurt.', { tags: ['storage'], keys: 'photos bucket', meta: { validUntil: '2027-06-30', source: 'owner_said', sourceNote: 'said in the 2026-11-02 call' } });
  await decision('Harbor app uses Postgres 16 for the booking database.', { allowDuplicate: true, meta: { validUntil: '2027-01-31', source: 'inferred', sourceNote: 'session 2026-11-10' } }, claudeCode);
  await decision('Booking emails of the harbor app go through the Postmark provider.', { allowDuplicate: true, meta: { source: 'imported' } }, codex);
  await decision('Tide tables for the harbor app are fetched every night from the national hydrographic office.', { tags: ['tides', 'cron'] });
  await decision('The sailing club newsletter goes out on the first Monday of each month.', { project: 'sailing-club' });
  await decision('The harbor app logo is dark teal with a white anchor.', { meta: { validUntil: '2026-12-31' } });
  await decision('Customer support mail for the harbor app is answered by Marta on weekdays.');
  await saved(service, { kind: 'summary', content: 'Status: the payment flow is done, refunds are still open.', project: PROJECT, allowDuplicate: true, meta: { source: 'inferred', sourceNote: 'Claude Code session' } }, claudeCode);
  await saved(service, { kind: 'profile', content: 'Lives in Lisbon and builds marine software.' }, owner);

  // A chain: a decision replaced by a newer one (a supersedes link).
  const oldDeploy = await decision('Harbor app deploys with Docker Compose on a single server.');
  const newDeploy = await decision('Harbor app deploys with Kubernetes on two servers.', { supersedes: [oldDeploy.id] });

  // A fact updated twice (history rows).
  const email = await decision('Booking confirmations are sent from the address bookings@example.org.');
  await service.update(email.id, { content: 'Booking confirmations are sent from the address harbor@example.org.' }, owner);
  await service.update(email.id, { content: 'Booking confirmations are sent from the address harbor@example.org.', tags: ['email'] }, owner);

  // A fact the owner forgot. Forgetting that sticks is checked after each restore.
  // Two facts that cannot both be true, flagged for the owner; and another name for the project.
  const sqlA = await decision('Harbor app reports run on SQLite.', { allowDuplicate: true }, claudeCode);
  const sqlB = await decision('Harbor app reports run on DuckDB.', { allowDuplicate: true }, codex);
  service.flagDisagreement(sqlA.id, sqlB.id, 'SQLite or DuckDB for the reports', claudeCode);
  service.addAlias('harbour-app', PROJECT, owner);
  const forgotten = await decision(FORGOTTEN);
  service.forget(forgotten.id, owner);

  // Held for the owner: an assistant's profile change waits for approval.
  const held = await service.remember({ kind: 'profile', content: 'Prefers tabs over spaces in all code.' }, claudeCode);
  if (held.status !== 'suggested') throw new Error(`drill fixture should be held, got ${held.status}`);

  // Pages: several sections, three versions, a picture, and a deleted page.
  const [pictureA, pictureB] = [images.add(await png(200, 80, 40), { alt: 'Harbor map', by: 'owner' }), images.add(await png(30, 120, 160), { alt: 'Dock photo', by: 'Claude Code' })];
  await pages.create({ title: 'Sailing club notes', area: 'personal', body: '# Sailing club notes\n\n## Newsletter\nFirst Monday of the month.\n' }, 'Claude Code');
  const arch = await pages.create({
    title: 'Harbor app architecture', project: PROJECT,
    body: `# Harbor app architecture\n\n## Overview\nThe harbor app books berths. See also [[Sailing club notes]].\n\n## Storage\nPictures go to the bucket, how the harbor app stores pictures is described here.\n\n![Harbor map](/images/${pictureA.id}.png)\n\n## Deploy\nDeployment steps and rollback: apply the manifests, then check the health page.\n`,
  }, 'owner');
  const v2 = await pages.saveSection(arch.id, { base: arch.version, anchor: 'storage', text: `## Storage\nPictures go to the bucket; thumbnails are made on upload. How the harbor app stores pictures is described here.\n\n![Harbor map](/images/${pictureA.id}.png)\n` }, 'Claude Code');
  await pages.save(arch.id, { base: v2.version, body: `${v2.body}\n## Tides\nTide data source: the national hydrographic office, fetched nightly.\n\n![Dock](/images/${pictureB.id}.png)\n` }, 'owner');
  const gone = await pages.create({ title: 'Old harbor plan', area: 'work', body: '# Old harbor plan\n\n## Idea\nDropped.\n' }, 'owner');
  pages.remove(gone.id, 'owner');

  // A note on a page, a shared skill with two versions, and a skill an assistant proposed.
  app.deps.notes.add(arch.id, { text: 'Check the bucket region before the next release.' });
  const skill = app.deps.skills.create({ name: 'harbor-release', description: 'How to release the harbor app', body: 'Run the checks, then tag the release.', files: [{ path: 'checklist.md', text: '- tests\n- tag\n' }] }, 'owner');
  app.deps.skills.update(skill.id, { base: skill.version, body: 'Run the checks, tag the release, then tell the club.' }, 'owner');
  app.deps.skills.propose({ name: 'harbor-tides', description: 'Fetch tide tables', body: 'Fetch them nightly.', files: [] }, 'Claude Code');

  // A discussion two assistants answered.
  const d = discussions.open({ name: 'Claude Code', model: 'Claude Opus', access: 'full' }, { title: 'Queue or cron for tides?', question: 'Should the tide fetch be a cron job or a queue worker?', files: [{ name: 'tides.md', content: 'The office publishes tables at 02:00 UTC.' }] });
  discussions.reply({ name: 'Codex', model: 'GPT', access: 'full' }, d.id, { text: 'A cron job is enough for one fetch a night.' });

  // An OAuth client with a grant and live tokens (the real flow), and a registration that never got a grant.
  const f = await loggedIn(app);
  const { accessToken, refreshToken, clientId } = await connectClient(app.baseUrl, f, 'Claude Code');
  await fetch(app.baseUrl + '/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ redirect_uris: ['http://localhost:9998/callback'], client_name: 'Unused app', token_endpoint_auth_method: 'none' }) });
  // The owner sign-in set: replaces the live one with recognisable values, plus sessions, a device and a client secret.
  const realOwner = db.prepare('SELECT password_hash, totp_secret, totp_last_step FROM owner WHERE id = 1').get() as { password_hash: string; totp_secret: string; totp_last_step: number | null };
  db.prepare('DELETE FROM owner').run();
  seedSignIn(db);
  // seedSignIn's owner row has marker values; the live owner (TEST_PASSWORD and its authenticator) goes back, so the source can really sign in.
  db.prepare('UPDATE owner SET password_hash = ?, totp_secret = ?, totp_last_step = ? WHERE id = 1').run(realOwner.password_hash, realOwner.totp_secret, realOwner.totp_last_step);
  return { forgottenId: forgotten.id, heldIds: service.pendingSuggestions().map((s) => s.id), accessToken, refreshToken, clientId, pictureIds: [pictureA.id, pictureB.id] };
}

// ---- The fingerprint ----

/** Tables whose rows must come back identical, by what they hold. */
const CONTENT: Record<string, string[]> = {
  'facts (all fields)': ['memories'],
  'history': ['memory_history'],
  'supersedes links': ['supersessions', 'disagreements'],
  'held items': ['profile_suggestions'],
  'pages, sections, versions': ['pages', 'page_versions', 'page_sections', 'page_links', 'page_images'],
  'picture rows': ['images'],
  'discussions': ['discussions', 'discussion_posts', 'discussion_files'],
  'projects and aliases': ['projects', 'project_aliases'],
  'skills and proposals': ['skills', 'skill_versions', 'skill_files', 'skill_proposals'],
  'notes': ['notes'],
};
const SIGN_IN = ['owner', 'sessions', 'known_devices', 'device_tokens', 'oauth_tokens', 'oauth_codes', 'oauth_pending', 'image_upload_links', 'folder_reports'];
const CLIENTS = ['oauth_clients', 'oauth_grants', 'redirect_allowlist'];
/** Columns that change by being read, not by being edited. */
const IGNORED_COLUMNS: Record<string, string[]> = { memories: ['last_recalled_at'] };

interface TableFp { count: number; hash: string; rows: string[] }
export interface Fingerprint {
  schema: number;
  tables: Record<string, TableFp>;
  images: Record<string, string>;
  recall: Record<string, string[]>;
  pages: Record<string, string[]>;
  liveFacts: number;
}

const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

function tableFp(db: Database.Database, table: string): TableFp | null {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)) return null;
  const skip = new Set(IGNORED_COLUMNS[table] ?? []);
  const rows = (db.prepare(`SELECT * FROM ${table}`).all() as Record<string, unknown>[]).map((r) => {
    const o: Record<string, unknown> = {};
    for (const k of Object.keys(r).sort()) {
      if (skip.has(k)) continue;
      const v = r[k];
      o[k] = Buffer.isBuffer(v) ? `blob:${sha(v)}` : v;
    }
    // A client secret is replaced by a backup on purpose: compared separately.
    if (table === 'oauth_clients' && typeof o.metadata === 'string') {
      const m = JSON.parse(o.metadata) as Record<string, unknown>;
      delete m.client_secret;
      o.metadata = m;
    }
    return JSON.stringify(o);
  }).sort();
  return { count: rows.length, hash: sha(rows.join('\n')), rows };
}

/** Every picture file under images/ (not the store's tmp folder) as relative path to sha256. */
function pictureFiles(dataDir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const root = join(dataDir, 'images');
  if (!existsSync(root)) return out;
  for (const sub of readdirSync(root).filter((d) => d !== 'tmp')) {
    for (const f of readdirSync(join(root, sub))) out[`${sub}/${f}`] = sha(readFileSync(join(root, sub, f)));
  }
  return out;
}

async function recallIds(app: App): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  for (const q of FACT_QUERIES) out[q] = (await app.deps.service.recall({ query: q, limit: 3, touch: false })).map((r) => r.memory.id);
  return out;
}

async function pageHits(app: App, minSimilarity: number): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  for (const q of PAGE_QUERIES) {
    const hits = app.deps.pages.search(q, await app.deps.pages.embedQuery(q), 3, minSimilarity);
    out[q] = hits.map((h) => `${h.page.id}#${h.anchor}`);
  }
  return out;
}

async function fingerprint(app: App, dataDir: string, minSimilarity: number): Promise<Fingerprint> {
  const db = app.deps.db!;
  const tables: Record<string, TableFp> = {};
  for (const t of [...Object.values(CONTENT).flat(), ...SIGN_IN, ...CLIENTS]) {
    const fp = tableFp(db, t);
    if (fp) tables[t] = fp;
  }
  return {
    schema: (db.prepare('SELECT version FROM schema_version').get() as { version: number }).version,
    tables, images: pictureFiles(dataDir), recall: await recallIds(app), pages: await pageHits(app, minSimilarity),
    liveFacts: (db.prepare('SELECT COUNT(*) AS n FROM memories WHERE deleted_at IS NULL').get() as { n: number }).n,
  };
}

/** The first rows that differ, for a message a person can act on. */
function diffRows(a: TableFp, b: TableFp): string {
  const missing = a.rows.filter((r) => !b.rows.includes(r));
  const extra = b.rows.filter((r) => !a.rows.includes(r));
  return `source ${a.count} rows, restored ${b.count}; ${missing.length} missing, ${extra.length} changed or extra; e.g. ${(missing[0] ?? extra[0] ?? '').slice(0, 160)}`;
}

// ---- Machines, shell, report ----

interface Machine { dir: string; dataDir: string; home: string }
function machine(root: string, name: string): Machine {
  const dir = join(root, name);
  const m = { dir, dataDir: join(dir, 'data'), home: join(dir, 'home') };
  mkdirSync(m.dataDir, { recursive: true });
  mkdirSync(m.home, { recursive: true });
  return m;
}

function sh(cmd: string, env: Record<string, string> = {}, cwd = REPO): string {
  return execFileSync('bash', ['-c', cmd], { cwd, env: { ...process.env, ...env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** The real CLI in its own process, as the RUNBOOK runs it (`docker compose run --rm app node dist/cli.js restore …`). */
function cli(args: string[], m: Machine): { code: number; out: string } {
  const r = spawnSync(process.execPath, ['--import', 'tsx', join(REPO, 'src/cli.ts'), ...args], { cwd: REPO, env: { ...process.env, DATA_DIR: m.dataDir, HOME: m.home }, encoding: 'utf8' });
  return { code: r.status ?? -1, out: `${r.stdout}${r.stderr}`.trim() };
}

class Report {
  checks: Check[] = [];
  add(path: string, name: string, ok: boolean, detail = ''): void { this.checks.push({ path, name, status: ok ? 'PASS' : 'FAIL', detail }); }
  skip(path: string, name: string, detail: string): void { this.checks.push({ path, name, status: 'SKIPPED', detail }); }
  /** Runs one step of a path; a throw is a FAIL of that step, so one broken path never stops the drill. */
  async step<T>(path: string, name: string, work: () => Promise<T> | T): Promise<T | undefined> {
    try {
      const v = await work();
      this.add(path, name, true, typeof v === 'string' ? v : '');
      return v;
    } catch (e) {
      this.add(path, name, false, e instanceof Error ? e.message.split('\n').slice(0, 3).join(' | ') : String(e));
      return undefined;
    }
  }
}

// ---- Verifying a restored brain ----

interface Env { embedder: Embedder; serviceOpts: ConstructorParameters<typeof MemoryService>[2]; minPageSimilarity: number }

/**
 * Starts the real app on `dataDir` and checks everything against the source fingerprint. `signIn` says what the path is
 * meant to do with the owner's sign-in data: a backup strips it, a full copy (the pre-migrate one) keeps it.
 */
async function verify(r: Report, path: string, m: Machine, fp: Fingerprint, src: Source, env: Env, signIn: 'stripped' | 'kept', pictures: 'files' | 'none' = 'files'): Promise<void> {
  const integrity = new Database(join(m.dataDir, 'memory.db'), { readonly: true });
  try {
    r.add(path, 'integrity_check is ok', integrity.pragma('integrity_check', { simple: true }) === 'ok');
  } finally { integrity.close(); }
  let app: App;
  try {
    // No password on the new machine: what the owner finds after a restore, before setting it again.
    app = await startTestApp({ dataDir: m.dataDir, embedder: env.embedder, serviceOpts: env.serviceOpts, noPassword: true });
  } catch (e) {
    r.add(path, 'the app starts on the restored data', false, e instanceof Error ? e.message : String(e));
    return;
  }
  try {
    r.add(path, 'the app starts on the restored data', true);
    const db = app.deps.db!;
    const now = await fingerprint(app, m.dataDir, env.minPageSimilarity);
    for (const [group, tables] of Object.entries(CONTENT)) {
      const bad = tables.filter((t) => fp.tables[t] && (now.tables[t]?.hash !== fp.tables[t]!.hash)).map((t) => `${t}: ${now.tables[t] ? diffRows(fp.tables[t]!, now.tables[t]!) : 'table missing'}`);
      r.add(path, `${group} identical`, bad.length === 0, bad.length === 0 ? `${tables.map((t) => `${t} ${fp.tables[t]?.count ?? 0}`).join(', ')} rows` : bad.join(' ; '));
    }
    // Facts through the API: every field a person sees.
    const ids = (db.prepare('SELECT id FROM memories ORDER BY id').all() as { id: string }[]).map((x) => x.id);
    const apiBad = ids.filter((id) => { const a = app.deps.store.get(id); return !a || a.content === undefined; });
    r.add(path, 'every fact reads back through the service', apiBad.length === 0 && ids.length === fp.tables.memories!.count, `${ids.length} facts`);

    if (pictures === 'files') {
      const missing = Object.keys(fp.images).filter((f) => now.images[f] !== fp.images[f]);
      r.add(path, 'picture files present with the same sha256', missing.length === 0 && Object.keys(fp.images).length > 0, `${Object.keys(fp.images).length} files; ${missing.length} missing or changed`);
      const rows = db.prepare('SELECT id, type FROM images WHERE removed_at IS NULL').all() as { id: string; type: string }[];
      const noFile = rows.filter((x) => !existsSync(join(m.dataDir, 'images', x.id.slice(0, 2), `${x.id}.${x.type === 'jpeg' ? 'jpg' : x.type}`)));
      r.add(path, 'every live picture row has its file (RUNBOOK check)', noFile.length === 0, `${rows.length} live rows`);
    }

    const recallBad = FACT_QUERIES.filter((q) => JSON.stringify(now.recall[q]) !== JSON.stringify(fp.recall[q]));
    const hits = Object.values(fp.recall).filter((x) => x.length > 0).length;
    r.add(path, 'recall: same top 3 for 10 fixed questions', recallBad.length === 0 && hits >= 7, `${hits}/10 questions had hits; ${recallBad.length} differ`);
    const pageBad = PAGE_QUERIES.filter((q) => JSON.stringify(now.pages[q]) !== JSON.stringify(fp.pages[q]));
    r.add(path, 'page search: same top 3 for 3 fixed questions', pageBad.length === 0 && Object.values(fp.pages).some((x) => x.length > 0), `${pageBad.length} differ`);

    // Held and forgotten.
    const pending = app.deps.service.pendingSuggestions().map((s) => s.id).sort();
    r.add(path, 'the held item is still held', JSON.stringify(pending) === JSON.stringify([...src.heldIds].sort()) && pending.length > 0, `${pending.length} waiting`);
    const row = db.prepare('SELECT deleted_at, deleted_by FROM memories WHERE id = ?').get(src.forgottenId) as { deleted_at: string | null; deleted_by: string | null } | undefined;
    r.add(path, 'the forgotten fact is still deleted', !!row?.deleted_at && row.deleted_by === 'owner', row ? `deleted ${row.deleted_at}` : 'row missing');
    const inRecall = (await app.deps.service.recall({ query: FORGOTTEN, limit: 8, touch: false })).some((x) => x.memory.id === src.forgottenId);
    r.add(path, 'the forgotten fact is not in recall', !inRecall);
    const again = await app.deps.service.remember({ kind: 'decision', content: FORGOTTEN, project: PROJECT, allowDuplicate: true }, claudeCode);
    const live = (db.prepare('SELECT COUNT(*) AS n FROM memories WHERE content = ? AND deleted_at IS NULL').get(FORGOTTEN) as { n: number }).n;
    r.add(path, 'an assistant re-saving the forgotten text is held, not saved', again.status === 'suggested' && again.suggestion.deletedMatch === src.forgottenId && live === 0, `status ${again.status}`);

    await signInChecks(r, path, app, fp, src, signIn);
  } finally {
    await app.close();
  }
}

/** A sign-in with the test password and the authenticator code of the moment (`ahead` ms later on the app's clock). */
async function signInAttempt(app: App, ahead: number): Promise<{ session: boolean; status: number }> {
  if (ahead > 0) app.advance(ahead);
  const code = totpAt(TEST_TOTP_SECRET, Math.floor((Date.now() + ahead) / 30_000));
  const res = await fetch(app.baseUrl + '/login', { method: 'POST', redirect: 'manual', headers: { Origin: app.baseUrl, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ password: TEST_PASSWORD, code }) });
  return { status: res.status, session: res.headers.getSetCookie().some((c) => c.startsWith('mem_session=') && !/mem_session=;/.test(c)) };
}

/** Tokens, sessions, the owner sign-in and the registered apps, as the RUNBOOK (steps 6 and 9) says they end up. */
async function signInChecks(r: Report, path: string, app: App, fp: Fingerprint, src: Source, signIn: 'stripped' | 'kept'): Promise<void> {
  const db = app.deps.db!;
  const count = (t: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
  // Restoring a saved copy (security review #11) also drops registered apps and their connections and resets the allowlist.
  const resets = signIn === 'stripped' && (path === PATHS.b1 || path === PATHS.b2);
  if (signIn === 'stripped') {
    const left = SIGN_IN.filter((t) => count(t) > 0);
    r.add(path, 'no sign-in data comes back (owner, sessions, devices, tokens, codes)', left.length === 0, left.length ? `still holding rows: ${left.join(', ')}` : SIGN_IN.map((t) => `${t} ${fp.tables[t]?.count ?? 0}→0`).join(', '));
    const mcp = await fetch(app.baseUrl + '/mcp', { method: 'POST', headers: { Authorization: `Bearer ${src.accessToken}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"drill","version":"1"}}}' });
    r.add(path, 'the old access token is rejected (401)', mcp.status === 401, `HTTP ${mcp.status}`);
    const refresh = await fetch(app.baseUrl + '/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: src.refreshToken, client_id: src.clientId }) });
    // OAuth answers a refresh token it does not know with 400 invalid_grant; any refusal keeps the grant closed.
    r.add(path, 'the old refresh token is rejected', refresh.status === 400 || refresh.status === 401, `HTTP ${refresh.status}`);
    r.add(path, 'the owner sign-in is absent (password must be set again)', !app.deps.owner.hasPassword() && count('owner') === 0);
    // The source's own password and a valid authenticator code (the source signs in with them: see the control in runDrill).
    const login = await signInAttempt(app, 0);
    r.add(path, 'the old password and a valid authenticator code do not sign in', !login.session, `HTTP ${login.status}`);
    const secret = db.prepare("SELECT metadata FROM oauth_clients WHERE client_id = 'c1'").get() as { metadata: string } | undefined;
    // A saved copy (b1, b2) drops registered apps altogether; a backup file keeps them with a fresh secret.
    r.add(path, resets ? 'no client or its secret comes back' : 'a client secret is replaced, not kept', resets ? !secret : !!secret && !secret.metadata.includes('CLIENTSECRETMARKER'));
  } else {
    const equal = SIGN_IN.filter((t) => fp.tables[t] && (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n !== fp.tables[t]!.count);
    r.add(path, 'a full copy keeps the sign-in data (it is a private copy of the whole file)', equal.length === 0, equal.length ? `differs: ${equal.join(', ')}` : `owner ${fp.tables.owner?.count}, tokens ${fp.tables.oauth_tokens?.count}`);
    // The kept owner really signs in: the clock moves past the source's last used step, so the code is not a replay.
    const login = await signInAttempt(app, 10 * 60_000);
    r.add(path, 'the kept password and authenticator sign in', login.session, `HTTP ${login.status}`);
  }
  // Registrations and grants: step 9 says they are kept (the app only signs in again).
  // By row hash, not count (the client secret is left out of the hash: it is replaced on purpose, checked above).
  if (resets) {
    r.add(path, 'registered apps and connections are dropped, the allowlist is back to the defaults', count('oauth_clients') === 0 && count('oauth_grants') === 0 && count('redirect_allowlist') === 3, CLIENTS.map((t) => `${t} ${fp.tables[t]?.count}→${count(t)}`).join(', '));
    return;
  }
  const bad = CLIENTS.filter((t) => fp.tables[t] && tableFp(db, t)?.hash !== fp.tables[t]!.hash);
  r.add(path, 'registered apps and their access levels are kept', bad.length === 0, CLIENTS.map((t) => `${t} ${fp.tables[t]?.count}→${count(t)}`).join(', '));
}

// ---- The restore paths ----

const today = (): string => new Date().toISOString().slice(0, 10);

/** Which restore paths exist, so the test and the report agree on the names. */
export const PATHS = {
  a1: 'a1 nightly backup.sh snapshot + images copy',
  a2: 'a2 in-app BACKUP_DIR snapshot + images',
  b1: 'b1 saved copy (restore CLI)',
  b2: 'b2 saved copy (app: stage + start-up swap)',
  c: 'c off-site encrypted pack (age)',
  d1: 'd1 failed migration (rolled back)',
  d2: 'd2 failed upgrade: back to the pre-migrate copy',
} as const;

/** RUNBOOK section 3, steps 2 and 3: the copy in place of the database, and the integrity check. */
function putDatabaseIn(m: Machine, dbFile: string): void {
  sh(`cp "${dbFile}" "${m.dataDir}/memory.db" && rm -f "${m.dataDir}/memory.db-wal" "${m.dataDir}/memory.db-shm"`);
  const verdict = sh(`sqlite3 "${m.dataDir}/memory.db" 'PRAGMA integrity_check'`).trim();
  if (verdict !== 'ok') throw new Error(`integrity_check said: ${verdict}`);
}

/** RUNBOOK section 3, step 5's last command: prints nothing when every live picture has its file. */
function pictureGaps(m: Machine): string {
  return sh(`sqlite3 "${m.dataDir}/memory.db" "SELECT substr(id,1,2)||'/'||id||'.'||CASE type WHEN 'jpeg' THEN 'jpg' ELSE type END FROM images WHERE removed_at IS NULL" | while read -r f; do [ -f "${m.dataDir}/images/$f" ] || echo "missing: $f"; done`).trim();
}

/** Steps 2 to 5 with the pictures from a copy folder (rsync). */
function restoreFromCopyFolder(m: Machine, dbFile: string, imagesDir: string): string {
  putDatabaseIn(m, dbFile);
  sh(`rsync -a "${imagesDir}/" "${m.dataDir}/images/"`);
  const missing = pictureGaps(m);
  if (missing) throw new Error(missing);
  return 'copied, integrity ok, every picture file there';
}

async function pathA(r: Report, root: string, appDir: string, fp: Fingerprint, src: Source, env: Env, home: string): Promise<void> {
  // a1: the real scripts/backup.sh against the running source (APP_DIR is its clone folder).
  const copyDir = join(root, 'drive-copy');
  const p1 = PATHS.a1;
  const ok = await r.step(p1, 'scripts/backup.sh makes the snapshot and the images copy', () => {
    sh(`"${REPO}/scripts/backup.sh"`, { APP_DIR: appDir, COPY_DIRS: copyDir, SKIP_MOUNT_CHECK: '1', HOME: home });
    return 'snapshot + copy dir written';
  });
  if (ok !== undefined) {
    const m = machine(root, 'machine-a1');
    const file = readdirSync(join(appDir, 'backups')).find((f) => /^memory-\d{4}-\d{2}-\d{2}\.db$/.test(f))!;
    // From the copy folder, as the RUNBOOK says ("one of your COPY_DIRS").
    if (await r.step(p1, 'RUNBOOK 3: copy in, integrity_check, rsync the pictures', () => restoreFromCopyFolder(m, join(copyDir, file), join(copyDir, 'images'))) !== undefined) await verify(r, p1, m, fp, src, env, 'stripped');
  }

  // a2: the app's own snapshot (BACKUP_DIR), the same file format and the same picture copy.
  const p2 = PATHS.a2;
  const dir = join(root, 'backup-dir');
  const live = new Database(join(appDir, 'data', 'memory.db'), { readonly: true });
  try {
    const made = await r.step(p2, 'the app writes memory-<date>.db and copies the pictures', async () => {
      const file = await backupNow(live as never, dir, 7, new Date(), join(appDir, 'data'));
      return file;
    });
    if (made) {
      const m = machine(root, 'machine-a2');
      if (await r.step(p2, 'RUNBOOK 3: copy in, integrity_check, rsync the pictures', () => restoreFromCopyFolder(m, made, join(dir, 'images'))) !== undefined) await verify(r, p2, m, fp, src, env, 'stripped');
    }
  } finally { live.close(); }
}

async function pathB(r: Report, root: string, source: App, appDir: string, fp: Fingerprint, src: Source, env: Env): Promise<void> {
  const p1 = PATHS.b1;
  const dataDir = join(appDir, 'data');
  const made = await r.step(p1, 'Save a copy of everything makes brainai-saved-<date>.tar.gz', async () => {
    const d = source.deps;
    return makeSavedCopy({ db: d.db!, dataDir, pages: d.pages, memoryStore: d.store, memories: d.service, skills: d.skills }, join(root, 'saved'), new Date(), []);
  });
  if (!made) return;
  const m = machine(root, 'machine-b1');
  const res = cli(['restore', made.archive], m);
  r.add(p1, 'cli restore brings the archive into an empty brain', res.code === 0 && /Restored/.test(res.out), res.out.slice(0, 120));
  // It only fills an empty brain: the same command again must refuse and change nothing.
  const before = sha(readFileSync(join(m.dataDir, 'memory.db')));
  const again = cli(['restore', made.archive], m);
  r.add(p1, 'a second restore refuses a non-empty brain and changes nothing', again.code !== 0 && /already has memories/.test(again.out) && sha(readFileSync(join(m.dataDir, 'memory.db'))) === before, again.out.slice(0, 120));
  if (res.code === 0) await verify(r, p1, m, fp, src, env, 'stripped');

  // The app's "I have a saved BrainAI folder": stage, then the server swaps it in before the database opens.
  const p2 = PATHS.b2;
  const m2 = machine(root, 'machine-b2');
  const staged = await r.step(p2, 'the app stages the saved copy', async () => { const c = await stageRestore(made.archive, m2.dataDir); return `${c.facts} facts, ${c.pages} pages`; });
  if (staged !== undefined) {
    const swapped = await r.step(p2, 'the server swaps it in at start-up', () => { const c = applyPendingRestore(m2.dataDir); if (!c) throw new Error('nothing was swapped in'); return `${c.facts} facts, ${c.pages} pages`; });
    if (swapped !== undefined) await verify(r, p2, m2, fp, src, env, 'stripped');
  }
}

function haveAge(): boolean {
  return spawnSync('sh', ['-c', 'command -v age && command -v age-keygen'], { encoding: 'utf8' }).status === 0;
}

async function pathC(r: Report, root: string, source: App, appDir: string, fp: Fingerprint, src: Source, env: Env, home: string, skipped?: string): Promise<void> {
  const p = PATHS.c;
  if (skipped) { r.skip(p, 'off-site pack', skipped); return; }
  if (!haveAge()) { r.skip(p, 'off-site pack', '`age` and `age-keygen` are not installed on this computer (the drill never installs software)'); return; }
  const work = join(root, 'offsite');
  mkdirSync(join(work, 'bin'), { recursive: true });
  // A throwaway key, and a stand-in rclone that "uploads" to a local folder, so the real offsite.sh runs unchanged.
  sh(`age-keygen -o "${work}/key.txt" 2>/dev/null && age-keygen -y "${work}/key.txt" > "${work}/recipient.txt"`);
  writeFileSync(join(work, 'bin', 'rclone'), `#!/bin/bash
cmd=$1; shift
case $cmd in
  copy) mkdir -p "$2"; cp "$1" "$2/" ;;
  copyto) mkdir -p "$(dirname "$2")"; cp "$1" "$2" ;;
  lsf) ls -1 "$1" 2>/dev/null ;;
  deletefile) rm -f "$1" ;;
  *) : ;;
esac
`);
  chmodSync(join(work, 'bin', 'rclone'), 0o755);
  const exportDir = join(work, 'brain-export');
  const d = source.deps;
  writeTree(exportDir, exportTree({ pages: d.pages, memoryStore: d.store, memories: d.service, skills: d.skills }, new Date()));
  const remote = join(work, 'remote');
  const sent = await r.step(p, 'scripts/offsite.sh packs, encrypts and "uploads"', () => {
    sh(`"${REPO}/scripts/offsite.sh"`, {
      APP_DIR: appDir, OFFSITE_REMOTE: remote, OFFSITE_RECIPIENT_FILE: join(work, 'recipient.txt'), BRAIN_EXPORT_DIR: exportDir,
      EXPORT_CMD: `DATA_DIR="${join(appDir, 'data')}" "${process.execPath}" --import tsx "${REPO}/src/cli.ts" export`,
      PATH: `${join(work, 'bin')}:${process.env.PATH}`, HOME: home,
    });
    return `${readdirSync(remote).filter((f) => f.endsWith('.age')).length} pack, ${existsSync(join(remote, 'images')) ? readdirSync(join(remote, 'images')).length : 0} pictures`;
  });
  if (sent === undefined) return;
  const m = machine(root, 'machine-c');
  // RUNBOOK: decrypt with the key, unpack, copy the database in; pictures one by one with the documented loop.
  const unpacked = await r.step(p, 'decrypt with the key and unpack (database, memory.md, page export)', () => {
    const pack = readdirSync(remote).find((f) => f.endsWith('.tar.gz.age'))!;
    mkdirSync(join(work, 'unpacked'), { recursive: true });
    sh(`age -d -i "${work}/key.txt" -o "${work}/pack.tar.gz" "${remote}/${pack}" && tar -xzf "${work}/pack.tar.gz" -C "${work}/unpacked"`);
    const names = readdirSync(join(work, 'unpacked'));
    const hasPages = existsSync(join(work, 'unpacked', 'brain-export', 'README.md'));
    if (!names.some((n) => /^memory-.*\.db$/.test(n)) || !names.includes('memory.md') || !hasPages) throw new Error(`pack holds ${names.join(', ')}`);
    return names.join(', ');
  });
  if (unpacked === undefined) return;
  await r.step(p, 'the page export in the pack holds the pages as Markdown', () => {
    const md = sh(`grep -rl "Harbor app architecture" "${work}/unpacked/brain-export" | head -1`).trim();
    if (!md) throw new Error('page not found in brain-export');
    return 'readable, but BrainAI does not read it back';
  });
  const dbFile = join(work, 'unpacked', readdirSync(join(work, 'unpacked')).find((f) => /^memory-.*\.db$/.test(f))!);
  const restored = await r.step(p, 'RUNBOOK 3: database copied in, pictures decrypted with the documented loop', () => {
    putDatabaseIn(m, dbFile);
    sh(`mkdir -p "${work}/images-age" && cp "${remote}/images/"*.age "${work}/images-age/" && cd "${work}/images-age" && for f in *.age; do d="\${f:0:2}"; mkdir -p "${m.dataDir}/images/$d"; age -d -i "${work}/key.txt" -o "${m.dataDir}/images/$d/\${f%.age}" "$f"; done`);
    const missing = pictureGaps(m);
    if (missing) throw new Error(missing);
    return 'every picture file there';
  });
  if (restored === undefined) return;
  await verify(r, p, m, fp, src, env, 'stripped');
}

/**
 * How the drill goes one schema back, and how it makes the next migration fail, keyed by the latest schema. A new
 * migration needs an entry here (a comment above MIGRATIONS in src/db.ts says so): without one, d1 and d2 are SKIPPED
 * and the CI test fails.
 */
const DOWNGRADES: Record<number, { down(db: Database.Database): void; breakNext(db: Database.Database): void }> = {
  // Migration 45 only adds discussions.opened_grant and discussion_posts.grant_id: dropping them is the old schema, and adding the first one back makes migration 45 throw.
  45: { down: (db) => { db.exec('ALTER TABLE discussions DROP COLUMN opened_grant; ALTER TABLE discussion_posts DROP COLUMN grant_id'); }, breakNext: (db) => { db.exec('ALTER TABLE discussions ADD COLUMN opened_grant TEXT'); } },
  // Migration 44 only may add the developer_coaching switch: deleting it is the old schema; a view in place of brain_switches makes migration 44 throw.
  44: { down: (db) => { db.exec("DELETE FROM brain_switches WHERE name = 'developer_coaching'"); }, breakNext: (db) => { db.exec('DROP TABLE brain_switches; CREATE VIEW brain_switches AS SELECT 1 AS name'); } },
  // Migration 43 only adds page_file_imports: dropping it is the old schema, and creating it first makes migration 43 throw.
  43: { down: (db) => { db.exec('DROP TABLE page_file_imports'); }, breakNext: (db) => { db.exec('CREATE TABLE page_file_imports(blocker TEXT)'); } },
};

async function pathD(r: Report, root: string, source: App, appDir: string, fp: Fingerprint, src: Source, env: Env): Promise<void> {
  const latest = latestSchema();
  const recipe = DOWNGRADES[latest];
  if (!recipe) {
    for (const p of [PATHS.d1, PATHS.d2]) r.skip(p, 'old schema', `no downgrade recipe for schema ${latest} in src/scripts/restoreDrill.ts (DOWNGRADES): add one`);
    return;
  }
  // The source brain as it was one schema ago: a full copy (like the real file the app held), with migration `latest` undone.
  const full = join(root, 'schema-old.db');
  await source.deps.db!.backup(full);
  const old = new Database(full);
  try {
    old.pragma('journal_mode = DELETE');
    recipe.down(old);
    old.prepare('UPDATE schema_version SET version = ?').run(latest - 1);
  } finally { old.close(); }
  const place = (name: string): Machine => {
    const m = machine(root, name);
    copyFileSync(full, join(m.dataDir, 'memory.db'));
    cpSync(join(appDir, 'data', 'images'), join(m.dataDir, 'images'), { recursive: true });
    return m;
  };
  const versionOf = (file: string) => { const db = new Database(file, { readonly: true }); try { return (db.prepare('SELECT version FROM schema_version').get() as { version: number }).version; } finally { db.close(); } };
  const copies = (m: Machine) => existsSync(join(m.dataDir, 'pre-migrate')) ? readdirSync(join(m.dataDir, 'pre-migrate')).filter((f) => f.endsWith('.db')) : [];

  // d1: the migration really throws half-way (its table is already there, so CREATE TABLE fails).
  const p1 = PATHS.d1;
  const m1 = place('machine-d1');
  const hashesOf = (file: string): Record<string, string> => {
    const db = new Database(file, { readonly: true });
    try { return Object.fromEntries(Object.values(CONTENT).flat().map((t) => [t, tableFp(db, t)?.hash ?? ''])); } finally { db.close(); }
  };
  // Taken once the blocker is in place (a recipe may alter a content table to block): what the failed migration must leave as it found it.
  let before: Record<string, string> = {};
  let threw = '';
  await r.step(p1, 'the next migration is made to fail', () => {
    const blocker = new Database(join(m1.dataDir, 'memory.db'));
    try { recipe.breakNext(blocker); } finally { blocker.close(); }
    before = hashesOf(join(m1.dataDir, 'memory.db'));
    try { openDb(join(m1.dataDir, 'memory.db')).close(); } catch (e) { threw = (e as Error).message; }
    return 'set up';
  });
  r.add(p1, 'the broken migration throws instead of half-applying', threw !== '', threw.slice(0, 100));
  r.add(p1, 'the database is left at the old schema version', versionOf(join(m1.dataDir, 'memory.db')) === latest - 1);
  r.add(p1, 'every content table is byte for byte what it was before', JSON.stringify(hashesOf(join(m1.dataDir, 'memory.db'))) === JSON.stringify(before));
  const c1 = copies(m1);
  r.add(p1, 'a pre-migrate copy was made first', c1.length === 1 && new RegExp(`^pre-migrate-${latest - 1}-to-${latest}-`).test(c1[0]!), c1.join(', '));
  const probe = new Database(join(m1.dataDir, 'memory.db'), { readonly: true });
  try {
    const facts = (probe.prepare('SELECT COUNT(*) AS n FROM memories').get() as { n: number }).n;
    r.add(p1, 'the facts are all still there after the failure', facts === fp.tables.memories!.count, `${facts} rows`);
  } finally { probe.close(); }

  // d2: an upgrade that worked but is not wanted: back to the pre-migrate copy, as RUNBOOK 3.
  const p2 = PATHS.d2;
  const m2 = place('machine-d2');
  openDb(join(m2.dataDir, 'memory.db')).close();
  const c2 = copies(m2);
  r.add(p2, 'the upgrade made a pre-migrate copy', c2.length === 1, c2.join(', '));
  if (c2.length !== 1) return;
  const copy = join(m2.dataDir, 'pre-migrate', c2[0]!);
  const chk = new Database(copy, { readonly: true });
  const verdict = chk.pragma('integrity_check', { simple: true });
  chk.close();
  r.add(p2, 'the pre-migrate copy is at the old schema and passes integrity_check', versionOf(copy) === latest - 1 && verdict === 'ok', `integrity ${String(verdict)}`);
  const mode = statSync(copy).mode & 0o777;
  r.add(p2, 'the pre-migrate copy is private (it holds the sign-in data, so group/other must not read it)', (mode & 0o077) === 0, `mode ${mode.toString(8)}`);
  // Back: keep the new database aside, drop its side files, put the copy in its place (the RUNBOOK's step 2), check it.
  const back = await r.step(p2, 'RUNBOOK 3 with the pre-migrate copy: broken db aside, copy in, integrity_check', () => {
    sh(`mv "${m2.dataDir}/memory.db" "${m2.dataDir}/memory.db.broken" && rm -f "${m2.dataDir}/memory.db-wal" "${m2.dataDir}/memory.db-shm" && cp "${copy}" "${m2.dataDir}/memory.db"`);
    const verdict = sh(`sqlite3 "${m2.dataDir}/memory.db" 'PRAGMA integrity_check'`).trim();
    if (verdict !== 'ok') throw new Error(verdict);
    return `back at schema ${versionOf(join(m2.dataDir, 'memory.db'))}`;
  });
  if (back === undefined) return;
  // What the previous version would do with it: open it without migrating further (openDb stopped at the old schema).
  const prev = openDb(join(m2.dataDir, 'memory.db'), { upTo: latest - 1 });
  try {
    const facts = (prev.prepare('SELECT COUNT(*) AS n FROM memories').get() as { n: number }).n;
    r.add(p2, 'the previous version (opened at the old schema) reads the old data', facts === fp.tables.memories!.count, `${facts} facts`);
  } finally { prev.close(); }
  // This version, started on it again, simply migrates it once more. A full copy keeps the sign-in data.
  await verify(r, p2, m2, fp, src, env, 'kept');
}

// ---- The drill ----

export interface DrillOptions { realModel?: boolean; modelDir?: string; keep?: boolean; /** Leave the off-site pack out (it needs age; the CI test runs without it). */ noOffsite?: boolean; log?: (line: string) => void }

export async function runDrill(opts: DrillOptions = {}): Promise<{ checks: Check[]; embedder: string; schema: number }> {
  let embedderName = 'fake test embedder';
  const root = mkdtempSync(join(tmpdir(), 'brainai-drill-'));
  const homeBefore = process.env.HOME; // undefined stays undefined afterwards
  const home = join(root, 'home');
  mkdirSync(home);
  process.env.HOME = home;
  const r = new Report();
  const log = opts.log ?? (() => {});
  let source: App | undefined;
  try {
    let embedder: Embedder = createFakeEmbedder();
    let serviceOpts: Env['serviceOpts'] = { duplicateThreshold: 0.9, minRecallSimilarity: 0.2, recallConfidentSimilarity: 0.2 };
    let minPageSimilarity = 0.2;
    if (opts.realModel) {
      const p = profileFor(process.env.EMBED_MODEL);
      embedder = await createLocalEmbedder({ modelDir: opts.modelDir ?? join(REPO, 'models'), allowRemote: false, model: p });
      serviceOpts = { duplicateThreshold: p.duplicate, minRecallSimilarity: p.minRecall, recallConfidentSimilarity: p.confident, recallWindow: p.window, keywordWeight: p.keywordWeight, closeFacts: p.closeFacts, deletedMargin: p.deletedMargin };
      embedderName = `real local model: ${p.id}`;
      minPageSimilarity = p.minRecall;
    }
    const env: Env = { embedder, serviceOpts, minPageSimilarity };
    // The source lives where a clone would: <app>/data, with backups/ beside it, so the real scripts run on it.
    const appDir = join(root, 'source-app');
    const dataDir = join(appDir, 'data');
    mkdirSync(dataDir, { recursive: true });
    log('building the source brain');
    source = await startTestApp({ dataDir, embedder, serviceOpts });
    const src = await populate(source);
    // Controls on the source, so a refusal after a restore means something: the refresh token works (and rotates, so the
    // fresh pair is the one a restore must refuse), the access token works, and the owner signs in with the right code.
    const rotated = await fetch(source.baseUrl + '/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: src.refreshToken, client_id: src.clientId }) });
    const pair = rotated.status === 200 ? await rotated.json() as { access_token: string; refresh_token: string } : null;
    r.add('source', 'the refresh token works on the source brain (control)', pair !== null, `HTTP ${rotated.status}`);
    if (pair) { src.accessToken = pair.access_token; src.refreshToken = pair.refresh_token; }
    const live = await fetch(source.baseUrl + '/mcp', { method: 'POST', headers: { Authorization: `Bearer ${src.accessToken}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"drill","version":"1"}}}' });
    r.add('source', 'the access token works on the source brain (control)', live.status === 200, `HTTP ${live.status}`);
    const signedIn = await loggedIn(source).then(() => true, () => false);
    r.add('source', 'the owner signs in on the source brain with the right password and code (control)', signedIn);
    const fp = await fingerprint(source, dataDir, minPageSimilarity);
    // Every group must hold something, or "identical" would be two empty tables agreeing.
    const empty = Object.values(CONTENT).flat().filter((t) => !fp.tables[t] || fp.tables[t]!.count === 0);
    const summary = `${fp.liveFacts} live facts, ${fp.tables.memory_history?.count} history rows, ${fp.tables.pages?.count} pages, ${fp.tables.page_versions?.count} versions, ${Object.keys(fp.images).length} picture files`;
    r.add('source', 'every table in the fingerprint holds rows', empty.length === 0 && Object.keys(fp.images).length >= 2 && (fp.tables.oauth_tokens?.count ?? 0) >= 2, empty.length ? `empty: ${empty.join(', ')}` : summary);
    log(`source: ${summary}`);

    for (const [name, work] of [
      ['a', () => pathA(r, root, appDir, fp, src, env, home)],
      ['b', () => pathB(r, root, source!, appDir, fp, src, env)],
      ['c', () => pathC(r, root, source!, appDir, fp, src, env, home, opts.noOffsite ? 'left out of this run (--no-offsite)' : undefined)],
      ['d', () => pathD(r, root, source!, appDir, fp, src, env)],
    ] as [string, () => Promise<void>][]) {
      log(`restore path ${name}`);
      try { await work(); } catch (e) { r.add(`path ${name}`, 'the drill step ran', false, e instanceof Error ? e.message : String(e)); }
    }
    return { checks: r.checks, embedder: embedderName, schema: fp.schema };
  } finally {
    await source?.close().catch(() => {});
    if (homeBefore === undefined) delete process.env.HOME; else process.env.HOME = homeBefore;
    if (!opts.keep) rmSync(root, { recursive: true, force: true });
    else console.log(`kept: ${root}`);
  }
}

function table(checks: Check[]): string {
  const w = Math.max(...checks.map((c) => c.path.length));
  return checks.map((c) => `${c.status.padEnd(7)} ${c.path.padEnd(w)}  ${c.name}${c.detail ? `  [${c.detail.slice(0, 110)}]` : ''}`).join('\n');
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const at = args.indexOf('--out');
  const out = at >= 0 ? args[at + 1] : 'bench-results';
  if (!out || out.startsWith('--')) { console.error('--out needs a folder: npm run drill:restore -- --out bench-results'); process.exit(2); }
  const realModel = args.includes('--real-model');
  const t0 = Date.now();
  const res = await runDrill({ realModel, modelDir: process.env.MODEL_DIR, keep: args.includes('--keep'), noOffsite: args.includes('--no-offsite'), log: (l) => console.log(`... ${l}`) });
  console.log(`\n${table(res.checks)}\n`);
  const count = (s: Status) => res.checks.filter((c) => c.status === s).length;
  mkdirSync(out, { recursive: true });
  const file = join(out, `restore-drill-${today()}-${realModel ? profileFor(process.env.EMBED_MODEL).id : 'fake'}.json`);
  writeFileSync(file, JSON.stringify({ date: today(), node: process.version, embedder: res.embedder, schema: res.schema, seconds: Math.round((Date.now() - t0) / 1000), summary: { pass: count('PASS'), fail: count('FAIL'), skipped: count('SKIPPED') }, checks: res.checks }, null, 2));
  console.log(`PASS ${count('PASS')}  FAIL ${count('FAIL')}  SKIPPED ${count('SKIPPED')}  -> ${file}`);
  process.exitCode = count('FAIL') > 0 ? 1 : 0;
  // The in-process apps and the model leave handles open; the report is written, so end here.
  process.exit();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
