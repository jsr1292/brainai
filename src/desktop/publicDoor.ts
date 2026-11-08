/**
 * The public door (D4 review): a second loopback listener, the only thing Tailscale Funnel forwards to, open only
 * while Reach is in use. Everything that arrives through it is treated as the internet, whatever its Host header
 * says, so a request from the tunnel can never pass as one from this Mac. A Funnel left behind (BrainAI quit, a failed
 * Turn off, a reinstall) reaches a closed port instead of the dashboard.
 */
import { createServer, type IncomingMessage, type RequestListener, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

const throughDoor = new WeakSet<IncomingMessage>();

/** True for a request that came in through the public door. */
export function viaDoor(req: IncomingMessage): boolean {
  return throughDoor.has(req);
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
      this.handler(req, res);
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
