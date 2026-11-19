/**
 * A throwaway BrainAI server for one scenario run: its own data folder, its own owner, a random loopback port.
 * Default: the real server (src/index.ts) as a child process with the real local search model. With
 * `fakeEmbedder` it runs in this process on the test embedder instead (src/testing/helpers.ts).
 * Nothing here ever reads or writes the owner's real brain.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, createWriteStream, existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { OwnerAuth } from '../../auth/owner.js';
import { base32Encode, totpAt } from '../../auth/totp.js';
import { openDb } from '../../db.js';

export const OWNER_PASSWORD = 'lifecycle eval owner password';
const CALLBACK = 'http://localhost:9999/callback';

export type OwnerFetch = (path: string, init?: RequestInit) => Promise<Response>;

export interface Brain {
  baseUrl: string;
  mcpUrl: string;
  dataDir: string;
  /** The owner in the dashboard: a logged-in session. Same-origin header and cookie are added; redirects are not followed. */
  owner: OwnerFetch;
  /** Connects an assistant through the real OAuth flow under this name; returns its access token. */
  connect(name: string): Promise<string>;
  /** Read-only SQL on the brain's database. */
  sql<T = Record<string, unknown>>(query: string, ...params: unknown[]): T[];
  stop(): Promise<void>;
}

/** The only environment the throwaway server gets. */
export function serverEnv(o: { home: string; dataDir: string; port: number; baseUrl: string; modelDir: string }, from: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const k of ['PATH', 'TMPDIR', 'LANG', 'LC_ALL', 'NODE_OPTIONS']) if (from[k] !== undefined) env[k] = from[k];
  return { ...env, HOME: o.home, PUBLIC_URL: o.baseUrl, PORT: String(o.port), HOST: '127.0.0.1', DATA_DIR: o.dataDir, MODEL_DIR: o.modelDir, OVERLAY_DIR: join(o.dataDir, 'overlay'), LOCAL_MODE: 'false', BACKUP_DIR: '' };
}

const freePort = (): Promise<number> => new Promise((ok, fail) => {
  const s = createServer();
  s.listen(0, '127.0.0.1', () => { const p = (s.address() as { port: number }).port; s.close(() => ok(p)); });
  s.on('error', fail);
});

async function waitUp(url: string, child: ChildProcess | null, ms = 120_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (child && child.exitCode !== null) throw new Error(`server exited early (code ${child.exitCode})`);
    try { const r = await fetch(url + '/login', { redirect: 'manual' }); if (r.status < 500) return; } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error('server did not start in time');
}

async function ownerLogin(baseUrl: string, secret: string): Promise<OwnerFetch> {
  const res = await fetch(baseUrl + '/login', {
    method: 'POST', redirect: 'manual',
    headers: { Origin: baseUrl, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ password: OWNER_PASSWORD, code: totpAt(secret, Math.floor(Date.now() / 30_000)) }),
  });
  const cookie = res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  if (res.status !== 302 || !cookie) throw new Error(`owner login failed: ${res.status}`);
  return (path, init = {}) => fetch(baseUrl + path, {
    ...init, redirect: 'manual',
    headers: { ...(init.headers as Record<string, string> | undefined), Cookie: cookie, Origin: baseUrl },
  });
}

async function oauthConnect(baseUrl: string, owner: OwnerFetch, name: string): Promise<string> {
  const reg = await fetch(baseUrl + '/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ redirect_uris: [CALLBACK], client_name: name, token_endpoint_auth_method: 'none' }),
  });
  if (reg.status !== 201) throw new Error(`register failed: ${reg.status}`);
  const { client_id: clientId } = await reg.json() as { client_id: string };
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const auth = await fetch(baseUrl + '/authorize?' + new URLSearchParams({
    response_type: 'code', client_id: clientId, redirect_uri: CALLBACK, code_challenge: challenge,
    code_challenge_method: 'S256', state: 'xyz', resource: `${baseUrl}/mcp`,
  }), { redirect: 'manual' });
  const consent = auth.headers.get('location');
  if (auth.status !== 302 || !consent) throw new Error(`authorize failed: ${auth.status}`);
  const approve = await owner(consent, { method: 'POST', body: new URLSearchParams({ decision: 'approve' }) });
  const code = new URL(approve.headers.get('location') ?? '', baseUrl).searchParams.get('code');
  if (approve.status !== 302 || !code) throw new Error(`consent failed: ${approve.status}`);
  const tok = await fetch(baseUrl + '/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: clientId, redirect_uri: CALLBACK, resource: `${baseUrl}/mcp` }),
  });
  if (tok.status !== 200) throw new Error(`token failed: ${tok.status}`);
  return ((await tok.json()) as { access_token: string }).access_token;
}

