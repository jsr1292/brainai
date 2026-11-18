/**
 * The connection the Claude bridge makes to BrainAI: every TCP socket is proved to be BrainAI's (it knows the key's
 * stored hash) before the HTTP client may send the key over it. The key is held here only to derive the hash the proof
 * is checked with; it is never written to a log or an error message.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { Agent, request as httpRequest } from 'node:http';
import { connect as netConnect, type Socket } from 'node:net';
import { Readable as NodeReadable } from 'node:stream';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';

/** A socket was refused: the server gave no valid proof. `notConnected`: it said the key is revoked (see below). */
export class ProofRefused extends Error {
  constructor(readonly notConnected: boolean) {
    super(notConnected ? 'BrainAI no longer accepts this key' : 'the program answering on the port did not prove it is BrainAI');
  }
}

/** BrainAI's answer (410) for a key it no longer accepts. Anyone can fake it; it only changes what Claude is told. */
function isNotConnectedAnswer(body: Buffer): boolean {
  try {
    const parsed = JSON.parse(body.toString('utf8')) as unknown;
    return JSON.stringify(parsed) === '{"state":"not_connected"}';
  } catch {
    return false;
  }
}

/** The longest hello answer read; anything bigger is not BrainAI's. */
const HELLO_MAX_BYTES = 8192;
/** How long a socket may take to prove itself (the app answers at once; anything slower is not BrainAI). */
export const DEFAULT_HELLO_TIMEOUT_MS = 5000;

/**
 * An HTTP agent whose every new socket is proved before the HTTP client may use it: the hello GET goes out on that
 * socket, and the one answer (HTTP/1.1 200, a Content-Length, no "Connection: close", nothing after it) must hold the
 * HMAC of challenge + port, keyed by the hash of the key, and must come within `timeoutMs`. Any failure destroys the
 * socket. Sockets still waiting for their proof are not in the agent's pools, so they are tracked in `pending`.
 */
function provingAgent(port: number, grant: string, token: string, timeoutMs: number, pending: Set<Socket>): Agent {
  const agent = new Agent({ keepAlive: true });
  const keyHash = createHash('sha256').update(token).digest('hex');
  (agent as unknown as { createConnection: unknown }).createConnection = (_opts: unknown, cb: (err: Error | null, s?: Socket) => void) => {
    const socket = netConnect({ host: '127.0.0.1', port });
    pending.add(socket);
    const challenge = randomBytes(32).toString('hex');
    let buf = Buffer.alloc(0);
    let done = false;
    const finish = (err: Error | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      pending.delete(socket);
      socket.off('data', onData);
      socket.off('error', onError);
      socket.off('close', onClose);
      if (err) { socket.destroy(); cb(err); return; }
      cb(null, socket);
    };
    const timer = setTimeout(() => finish(new ProofRefused(false)), timeoutMs);
    const refuse = () => finish(new ProofRefused(false));
    const onError = (e: Error) => finish(e);
    const onClose = () => refuse();
    const onData = (chunk: Buffer) => {
      try {
        check(chunk);
      } catch {
        refuse();
      }
    };
    const check = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      const end = buf.indexOf('\r\n\r\n');
      if (end === -1) { if (buf.length > HELLO_MAX_BYTES) refuse(); return; }
      const head = buf.subarray(0, end).toString('latin1');
      const length = /\r\ncontent-length:\s*(\d+)/i.exec(head);
      const gone = /^HTTP\/1\.1 410 /.test(head);
      if (!length || !(gone || (/^HTTP\/1\.1 200 /.test(head) && !/\r\nconnection:\s*close/i.test(head)))) return refuse();
      const total = end + 4 + Number(length[1]);
      if (total > HELLO_MAX_BYTES) return refuse();
      if (buf.length < total) return;
      if (gone) return finish(new ProofRefused(isNotConnectedAnswer(buf.subarray(end + 4, total))));
      if (buf.length > total) return refuse();
      let proof: unknown;
      try { proof = (JSON.parse(buf.subarray(end + 4).toString('utf8')) as { proof?: unknown }).proof; } catch { proof = undefined; }
      const expected = createHmac('sha256', keyHash).update(challenge + String(port)).digest('hex');
      const ok = typeof proof === 'string' && /^[0-9a-f]{64}$/.test(proof) && timingSafeEqual(Buffer.from(proof), Buffer.from(expected));
      if (ok) finish(null); else refuse();
    };
    socket.on('data', onData);
    socket.on('error', onError);
    socket.on('close', onClose);
    socket.once('connect', () => {
      socket.write(`GET /app/bridge-hello?grant=${encodeURIComponent(grant)}&challenge=${challenge} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: keep-alive\r\n\r\n`);
    });
    return undefined;
  };
  return agent;
}

/** The proved connection of one link: `fetch` over node:http (the global fetch would open unproved sockets) and `destroy`. */
export interface ProvedConnection { fetch: FetchLike; destroy(): void }

export function provedConnection(port: number, grant: string, token: string, timeoutMs = DEFAULT_HELLO_TIMEOUT_MS): ProvedConnection {
  const pending = new Set<Socket>();
  const agent = provingAgent(port, grant, token, timeoutMs, pending);
  return {
    fetch: provedFetch(agent),
    destroy: () => { agent.destroy(); for (const s of pending) s.destroy(); },
  };
}

function provedFetch(agent: Agent): FetchLike {
  return (url, init) => new Promise<Response>((resolve, reject) => {
    const u = new URL(String(url));
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => { headers[k] = v; });
    const req = httpRequest({
      host: u.hostname, port: Number(u.port), path: u.pathname + u.search, method: init?.method ?? 'GET', headers, agent,
      signal: init?.signal ?? undefined,
    }, (res) => {
      const h = new Headers();
      for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) h.set(k, Array.isArray(v) ? v.join(', ') : v);
      const status = res.statusCode ?? 0;
      const empty = status === 204 || status === 205 || status === 304 || init?.method === 'HEAD';
      if (empty) res.resume();
      resolve(new Response(empty ? null : (NodeReadable.toWeb(res) as unknown as ReadableStream<Uint8Array>), { status, statusText: res.statusMessage, headers: h }));
    });
    req.on('error', reject);
    req.end(init?.body === undefined || init?.body === null ? undefined : String(init.body));
  });
}
