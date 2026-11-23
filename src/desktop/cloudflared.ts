/**
 * Cloudflare for Reach from phone and web with your own domain (D5): BrainAI runs `cloudflared` itself. Sign in once
 * (the browser opens Cloudflare's page; cloudflared saves its certificate in ~/.cloudflared), a named tunnel made once
 * (its credentials stay in BrainAI's data folder, mode 600), a DNS name pointed at it (never overwriting a record), and
 * the tunnel kept running to BrainAI's public door while Reach is on. Quick tunnels, whose address changes, are not used.
 */
import { execFile, execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { accessSync, chmodSync, constants, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface CloudflaredEnv {
  home: string;
  /** Where to look for `cloudflared` (the owner's login-shell PATH); there is no fixed fallback. */
  path: string;
  timeoutMs?: number;
  extraEnv?: Record<string, string>;
}
export type Fail = { ok: false; reason: string };
export type Ok = { ok: true };

const INSTALL = 'Install cloudflared (brew install cloudflared, or developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads), then come back here.';

function findCli(env: CloudflaredEnv): string | null {
  for (const dir of env.path.split(':')) {
    if (!dir) continue;
    try { accessSync(join(dir, 'cloudflared'), constants.X_OK); return join(dir, 'cloudflared'); } catch { /* next */ }
  }
  return null;
}
const childEnv = (env: CloudflaredEnv) => ({ PATH: env.path, HOME: env.home, ...env.extraEnv });
const folder = (dir: string) => join(dir, 'cloudflared');
/**
 * BrainAI's own settings file for cloudflared, so the owner's ~/.cloudflared/config.yml (ingress rules, another tunnel)
 * is never read into BrainAI's tunnel (D5 review), and the sign-in certificate named explicitly.
 */
function own(env: CloudflaredEnv, dir: string): string[] {
  mkdirSync(folder(dir), { recursive: true, mode: 0o700 });
  const config = join(folder(dir), 'config.yml');
  if (!existsSync(config)) writeFileSync(config, '# BrainAI\'s own cloudflared settings: none beyond the command line.\nno-autoupdate: true\n', { mode: 0o600 });
  return ['--config', config, '--origincert', join(env.home, '.cloudflared', 'cert.pem')];
}
const pidFile = (dir: string) => join(folder(dir), 'cloudflared.pid');

function run(env: CloudflaredEnv, cli: string, args: string[]): Promise<{ code: number; out: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    const child = execFile(cli, args, { env: childEnv(env), timeout: env.timeoutMs ?? 60_000, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
      const e = err as (NodeJS.ErrnoException & { killed?: boolean; code?: unknown }) | null;
      resolve({ code: !e ? 0 : typeof e.code === 'number' ? e.code : 1, out: `${stdout}${stderr}`, timedOut: !!e?.killed });
    });
    child.stdin?.end();
  });
}
const lastLine = (out: string) => out.trim().split('\n').filter(Boolean).pop()?.slice(0, 200) ?? '';

export async function cloudflaredState(env: CloudflaredEnv): Promise<{ installed: boolean; signedIn: boolean }> {
  return { installed: findCli(env) !== null, signedIn: existsSync(join(env.home, '.cloudflared', 'cert.pem')) };
}

/** A sign-in under way: cloudflared opens Cloudflare's page in the browser and waits for the owner to pick a domain. */
export interface SignInRun { url(): string | null; done: Promise<Ok | Fail>; stop(): void }

export function startSignIn(env: CloudflaredEnv, waitMs = 300_000): SignInRun {
  const cli = findCli(env);
  if (!cli) return { url: () => null, done: Promise.resolve({ ok: false, reason: INSTALL }), stop: () => {} };
  let url: string | null = null;
  const child = spawn(cli, ['tunnel', 'login'], { env: childEnv(env), stdio: ['ignore', 'pipe', 'pipe'] });
  const read = (chunk: Buffer) => { url ??= /https:\/\/dash\.cloudflare\.com\/\S+/.exec(chunk.toString())?.[0] ?? null; };
  child.stdout.on('data', read);
  child.stderr.on('data', read);
  const done = new Promise<Ok | Fail>((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      resolve({ ok: false, reason: 'The Cloudflare sign-in did not finish within 5 minutes. Press Sign in again.' });
    }, waitMs);
    child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, reason: `cloudflared could not start: ${e.message}` }); });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (existsSync(join(env.home, '.cloudflared', 'cert.pem'))) resolve({ ok: true });
      else resolve({ ok: false, reason: `The Cloudflare sign-in stopped (code ${code ?? 'none'}). Press Sign in again.` });
    });
  });
  return { url: () => url, done, stop: () => { child.kill('SIGTERM'); } };
}

/** A host name for Reach: lower-case DNS labels, at least three (a name under your domain), nothing else. */
export function validHostname(h: string): boolean {
  if (h.length > 253) return false;
  const labels = h.split('.');
  return labels.length >= 3 && labels.every((l) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(l));
}

interface Saved { id: string; credentials: string; routed?: string }