export interface BrainOptions { modelDir: string; fakeEmbedder?: boolean; repoRoot?: string; keepLogsIn?: string }

export async function startBrain(opts: BrainOptions): Promise<Brain> {
  if (opts.fakeEmbedder) return startInProcess();
  const root = opts.repoRoot ?? resolve(import.meta.dirname, '../../..');
  const dataDir = mkdtempSync(join(tmpdir(), 'lifecycle-brain-'));
  const home = mkdtempSync(join(tmpdir(), 'lifecycle-home-'));
  const secret = base32Encode(randomBytes(20));
  // The owner is made before the server starts, the way the CLI's set-password and setup-totp would.
  const seed = openDb(join(dataDir, 'memory.db'));
  const auth = new OwnerAuth(seed, () => new Date());
  await auth.setPassword(OWNER_PASSWORD);
  auth.setTotpSecret(secret);
  seed.close();
  const port = await freePort();
  const baseUrl = `http://localhost:${port}`;
  const log = createWriteStream(join(dataDir, 'server.log'));
  const child = spawn(process.execPath, ['--import', 'tsx', join(root, 'src/index.ts')], {
    cwd: root,
    // A whitelist, not the caller's environment: no overlay, ask commands, thresholds or old-mode settings can leak in.
    env: serverEnv({ home, dataDir, port, baseUrl, modelDir: opts.modelDir }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout!.pipe(log); child.stderr!.pipe(log);
  try {
    await waitUp(baseUrl, child);
  } catch (e) {
    child.kill('SIGKILL');
    await new Promise((r) => setTimeout(r, 200));
    const tail = existsSync(join(dataDir, 'server.log')) ? readFileSync(join(dataDir, 'server.log'), 'utf8').slice(-1500) : '';
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
    throw new Error(`${(e as Error).message}\n${tail}`);
  }
  const owner = await ownerLogin(baseUrl, secret);
  return {
    baseUrl, mcpUrl: `http://127.0.0.1:${port}/mcp`, dataDir, owner,
    connect: (name) => oauthConnect(baseUrl, owner, name),
    sql<T>(query: string, ...params: unknown[]): T[] {
      const db = new Database(join(dataDir, 'memory.db'), { readonly: true });
      try { return db.prepare(query).all(...params) as T[]; } finally { db.close(); }
    },
    async stop() {
      if (child.exitCode === null) {
        child.kill('SIGTERM');
        await new Promise<void>((ok) => { const t = setTimeout(() => { child.kill('SIGKILL'); ok(); }, 5000); child.once('exit', () => { clearTimeout(t); ok(); }); });
      }
      if (!existsSync(dataDir)) return;
      rmSync(dataDir, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    },
  };
}

async function startInProcess(): Promise<Brain> {
  const { startTestApp, loggedIn, connectClient } = await import('../../testing/helpers.js');
  const app = await startTestApp({});
  const owner = await loggedIn(app);
  return {
    baseUrl: app.baseUrl, mcpUrl: `${app.baseUrl}/mcp`, dataDir: '(in memory)', owner,
    connect: async (name) => (await connectClient(app.baseUrl, owner, name)).accessToken,
    sql<T>(query: string, ...params: unknown[]): T[] { return app.deps.db!.prepare(query).all(...params) as T[]; },
    stop: () => app.close(),
  };
}
