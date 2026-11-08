/**
 * Tailscale Funnel for Reach from phone and web (D4): the Mac's public address, https://<mac>.<tailnet>.ts.net,
 * forwarding to BrainAI on this Mac. Runs Tailscale's own command (no shell, a time limit, never waiting for input).
 */
import { execFile } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { join } from 'node:path';

export interface TailscaleEnv {
  home: string;
  /** Where to look for `tailscale` first (the owner's login-shell PATH). */
  path: string;
  /** The command inside the Mac app, used when it is not on the PATH. */
  appPath?: string;
  timeoutMs?: number;
  extraEnv?: Record<string, string>;
}
export type FunnelResult = { ok: true; url: string } | { ok: false; reason: string };

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

export async function tailscaleState(env: TailscaleEnv): Promise<{ installed: boolean; running: boolean; host: string | null }> {
  const cli = findCli(env);
  if (!cli) return { installed: false, running: false, host: null };
  const { running, host } = await statusOf(env, cli);
  return { installed: true, running, host };
}

/**
 * Shares BrainAI's public door (http://127.0.0.1:<port>, open only while Reach is on) on the Mac's public address
 * (port 443), and gives that address back. A funnel command that ran but did not clearly succeed is undone, so
 * Tailscale is never left sharing while BrainAI shows Reach as off.
 */
export async function funnelOn(env: TailscaleEnv, port: number): Promise<FunnelResult> {
  const cli = findCli(env);
  if (!cli) return { ok: false, reason: INSTALL };
  const s = await statusOf(env, cli);
  if (s.timedOut) return { ok: false, reason: 'Tailscale did not answer within 30 seconds. Try again in a moment.' };
  if (!s.running || !s.host) return { ok: false, reason: 'Open Tailscale and sign in, then press Turn on again.' };
  const r = await run(env, cli, ['funnel', '--bg', '--https=443', '--yes', `http://127.0.0.1:${port}`]);
  if (r.code === 0 && !r.timedOut) return { ok: true, url: `https://${s.host}` };
  await funnelOff(env);
  if (r.timedOut) return { ok: false, reason: 'Tailscale did not answer within 30 seconds. Try again in a moment.' };
  const approve = /https:\/\/login\.tailscale\.com\/[^\s"'<>)\]]+/.exec(r.out)?.[0]?.replace(/[.,;:]+$/, '');
  if (approve) return { ok: false, reason: `Tailscale needs Funnel allowed for your account first: open ${approve}, allow it, then press Turn on again.` };
  return { ok: false, reason: `Tailscale could not share BrainAI: ${r.out.trim().slice(0, 200) || `it stopped with code ${r.code}`}` };
}

export async function funnelOff(env: TailscaleEnv): Promise<{ ok: true } | { ok: false; reason: string }> {
  const cli = findCli(env);
  if (!cli) return { ok: true };
  const r = await run(env, cli, ['funnel', '--https=443', 'off']);
  if (r.code === 0) return { ok: true };
  return { ok: false, reason: r.timedOut ? 'Tailscale did not answer within 30 seconds.' : `Tailscale could not stop sharing: ${r.out.trim().slice(0, 200)}` };
}
