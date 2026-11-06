import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { ImageStore } from '../images/store.js';
import { DiagramChecks } from '../pages/diagramChecks.js';
import { UploadLinks } from '../images/uploadLinks.js';
import { SkillService } from '../skills/service.js';
import { SkillSync } from '../skills/sync.js';
import type { SetupOverlay } from '../setup/texts.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { ClientsStore } from '../auth/clientsStore.js';
import { LoginLimiter } from '../auth/loginLimiter.js';
import { OwnerAuth } from '../auth/owner.js';
import { MemoryOAuthProvider } from '../auth/provider.js';
import { RedirectAllowlist } from '../auth/redirects.js';
import { SessionStore } from '../auth/sessions.js';
import { base32Encode, totpAt } from '../auth/totp.js';
import type { Clock } from '../clock.js';
import { DiscussionService } from '../discussions/service.js';
import { DiscussionStore } from '../discussions/store.js';
import { openDb, type DB } from '../db.js';
import { GrowthService } from '../growth/service.js';
import { GrowthStore } from '../growth/store.js';
import { DeviceService } from '../folders/devices.js';
import { FolderService } from '../folders/match.js';
import { ImportLog } from '../pages/importLog.js';
import { NoteService } from '../pages/notes.js';
import { PageService } from '../pages/service.js';
import { PageStore } from '../pages/store.js';
import { createFakeEmbedder } from '../memory/fakeEmbedder.js';
import { MemoryService } from '../memory/service.js';
import { MemoryStore } from '../memory/store.js';
import { ProjectStore } from '../projects/store.js';
import { ProjectsService } from '../projects/service.js';
import { ReviewService } from '../review/service.js';
import { ReviewStore } from '../review/store.js';
import { createApp, type AppDeps } from '../web/app.js';
import { makeTidyItems, tidySummary } from '../web/tidyItems.js';
import { MeaningIndex } from '../graph/threads.js';
import { GraphService } from '../graph/data.js';

/** Fills the sign-in tables with recognisable secrets, so a test can check none of them reach a backup. */
export function seedSignIn(db: DB): string {
  const secret = 'TOTPSECRETMARKER234567';
  db.prepare("INSERT INTO owner(id, password_hash, totp_secret, totp_last_step) VALUES (1, '$argon2id$HASHMARKER', ?, 0)").run(secret);
  db.prepare("INSERT INTO sessions(token_hash, id, user_agent, created_at, last_seen_at, expires_at) VALUES ('SESSIONMARKER', 's1', null, 'x', 'x', 'x')").run();
  db.prepare("INSERT INTO known_devices(token_hash, created_at, last_used_at) VALUES ('DEVICEMARKER', 'x', 'x')").run();
  db.prepare(`INSERT INTO oauth_clients(client_id, client_name, metadata, is_cimd, created_at) VALUES ('c1', 'C', ?, 0, 'x')`)
    .run(JSON.stringify({ client_id: 'c1', client_secret: 'CLIENTSECRETMARKER', redirect_uris: ['https://claude.ai/cb'] }));
  return secret;
}

export function makeService(opts: { now?: Clock; threshold?: number } = {}): { db: DB; store: MemoryStore; service: MemoryService } {
  const db = openDb(':memory:');
  const store = new MemoryStore(db, opts.now ?? (() => new Date()));
  const service = new MemoryService(store, createFakeEmbedder(), { duplicateThreshold: opts.threshold ?? 0.9, minRecallSimilarity: 0.2, recallConfidentSimilarity: 0.2 });
  return { db, store, service };
}

/** The Growth service on a test database (fake embedder, the same 0.9 merge threshold as makeService). */
export function makeGrowth(given: { db: DB; store: MemoryStore; service: MemoryService }, now: Clock = () => new Date()): GrowthService {
  return new GrowthService(new GrowthStore(given.db, now), createFakeEmbedder(), given.service, new ProjectStore(given.db, now), given.store, { duplicateThreshold: 0.9 }, now);
}