/**
 * The tunnel for this BrainAI, made once and reused, with `hostname` pointed at it. A name Cloudflare already has, or a
 * domain other than the one signed in with, is refused: BrainAI never overwrites a DNS record.
 */
export async function prepareTunnel(env: CloudflaredEnv, dir: string, hostname: string): Promise<{ ok: true; tunnelId: string; credentials: string } | Fail> {
  const cli = findCli(env);
  if (!cli) return { ok: false, reason: INSTALL };
  if (!validHostname(hostname)) return { ok: false, reason: `${hostname} is not a name BrainAI can use: give one under your domain, such as brain.example.com.` };
  mkdirSync(folder(dir), { recursive: true, mode: 0o700 });
  const savedFile = join(folder(dir), 'tunnel.json');
  let saved: Saved | null = null;
  try { saved = JSON.parse(readFileSync(savedFile, 'utf8')) as Saved; } catch { /* none yet */ }
  if (!saved || !existsSync(saved.credentials)) {
    const name = `brainai-${randomBytes(3).toString('hex')}`;
    const credentials = join(folder(dir), `${name}.json`);
    const r = await run(env, cli, ['tunnel', ...own(env, dir), 'create', '--credentials-file', credentials, name]);
    if (r.code !== 0 || !existsSync(credentials)) return { ok: false, reason: `Cloudflare could not make the tunnel: ${lastLine(r.out) || `code ${r.code}`}` };
    chmodSync(credentials, 0o600);
    const id = (JSON.parse(readFileSync(credentials, 'utf8')) as { TunnelID?: unknown }).TunnelID;
    if (typeof id !== 'string') return { ok: false, reason: 'Cloudflare made a tunnel but its credentials have no id.' };
    saved = { id, credentials };
    writeFileSync(savedFile, `${JSON.stringify(saved)}\n`, { mode: 0o600 });
  }
  if (saved.routed !== hostname) {
    const r = await run(env, cli, ['tunnel', ...own(env, dir), 'route', 'dns', saved.id, hostname]);
    if (r.code !== 0) {
      if (/already exists/i.test(r.out)) return { ok: false, reason: `Cloudflare already has a record for ${hostname}: pick another name, or remove that record in Cloudflare first.` };
      return { ok: false, reason: `Cloudflare could not point ${hostname} at BrainAI: ${lastLine(r.out) || `code ${r.code}`}` };
    }
    const added = /Added CNAME (\S+)/.exec(r.out)?.[1];
    if (added && added !== hostname) {
      return { ok: false, reason: `${hostname} is not a domain on the Cloudflare account you signed in with (Cloudflare added ${added} instead; remove it there). Press Use another Cloudflare domain and choose the one ${hostname} belongs to.` };
    }
    saved = { ...saved, routed: hostname };
    writeFileSync(savedFile, `${JSON.stringify(saved)}\n`, { mode: 0o600 });
  }
  return { ok: true, tunnelId: saved.id, credentials: saved.credentials };
}

/**
 * Deletes BrainAI's own tunnel in Cloudflare (`cloudflared tunnel delete -f <id>`, id from tunnel.json), for removing
 * BrainAI. Run after the tunnel process has stopped. The DNS name is never deleted (it may be shared with other things):
 * it is returned so the checklist can tell the owner to remove it.
 */
export async function deleteTunnel(env: CloudflaredEnv, dir: string): Promise<{ hostname: string | null; deleted: boolean; reason?: string }> {
  let saved: Saved;
  try { saved = JSON.parse(readFileSync(join(folder(dir), 'tunnel.json'), 'utf8')) as Saved; } catch { return { hostname: null, deleted: false, reason: 'BrainAI has no saved tunnel.' }; }
  const hostname = typeof saved.routed === 'string' ? saved.routed : null;
  const cli = findCli(env);
  if (!cli) return { hostname, deleted: false, reason: INSTALL };
  if (typeof saved.id !== 'string') return { hostname, deleted: false, reason: 'The saved tunnel has no id.' };
  const r = await run(env, cli, ['tunnel', ...own(env, dir), 'delete', '-f', saved.id]);
  if (r.code !== 0) return { hostname, deleted: false, reason: `Cloudflare could not delete the tunnel: ${lastLine(r.out) || `code ${r.code}`}` };
  return { hostname, deleted: true };
}

/** Stops a tunnel an earlier BrainAI left running (from its pid file), so two never serve one tunnel. */
export function stopLeftover(dir: string): void {
  const file = pidFile(dir);
  let pid: number;
  try { pid = Number(readFileSync(file, 'utf8').trim()); } catch { return; }
  rmSync(file, { force: true });
  if (!Number.isInteger(pid) || pid <= 1) return;
  try {
    // Only if that pid is still a cloudflared tunnel run with BrainAI's own credentials: a reused pid, or the owner's
    // own tunnel, belongs to something else.
    const command = execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' });
    const ours = command.includes(`--credentials-file ${folder(dir)}/`);
    if (ours && /(^|\/)cloudflared\b.*\btunnel\b.*\brun\b/.test(command)) process.kill(pid, 'SIGTERM');
  } catch { /* gone */ }
}

