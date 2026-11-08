import { createServer, type RequestListener, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

const listen = (s: Server, port: number, host: string) => new Promise<NodeJS.ErrnoException | null>((resolve) => {
  s.once('error', resolve);
  s.listen(port, host, () => resolve(null));
});

/**
 * The desktop app listens on both loopback addresses (D1 review). Browsers try ::1 first for `localhost`, so if BrainAI
 * held only 127.0.0.1, another account on the same computer could take [::1]:<port> and receive the owner's traffic.
 * Holding both closes that; someone already on ::1 stops the start. A machine with no IPv6 loopback has nothing to take.
 */
export async function listenLocal(app: RequestListener, port: number): Promise<Server[]> {
  const v4 = createServer(app);
  const e4 = await listen(v4, port, '127.0.0.1');
  if (e4) throw e4;
  const actual = (v4.address() as AddressInfo).port;
  const v6 = createServer(app);
  const e6 = await listen(v6, actual, '::1');
  if (!e6) return [v4, v6];
  if (e6.code === 'EADDRNOTAVAIL' || e6.code === 'EAFNOSUPPORT') return [v4];
  await new Promise<void>((r) => v4.close(() => r()));
  throw new Error(`::1:${actual} is already in use: another program holds this computer's IPv6 address for BrainAI's port, so BrainAI will not start`);
}
