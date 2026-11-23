/**
 * The public door (D4 review): a second loopback listener, the only thing Tailscale Funnel forwards to, open only
 * while Reach is in use. Everything that arrives through it is treated as the internet, whatever its Host header
 * says, so a request from the tunnel can never pass as one from this Mac. A Funnel left behind (BrainAI quit, a failed
 * Turn off, a reinstall) reaches a closed port instead of the dashboard.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { createServer, type IncomingMessage, type RequestListener, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

const throughDoor = new WeakSet<IncomingMessage>();
/** Set for everything done while answering a request that came through the door (also across awaits), so a check deep inside, such as the session store's, cannot forget to ask. */
const doorContext = new AsyncLocalStorage<true>();

/** True while a request that came through the public door is being answered. */
export function inDoorRequest(): boolean {
  return doorContext.getStore() === true;
}

/** True for a request that came in through the public door. */
export function viaDoor(req: IncomingMessage): boolean {
  return throughDoor.has(req);
}

/**
 * True when a request path names the desktop app's own endpoints (/app and under it), however it is written: any letter case,
 * %-encoded letters, doubled or dot-segment slashes, a backslash. Used where the door must refuse them, so it errs wide:
 * anything that decodes (even twice) or normalises to /app is one, and an undecodable path counts as one.
 */
export function isAppPath(path: string): boolean {
  let p = path;
  try {
    for (let i = 0; i < 2; i++) p = decodeURIComponent(p);
  } catch { return true; }
  p = p.toLowerCase().replace(/\\/g, '/').replace(/\/{2,}/g, '/');
  // The first real segment of the path as written is judged before any '..' is resolved, so '/app/..' or '/app/x/../..' cannot
  // pop it away.
  if (p.split('/').find((seg) => seg !== '' && seg !== '.') === 'app') return true;
  const parts: string[] = [];
  for (const seg of p.split('/')) {
    if (seg === '..') parts.pop();
    else if (seg !== '.' && seg !== '') parts.push(seg);
  }
  return parts[0] === 'app';
}

export class PublicDoor {
  private server: Server | null = null;

  constructor(private readonly handler: RequestListener) {}

  /** The door's port while it is open. */
  port(): number | null {
    return this.server ? (this.server.address() as AddressInfo).port : null;
  }

  /** Opens the door on 127.0.0.1 (the given port, or any free one) and gives its port; open already: the same. */
  async open(port = 0): Promise<number> {
    const open = this.port();
    if (open !== null) return open;
    const server = createServer((req, res) => {
      throughDoor.add(req);
      doorContext.run(true, () => this.handler(req, res));
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => resolve());
    });
    this.server = server;
    return this.port()!;
  }

  /** Stops taking connections at once; a request already being answered finishes. */
  close(): void {
    const s = this.server;
    this.server = null;
    if (!s) return;
    s.close();
    s.closeIdleConnections();
  }
}