/** The page service on a test database (fake embedder). */
export function makePages(given: { db: DB; store: MemoryStore; service: MemoryService }, now: Clock = () => new Date(), opts: { sectionMatch?: number | null } = {}): PageService {
  return new PageService(new PageStore(given.db, now), createFakeEmbedder(), given.service, new ProjectStore(given.db, now), given.store, now, opts);
}

export const TEST_PASSWORD = 'correct horse battery';
export const TEST_TOTP_SECRET = base32Encode(Buffer.from('shared-memory-tests!'));

const noNetwork = (async () => { throw new Error('no network in tests'); }) as unknown as typeof fetch;

/**
 * Starts the full web app over real HTTP on a random port, with an in-memory DB, the fake embedder, the owner
 * password TEST_PASSWORD and the TOTP secret TEST_TOTP_SECRET. The app clock starts at `startAt` (default the real time);
 * nextTotp() moves it 30 s forward and returns the code for that step, so every login gets a fresh,
 * non-replayed code. `publicUrl` overrides PUBLIC_URL (default http://localhost:<port>); `mode` and
 * `trustCfConnectingIp` are passed to the app as given; `sectionMatch` to the page service (undefined: the constant).
 */
export async function startTestApp(opts: { publicUrl?: string; mode?: AppDeps['mode']; trustCfConnectingIp?: boolean; statusDir?: string; startAt?: Date; sectionMatch?: number | null; setupOverlay?: SetupOverlay } = {}): Promise<{
  baseUrl: string;
  deps: AppDeps;
  nextTotp(): string;
  /** Moves the app clock forward (sessions and TOTP steps follow it). */
  advance(ms: number): void;
  close(): Promise<void>;
}> {
  let t = opts.startAt?.getTime() ?? Date.now();
  const now: Clock = () => new Date(t);
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const baseUrl = `http://localhost:${(server.address() as AddressInfo).port}`;
  const publicUrl = new URL(opts.publicUrl ?? baseUrl);

  const { db, store, service } = makeService({ now });
  const registry = new ProjectStore(db, now);
  const allowlist = new RedirectAllowlist(db);
  const clients = new ClientsStore(db, allowlist, now, noNetwork);
  const provider = new MemoryOAuthProvider(db, clients, allowlist, now, new URL('/mcp', publicUrl));
  const discussions = new DiscussionService(new DiscussionStore(db, now), service, () => provider.activeConnections(), now);
  const owner = new OwnerAuth(db, now);
  await owner.setPassword(TEST_PASSWORD);
  owner.setTotpSecret(TEST_TOTP_SECRET);
  const pages = makePages({ db, store, service }, now, { sectionMatch: opts.sectionMatch });
  // The test floor: the fake embedder's similarities are not e5's.
  const meaning = new MeaningIndex(db, { floor: 0.5, kinds: ['decision'], now });
  service.setMeaningHook(meaning);
  pages.setMeaningHook(meaning);
  const devices = new DeviceService(db, now);
  const folders = new FolderService(devices, registry, service, now);
  const growth = makeGrowth({ db, store, service }, now);
  // Work mode has no Growth, so its reviews have no growth part.
  const tidyItems = makeTidyItems({ store, service, now });
  const reviews = new ReviewService({
    store: new ReviewStore(db), memories: store, service, registry, folders, pages, growth: opts.mode === 'work' ? null : growth, grants: () => provider.listGrants(),
    tidy: () => tidySummary(tidyItems()),
  }, now, () => {});
  const projects = new ProjectsService(registry, service, store, discussions, pages, folders);
  const graph = new GraphService({ db, projects, registry, service, pages, meaning, now });
  const imagesDir = mkdtempSync(join(tmpdir(), 'brain-test-images-'));
  const images = new ImageStore(db, imagesDir, now);
  pages.setPictureStore(images);
  const skills = new SkillService(db, now);
  const deps: AppDeps = {
    allowlist,
    publicUrl, store, service, registry, projects, graph, discussions, growth, reviews, pages, images, diagramChecks: new DiagramChecks(db, now), uploadLinks: new UploadLinks(db, now), skills, skillSync: new SkillSync(db, now, skills), notes: new NoteService(db, pages, now), devices, folders, imports: new ImportLog(db, now), relatedSimilarity: 0.2, provider, owner, sessions: new SessionStore(db, now), limiter: new LoginLimiter(), clients, now,
    mode: opts.mode, trustCfConnectingIp: opts.trustCfConnectingIp, statusDir: opts.statusDir, setupOverlay: opts.setupOverlay,
  };
  server.on('request', createApp(deps));

  return {
    baseUrl,
    deps,
    advance(ms: number) {
      t += ms;
    },
    nextTotp() {
      t += 30_000;
      return totpAt(TEST_TOTP_SECRET, Math.floor(t / 30_000));
    },
    close: () => new Promise<void>((resolve, reject) => {
      server.closeAllConnections();
      server.close((e) => {
        db.close();
        rmSync(imagesDir, { recursive: true, force: true });
        if (e) reject(e); else resolve();
      });
    }),
  };
}

