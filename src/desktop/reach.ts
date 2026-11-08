/**
 * The desktop app's public address (D4: Reach from phone and web), kept in <data>/reach.json so it survives restarts.
 * It only counts while the owner has a password and an authenticator: a saved address without them is ignored, so a
 * BrainAI without sign-in can never be served publicly.
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type ReachVia = 'tailscale' | 'cloudflare';

export class Reach {
  private current: URL | null = null;
  private doorPort: number | null = null;
  private route: { via: ReachVia; tunnel: string | null } = { via: 'tailscale', tunnel: null };
  private stoppers: (() => void)[] = [];
  /** Settles once a saved Reach has been brought back at start (its door reopened, or Reach turned off). */
  ready: Promise<void> = Promise.resolve();
  private listeners: ((url: URL | null) => void)[] = [];

  /** Told whenever the saved address changes (the app builds that address's sign-in pieces then, not mid-request). */
  onChange(fn: (url: URL | null) => void): void {
    this.listeners.push(fn);
  }

  constructor(private readonly dir: string | undefined, private readonly signInReady: () => boolean) {
    const file = this.file();
    if (file && existsSync(file)) {
      try {
        const saved = JSON.parse(readFileSync(file, 'utf8')) as { url?: unknown; port?: unknown };
        if (typeof saved.url === 'string' && saved.url.startsWith('https://')) this.current = new URL(new URL(saved.url).origin);
        if ((saved as { via?: unknown }).via === 'cloudflare') {
          const tunnel = (saved as { tunnel?: unknown }).tunnel;
          this.route = { via: 'cloudflare', tunnel: typeof tunnel === 'string' && /^[0-9a-f-]{36}$/.test(tunnel) ? tunnel : null };
        }
        if (typeof saved.port === 'number' && Number.isInteger(saved.port) && saved.port > 0 && saved.port < 65536) this.doorPort = saved.port;
      } catch { /* an unreadable file is no address */ }
    }
  }

  private file(): string | null {
    return this.dir ? join(this.dir, 'reach.json') : null;
  }

  /** The address as saved, whether or not it is in use. */
  saved(): URL | null {
    return this.current;
  }

  /** The public address in use: only with a saved address and the owner's password and authenticator. */
  url(): URL | null {
    return this.current && this.signInReady() ? this.current : null;
  }

  /** The public door's port Tailscale was last pointed at. */
  port(): number | null {
    return this.doorPort;
  }

  /** How the public address is made: Tailscale Funnel (D4) or a Cloudflare tunnel on the owner's domain (D5). */
  via(): ReachVia {
    return this.route.via;
  }

  /** The Cloudflare tunnel's id (never its credentials). */
  tunnel(): string | null {
    return this.route.tunnel;
  }

  /** Something to stop when the server stops (the Cloudflare tunnel process), without forgetting the address. */
  onShutdown(fn: () => void): void {
    this.stoppers.push(fn);
  }

  shutdown(): void {
    for (const fn of this.stoppers) fn();
  }

  set(url: URL | null, port: number | null = null, route: { via: ReachVia; tunnel?: string } = { via: 'tailscale' }): void {
    this.current = url ? new URL(url.origin) : null;
    this.doorPort = url ? port : null;
    this.route = url ? { via: route.via, tunnel: route.tunnel ?? null } : { via: 'tailscale', tunnel: null };
    const file = this.file();
    for (const fn of this.listeners) fn(this.current);
    if (!file) return;
    const extra = this.route.via === 'cloudflare' ? { via: 'cloudflare', tunnel: this.route.tunnel } : {};
    if (this.current) writeFileSync(file, `${JSON.stringify({ url: this.current.origin, port: this.doorPort, ...extra })}\n`);
    else rmSync(file, { force: true });
  }
}
