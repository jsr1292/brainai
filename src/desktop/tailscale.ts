/**
 * Tailscale Funnel for Reach from phone and web (D4): the Mac's public address, https://<mac>.<tailnet>.ts.net,
 * forwarding to BrainAI on this Mac. Runs Tailscale's own command (no shell, a time limit, never waiting for input).
 */
import { execFile, execFileSync } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { join } from 'node:path';

export interface TailscaleEnv {
  home: string;
  /** Where to look for `tailscale` first (the owner's login-shell PATH). */
  path: string;
  /** The command inside the Mac app, used when it is not on the PATH. */
  appPath?: string;
  timeoutMs?: number;
  /** The shorter limit for the status check the Reach page shows (default 5 s); Turn on and Turn off keep timeoutMs. */
  statusTimeoutMs?: number;
  extraEnv?: Record<string, string>;
}
/** `refused`: a definite no (Tailscale is not installed, or Funnel is not allowed for the account). Any other failure may pass. */
export type FunnelResult = { ok: true; url: string } | { ok: false; reason: string; refused?: true };

/** The time limit in words, as the call really had it. */
const secs = (env: TailscaleEnv) => `${Math.max(1, Math.round((env.timeoutMs ?? 30_000) / 1000))} seconds`;

const APP_CLI = '/Applications/Tailscale.app/Contents/MacOS/Tailscale';
const INSTALL = 'Install Tailscale (tailscale.com/download/mac) and sign in, then press Turn on again.';

function findCli(env: TailscaleEnv): string | null {
  for (const dir of env.path.split(':')) {
    if (!dir) continue;
    try { accessSync(join(dir, 'tailscale'), constants.X_OK); return join(dir, 'tailscale'); } catch { /* next */ }
  }
  const app = env.appPath ?? APP_CLI;
  try { accessSync(app, constants.X_OK); return app; } catch { return null; }
}

function run(env: TailscaleEnv, cli: string, args: string[]): Promise<{ code: number; stdout: string; out: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    const child = execFile(cli, args, { env: { PATH: env.path, HOME: env.home, ...env.extraEnv }, timeout: env.timeoutMs ?? 30_000, maxBuffer: 1 << 20 },
      (err, stdout, stderr) => {
        const e = err as (NodeJS.ErrnoException & { killed?: boolean; code?: unknown }) | null;
        resolve({ code: !e ? 0 : typeof e.code === 'number' ? e.code : 1, stdout, out: `${stdout}${stderr}`, timedOut: !!e?.killed });
      });
    child.stdin?.end();
  });
}

async function statusOf(env: TailscaleEnv, cli: string): Promise<{ running: boolean; host: string | null; timedOut: boolean }> {
  const r = await run(env, cli, ['status', '--json']);
  if (r.timedOut) return { running: false, host: null, timedOut: true };
  try {
    // stdout only: Tailscale prints warnings (a client/daemon version mismatch) on stderr.
    const s = JSON.parse(r.stdout) as { BackendState?: string; Self?: { DNSName?: string } };
    const host = s.Self?.DNSName?.replace(/\.$/, '') || null;
    const running = s.BackendState === 'Running' && host !== null;
    return { running, host: running ? host : null, timedOut: false };
  } catch {
    return { running: false, host: null, timedOut: false };
  }
}

/** What the Reach page shows: a status check with its own short limit (`timedOut`: Tailscale did not answer in time). */
export async function tailscaleState(env: TailscaleEnv): Promise<{ installed: boolean; running: boolean; host: string | null; timedOut: boolean }> {
  const cli = findCli(env);
  if (!cli) return { installed: false, running: false, host: null, timedOut: false };
  const { running, host, timedOut } = await statusOf({ ...env, timeoutMs: env.statusTimeoutMs ?? 5_000 }, cli);
  return { installed: true, running, host, timedOut };
}

/**
 * Shares BrainAI's public door (http://127.0.0.1:<port>, open only while Reach is on) on the Mac's public address
 * (port 443), and gives that address back. A funnel command that ran but did not clearly succeed is undone, so
 * Tailscale is never left sharing while BrainAI shows Reach as off.
 */