/** Logs in through the real flow; returns a fetch wrapper that sends the session cookie and Origin and never follows redirects. */
export async function loggedIn(app: { baseUrl: string; nextTotp(): string }, opts: { userAgent?: string } = {}): Promise<(path: string, init?: RequestInit) => Promise<Response>> {
  const res = await fetch(app.baseUrl + '/login', {
    method: 'POST',
    redirect: 'manual',
    headers: {
      Origin: app.baseUrl,
      'Content-Type': 'application/x-www-form-urlencoded',
      ...(opts.userAgent ? { 'User-Agent': opts.userAgent } : {}),
    },
    body: new URLSearchParams({ password: TEST_PASSWORD, code: app.nextTotp() }),
  });
  const cookie = res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  if (res.status !== 302 || !cookie) throw new Error(`login failed: ${res.status}`);
  return (path, init = {}) => {
    const headers = init.headers as Record<string, string> | undefined;
    // A Cookie header passed in is sent along with the session's.
    return fetch(app.baseUrl + path, {
      ...init,
      redirect: 'manual',
      headers: { ...headers, Cookie: [cookie, headers?.Cookie].filter(Boolean).join('; '), Origin: app.baseUrl },
    });
  };
}

const CALLBACK = 'http://localhost:9999/callback';

/**
 * Connects an AI client through the real OAuth flow (register, authorize, owner consent, token) and returns its
 * access token. `f` is a logged-in fetch wrapper from loggedIn(); the client appears under `clientName`.
 */
export async function connectClient(baseUrl: string, f: (path: string, init?: RequestInit) => Promise<Response>, clientName = 'Claude Code'): Promise<{ accessToken: string }> {
  const reg = await fetch(baseUrl + '/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ redirect_uris: [CALLBACK], client_name: clientName, token_endpoint_auth_method: 'none' }),
  });
  if (reg.status !== 201) throw new Error(`register failed: ${reg.status}`);
  const { client_id: clientId } = await reg.json() as { client_id: string };
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const auth = await fetch(baseUrl + '/authorize?' + new URLSearchParams({
    response_type: 'code', client_id: clientId, redirect_uri: CALLBACK, code_challenge: challenge,
    code_challenge_method: 'S256', state: 'xyz', resource: `${baseUrl}/mcp`,
  }), { redirect: 'manual' });
  const consentPath = auth.headers.get('location');
  if (auth.status !== 302 || !consentPath) throw new Error(`authorize failed: ${auth.status}`);
  const approve = await f(consentPath, { method: 'POST', body: new URLSearchParams({ decision: 'approve' }) });
  const code = new URL(approve.headers.get('location') ?? '', baseUrl).searchParams.get('code');
  if (approve.status !== 302 || !code) throw new Error(`consent failed: ${approve.status}`);
  const tok = await fetch(baseUrl + '/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: clientId, redirect_uri: CALLBACK, resource: `${baseUrl}/mcp` }),
  });
  if (tok.status !== 200) throw new Error(`token failed: ${tok.status}`);
  return { accessToken: ((await tok.json()) as { access_token: string }).access_token };
}