/**
 * Runs cloudflared so it cannot outlive BrainAI. A hard kill of the server (no exit handler runs) would leave the tunnel
 * pointing at a closed door port that another local program could bind. cloudflared has no "stop when my parent stops"
 * option and macOS has no parent-death signal, so a small shell holds cloudflared as its child and watches the pipe BrainAI
 * keeps open to it: when BrainAI is gone, the operating system closes the pipe, the read ends, and cloudflared is killed.
 * stop() sends TERM to the shell's whole process group (it is spawned detached); a TERM, INT or HUP to the shell alone ends cloudflared too. The shell writes cloudflared's own pid to the pid file
 * ($1) so stopLeftover finds the tunnel itself. Arguments: pid file, cloudflared, then its arguments.
 */
const DIES_WITH_PARENT = `exec 3<&0
pf=$1; shift
stop=0; pid=; w=
trap 'stop=1; [ -n "$pid" ] && { kill "$pid" 2>/dev/null; [ -n "$w" ] && kill "$w" 2>/dev/null; exit 0; }' TERM INT HUP
( trap - TERM INT HUP; exec "$@" </dev/null ) &
pid=$!
[ "$stop" = 1 ] && { kill "$pid" 2>/dev/null; exit 0; }
echo "$pid" > "$pf"
( read _ <&3; kill "$pid" 2>/dev/null ) &
w=$!
[ "$stop" = 1 ] && { kill "$pid" "$w" 2>/dev/null; exit 0; }
wait "$pid"
kill "$w" 2>/dev/null
exit 0`;

/** Keeps `cloudflared tunnel run` going to the door while Reach is on: started again after it stops, until stop(). */
export class TunnelRunner {
  private child: ChildProcess | null = null;
  private wanted: { id: string; credentials: string; port: number } | null = null;
  private failures = 0;
  private timer: NodeJS.Timeout | null = null;
  private lines: string[] = [];

  constructor(private readonly env: CloudflaredEnv, private readonly dir: string, private readonly opts: { delays?: number[] } = {}) {}

  start(tunnelId: string, credentials: string, port: number): void {
    this.stop();
    this.wanted = { id: tunnelId, credentials, port };
    this.failures = 0;
    this.spawn();
  }

  private spawn(): void {
    const w = this.wanted;
    const cli = findCli(this.env);
    if (!w || !cli) return;
    mkdirSync(folder(this.dir), { recursive: true, mode: 0o700 });
    const args = ['tunnel', ...own(this.env, this.dir), '--no-autoupdate', 'run', '--credentials-file', w.credentials, '--url', `http://127.0.0.1:${w.port}`, w.id];
    const child = spawn('/bin/sh', ['-c', DIES_WITH_PARENT, 'brainai-tunnel', pidFile(this.dir), cli, ...args], { env: childEnv(this.env), stdio: ['pipe', 'ignore', 'pipe'], detached: true });
    this.child = child;
    child.stdin?.on('error', () => { /* the wrapper is gone */ });
    child.stderr?.on('data', (c: Buffer) => { this.lines = [...this.lines, ...c.toString().split('\n').filter(Boolean)].slice(-20); });
    child.on('error', () => { /* reported through exit */ });
    child.on('exit', () => {
      if (this.child !== child) return;
      this.child = null;
      if (!this.wanted) return;
      const delays = this.opts.delays ?? [2_000, 10_000, 60_000];
      const wait = delays[Math.min(this.failures, delays.length - 1)]!;
      this.failures += 1;
      this.timer = setTimeout(() => { this.timer = null; this.spawn(); }, wait);
      this.timer.unref();
    });
  }

  running(): boolean {
    return this.child !== null;
  }

  /** The tunnel's last log line, for a message when Cloudflare cannot reach BrainAI. */
  lastLog(): string {
    return this.lines[this.lines.length - 1] ?? '';
  }

  stop(): void {
    this.wanted = null;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    const child = this.child;
    this.child = null;
    if (child) {
      // The wrapper leads a process group of its own (detached), and the whole group gets the TERM: a stop a few
      // milliseconds after the start, before the wrapper has set its trap or forked cloudflared, still leaves nothing behind.
      try { if (child.pid) process.kill(-child.pid, 'SIGTERM'); else child.kill('SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch { /* gone */ } }
      // And the pipe is closed: if the TERM came before the wrapper had set its trap, or the group did not exist yet, its
      // watcher sees the end of the pipe and stops cloudflared all the same.
      child.stdin?.destroy();
      // Belt: whatever of that group is still there a moment later (a TERM that landed while cloudflared was being forked
      // is taken by the shell's trap in the child) is killed outright. The group is ours alone, so nothing else can be hit.
      if (child.pid) {
        const group = child.pid;
        setTimeout(() => { try { process.kill(-group, 'SIGKILL'); } catch { /* none left */ } }, 300).unref();
      }
    }
    rmSync(pidFile(this.dir), { force: true });
  }
}