export async function funnelOn(env: TailscaleEnv, port: number, hooks: { before?: () => void; rolledBack?: () => void } = {}): Promise<FunnelResult> {
  const cli = findCli(env);
  if (!cli) return { ok: false, reason: INSTALL, refused: true };
  const s = await statusOf(env, cli);
  if (s.timedOut) return { ok: false, reason: `Tailscale did not answer within ${secs(env)}. Try again in a moment.` };
  if (!s.running || !s.host) return { ok: false, reason: 'Open Tailscale and sign in, then press Turn on again.' };
  // Told only now: until a share command really runs, nothing of ours is shared and nothing needs to be remembered.
  hooks.before?.();
  const r = await run(env, cli, ['funnel', '--bg', '--https=443', '--yes', `http://127.0.0.1:${port}`]);
  if (r.code === 0 && !r.timedOut) return { ok: true, url: `https://${s.host}` };
  if ((await funnelOff(env)).ok) hooks.rolledBack?.();
  if (r.timedOut) return { ok: false, reason: `Tailscale did not answer within ${secs(env)}. Try again in a moment.` };
  const approve = /https:\/\/login\.tailscale\.com\/[^\s"'<>)\]]+/.exec(r.out)?.[0]?.replace(/[.,;:]+$/, '');
  if (approve) return { ok: false, reason: `Tailscale needs Funnel allowed for your account first: open ${approve}, allow it, then press Turn on again.`, refused: true };
  return { ok: false, reason: `Tailscale could not share BrainAI: ${r.out.trim().slice(0, 200) || `it stopped with code ${r.code}`}` };
}

export async function funnelOff(env: TailscaleEnv): Promise<{ ok: true } | { ok: false; reason: string }> {
  const cli = findCli(env);
  if (!cli) return { ok: true };
  const r = await run(env, cli, ['funnel', '--https=443', 'off']);
  if (r.code === 0) return { ok: true };
  return { ok: false, reason: r.timedOut ? `Tailscale did not answer within ${secs(env)}.` : `Tailscale could not stop sharing: ${r.out.trim().slice(0, 200)}` };
}

/**
 * The same `funnel --https=443 off`, blocking, for the exit path (process 'exit' allows nothing asynchronous).
 * True when Tailscale confirmed, or when there is no Tailscale to ask.
 */
export function funnelOffSync(env: TailscaleEnv, timeoutMs = 3000): boolean {
  const cli = findCli(env);
  if (!cli) return true;
  try {
    execFileSync(cli, ['funnel', '--https=443', 'off'], { env: { PATH: env.path, HOME: env.home, ...env.extraEnv }, timeout: timeoutMs, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * What Tailscale shares on the public port (443) right now, from `tailscale serve status --json` (read-only):
 * `ours` when "/" there forwards to BrainAI's door at `port`, `other` when something else is shared (the owner's own
 * Funnel or Serve), `none`, or `unknown` (Tailscale not installed, not running, no answer: `reason`). `funnel off` clears
 * everything on 443, so it is only ever run for `ours`.
 */
export async function funnelPointsAt(env: TailscaleEnv, port: number): Promise<{ at: 'ours' | 'other' | 'none' } | { at: 'unknown'; reason: string }> {
  const cli = findCli(env);
  if (!cli) return { at: 'none' };
  const r = await run(env, cli, ['serve', 'status', '--json']);
  if (r.timedOut) return { at: 'unknown', reason: `Tailscale did not answer within ${secs(env)}.` };
  if (r.code !== 0) return { at: 'unknown', reason: `Tailscale could not tell what it shares: ${r.out.trim().slice(0, 200) || `it stopped with code ${r.code}`}` };
  let parsed: unknown;
  try {
    // Older versions print `null` when nothing is shared.
    parsed = JSON.parse(r.stdout.trim() || '{}') ?? {};
  } catch {
    return { at: 'unknown', reason: 'Tailscale answered something BrainAI could not read.' };
  }
  if (typeof parsed !== 'object' || Array.isArray(parsed)) return { at: 'none' };
  const s = parsed as { Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }>; TCP?: Record<string, unknown> };
  const sites = Object.entries(s.Web ?? {}).filter(([host]) => host.endsWith(':443'));
  if (sites.length === 0 && !s.TCP?.['443']) return { at: 'none' };
  // Ours only when "/" is the one thing shared there and it goes to BrainAI's door: `funnel off` clears every path on 443.
  const target = (proxy: unknown) => typeof proxy === 'string' && [`http://127.0.0.1:${port}`, `http://localhost:${port}`, `127.0.0.1:${port}`, `localhost:${port}`].includes(proxy.replace(/\/+$/, ''));
  const ours = sites.length > 0 && sites.every(([, w]) => {
    const paths = Object.keys(w?.Handlers ?? {});
    return paths.length === 1 && paths[0] === '/' && target(w.Handlers!['/']?.Proxy);
  });
  return { at: ours ? 'ours' : 'other' };
}
