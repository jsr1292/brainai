/**
 * The bridge Claude's desktop app runs (`node dist/cli.js claude-bridge`): Claude starts local MCP servers only as
 * stdio programs, so this forwards every JSON-RPC message between its stdin/stdout and the running BrainAI at
 * http://127.0.0.1:<port>/mcp, with the bridge key as the bearer token.
 *
 * Whoever holds that port when BrainAI is not running must not get the key. So every new TCP connection first carries
 * GET /app/bridge-hello on its own socket, and the server must answer with a proof that only a BrainAI that knows the
 * key's stored hash can make (for this challenge and this port). Only then does the HTTP client get the socket and send
 * the key. A connection that closes is never reused: its successor is proved again, to whoever holds the port then.
 *
 * The port comes from the app's port file and the key from <data dir>/claude-desktop-key; both are read again on every
 * (re)connect, so a port change or a new key needs no restart. When BrainAI is not running, or the key is missing or
 * revoked, the request gets a JSON-RPC error with a plain sentence, and the next request tries again. Every request
 * Claude sends gets exactly one answer, also when BrainAI stops while it is working on one. The key is never written
 * to stdout, stderr or an error message.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPClientTransport, StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';
import { ProofRefused, provedConnection, type ProvedConnection } from './provedConnection.js';
import {
  isJSONRPCErrorResponse, isJSONRPCRequest, isJSONRPCResultResponse, type JSONRPCMessage, type RequestId,
} from '@modelcontextprotocol/sdk/types.js';

/** In the data dir, mode 600: {"grant":"…","token":"…"}. */
export const BRIDGE_KEY_FILE = 'claude-desktop-key';
export interface BridgeEnv { BRAINAI_DATA_DIR: string; BRAINAI_PORT_FILE: string }
export const NOT_RUNNING = "BrainAI isn't running on this computer. Open BrainAI and try again.";
/** Names the Tools page as BrainAI shows it on this computer ("Tools on this Mac" / "Tools on this computer"). */
export const notConnectedText = (platform: NodeJS.Platform): string =>
  `BrainAI is not connected to Claude any more: connect it again in BrainAI › Settings › Tools on ${platform === 'win32' ? 'this computer' : 'this Mac'}.`;
export const NOT_CONNECTED = notConnectedText(process.platform);
export const COULD_NOT_ANSWER = 'BrainAI could not answer this request. Try again; if it keeps happening, restart BrainAI.';

/**
 * Claude may start at login before BrainAI, and may not send initialize again once it failed: an initialize that
 * cannot reach BrainAI is tried again every `intervalMs`, `attempts` more times, before NOT_RUNNING (1 s for 30 s).
 */
export interface BridgeOptions { initializeRetry?: { intervalMs: number; attempts: number }; helloTimeoutMs?: number }
const DEFAULT_RETRY = { intervalMs: 1000, attempts: 30 };

/** JSON-RPC "server error" code for every failure the bridge reports itself. */
const BRIDGE_ERROR = -32000;
/** How long a stream that ended cleanly may take to hand over its last message before its request is answered. */
const STREAM_END_GRACE_MS = 1000;
/** Error codes meaning nothing (or nothing any more) answers on the port. */
const CONNECTION_CODES = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EHOSTUNREACH', 'ENETUNREACH', 'ETIMEDOUT', 'EPIPE', 'ECONNABORTED',
  'EADDRNOTAVAIL', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_CLOSED',
]);

/** A failure whose message is one of the sentences above, safe to show. */
class BridgeFailure extends Error {}

/** The key file's grant and token from one read, so a swap of the file cannot pair one's token with the other's grant. */
function readKey(dataDir: string | undefined): { token: string; grant: string } | null {
  if (!dataDir) return null;
  try {
    const { grant, token } = JSON.parse(readFileSync(join(dataDir, BRIDGE_KEY_FILE), 'utf8')) as { grant?: unknown; token?: unknown };
    return typeof token === 'string' && token !== '' && typeof grant === 'string' && grant !== '' ? { token, grant } : null;
  } catch {
    return null;
  }
}

function readPort(portFile: string | undefined): number | null {
  if (!portFile) return null;
  try {
    const port = (JSON.parse(readFileSync(portFile, 'utf8')) as { port?: unknown }).port;
    return typeof port === 'number' && Number.isInteger(port) && port > 0 && port < 65536 ? port : null;
  } catch {
    return null;
  }
}

/** Whether an error (or anything in its cause chain) says the connection itself failed. */
function isConnectionFailure(e: unknown, depth = 0): boolean {
  if (!e || typeof e !== 'object' || depth > 5) return false;
  const { code, cause, errors } = e as { code?: unknown; cause?: unknown; errors?: unknown };
  if (typeof code === 'string' && CONNECTION_CODES.has(code)) return true;
  if (Array.isArray(errors) && errors.some((x) => isConnectionFailure(x, depth + 1))) return true;
  return isConnectionFailure(cause, depth + 1);
}

/** What Claude is told when a message could not reach BrainAI. */
function failureMessage(e: unknown): string {
  if (e instanceof BridgeFailure) return e.message;
  if (e instanceof ProofRefused) return e.notConnected ? NOT_CONNECTED : NOT_RUNNING;
  if (e instanceof StreamableHTTPError && (e.code === 401 || e.code === 403)) return NOT_CONNECTED;
  if (e instanceof StreamableHTTPError && e.code !== undefined && e.code > 0) {
    // BrainAI's own JSON-RPC error (a brain that moved to a server, say) is passed on as it is.
    const body = e.message.replace(/^.*?Error POSTing to endpoint: /s, '');
    try {
      const message = (JSON.parse(body) as { error?: { message?: unknown } }).error?.message;
      if (typeof message === 'string' && message !== '') return message;
    } catch { /* not JSON */ }
    return COULD_NOT_ANSWER;
  }
  return isConnectionFailure(e) ? NOT_RUNNING : COULD_NOT_ANSWER;
}

/** The ids of the requests in one JSON-RPC POST body. */
function requestIds(body: unknown): RequestId[] {
  try {
    const parsed: unknown = JSON.parse(String(body));
    return (Array.isArray(parsed) ? parsed : [parsed]).filter((m) => isJSONRPCRequest(m)).map((m) => (m as { id: RequestId }).id);
  } catch {
    return [];
  }
}

interface Link {
  /** The key this connection was made with. */
  token: string;
  transport: StreamableHTTPClientTransport;
  /** Why it was dropped; what the requests its closing cut off are told. */
  failure?: string;
  /** The proved sockets and the fetch that uses only them. */
  connection: ProvedConnection;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function runClaudeBridge(
  env: NodeJS.ProcessEnv,
  io: { stdin: Readable; stdout: Writable } = { stdin: process.stdin, stdout: process.stdout },
  opts: BridgeOptions = {},
): Promise<void> {
  const dataDir = env.BRAINAI_DATA_DIR;
  const portFile = env.BRAINAI_PORT_FILE;
  const retry = opts.initializeRetry ?? DEFAULT_RETRY;
  const stdio = new StdioServerTransport(io.stdin, io.stdout);
  /** Every key read so far, so no log line can carry one. */
  const keys = new Set<string>();
  /** Set once Claude has gone: nothing more is answered, and the aborts of closing transports are not worth a line. */
  let closing = false;
  const log = (text: string) => {
    if (closing) return;
    let safe = text;
    for (const k of keys) safe = safe.split(k).join('…');
    process.stderr.write(`BrainAI bridge: ${safe}\n`);
  };

  /** The live connection to BrainAI; null until the first request and after a failure. */
  let link: Link | null = null;
  /** The transports still open, closed when Claude goes. */
  const made = new Set<Link>();
  /** The protocol version initialize agreed on, sent on every later (re)connect. */
  let protocolVersion: string | undefined;
  const initializeIds = new Set<RequestId>();
  /** Claude's requests not answered yet: each gets exactly one answer, from BrainAI or from the bridge. */
  const pending = new Set<RequestId>();

  const toClaude = (message: JSONRPCMessage) => {
    stdio.send(message).catch((e: unknown) => log(`writing to Claude failed: ${e instanceof Error ? e.message : String(e)}`));
  };
  /** The bridge's own answer to a request, unless it was answered already. */
  const answer = (id: RequestId, text: string) => {
    if (closing || !pending.delete(id)) return;
    initializeIds.delete(id);
    toClaude({ jsonrpc: '2.0', id, error: { code: BRIDGE_ERROR, message: text } });
  };
  /** Stops using a connection: the next message connects afresh, reading the key and the port again. */
  const drop = (l: Link, failure: string) => {
    if (link === l) link = null;
    l.failure ??= failure;
    if (made.delete(l)) l.transport.close().catch(() => {});
    l.connection.destroy();
  };

  /**
   * fetch for one connection, watching each answer stream: a stream that breaks (BrainAI stopped) answers its waiting
   * requests with NOT_RUNNING and drops the connection; one that ends without their answer gets COULD_NOT_ANSWER.
   */
  const watchingFetch = (l: Link): FetchLike => async (url, init) => {
    const res = await l.connection.fetch(url, init);
    // Only an answer stream outlives send(); a JSON answer or an error is read, and dealt with, inside it.
    const stream = res.ok && (res.headers.get('content-type') ?? '').toLowerCase().startsWith('text/event-stream');
    const ids = stream && init?.method === 'POST' ? requestIds(init.body) : [];
    if (ids.length === 0 || !res.body) return res;
    const reader = res.body.getReader();
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        let chunk: ReadableStreamReadResult<Uint8Array>;
        try {
          chunk = await reader.read();
        } catch (e) {
          if (!closing) {
            for (const id of ids) answer(id, l.failure ?? NOT_RUNNING);
            drop(l, NOT_RUNNING);
          }
          controller.error(e);
          return;
        }
        if (chunk.done) {
          controller.close();
          setTimeout(() => { for (const id of ids) answer(id, COULD_NOT_ANSWER); }, STREAM_END_GRACE_MS).unref();
        } else {
          controller.enqueue(chunk.value);
        }
      },
      cancel: (reason) => reader.cancel(reason),
    });
    return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
  };

  const connect = (): Link => {
    const key = readKey(dataDir);
    if (!key) throw new BridgeFailure(NOT_CONNECTED);
    const { token, grant } = key;
    keys.add(token);
    const port = readPort(portFile);
    if (port === null) throw new BridgeFailure(NOT_RUNNING);
    const l = { token } as Link;
    l.connection = provedConnection(port, grant, token, opts.helloTimeoutMs);
    // 127.0.0.1, as the app listens: "localhost" may try ::1 first, where another account's program could listen.
    l.transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
      fetch: watchingFetch(l),
    });
    if (protocolVersion) l.transport.setProtocolVersion(protocolVersion);
    l.transport.onmessage = (message) => {
      if (isJSONRPCResultResponse(message) || isJSONRPCErrorResponse(message)) {
        // An answer the bridge already gave (BrainAI's came too late) is not sent twice.
        if (message.id === undefined || !pending.delete(message.id)) return;
        if (isJSONRPCResultResponse(message) && initializeIds.delete(message.id)) {
          const agreed = (message.result as { protocolVersion?: unknown }).protocolVersion;
          if (typeof agreed === 'string') {
            protocolVersion = agreed;
            link?.transport.setProtocolVersion(agreed);
          }
        }
      }
      toClaude(message);
    };
    l.transport.onerror = (e) => log(e.message);
    // start() only arms the transport's abort controller (synchronously); it opens no connection.
    l.transport.start().catch((e: unknown) => log(e instanceof Error ? e.message : String(e)));
    made.add(l);
    return l;
  };

  const forward = async (message: JSONRPCMessage): Promise<void> => {
    const request = isJSONRPCRequest(message);
    if (request) {
      pending.add(message.id);
      if (message.method === 'initialize') initializeIds.add(message.id);
    }
    const retries = request && message.method === 'initialize' ? retry.attempts : 0;
    let rekeyed = false;
    for (let attempt = 0; ; attempt++) {
      let current: Link | undefined;
      try {
        current = link ??= connect();
        await current.transport.send(message);
        return;
      } catch (e) {
        const text = failureMessage(e);
        if (current) drop(current, text);
        // Refused (by the key, or by a hello for a revoked grant): Connect may have issued a new key since this link
        // was made. Once, try again with the one on file now.
        const refused = (e instanceof StreamableHTTPError && (e.code === 401 || e.code === 403)) || (e instanceof ProofRefused && e.notConnected);
        if (current && !rekeyed && !closing && refused) {
          const fresh = readKey(dataDir)?.token;
          if (fresh !== undefined && fresh !== current.token) { rekeyed = true; attempt--; continue; }
        }
        if (text === NOT_RUNNING && attempt < retries && !closing) {
          await sleep(retry.intervalMs);
          continue;
        }
        if (request) answer(message.id, text);
        else log(text);
        return;
      }
    }
  };

  await new Promise<void>((resolve) => {
    const finish = () => {
      if (closing) return;
      closing = true;
      void Promise.allSettled([stdio.close(), ...[...made].map((l) => { l.connection.destroy(); return l.transport.close(); })]).then(() => resolve());
    };
    // Each message is sent as it arrives (no waiting on the one before), so a long tool call holds up nothing else.
    stdio.onmessage = (message) => { void forward(message); };
    stdio.onerror = (e) => log(e.message);
    // The stdio transport closed itself (an oversized line, say): nothing more can come from Claude.
    stdio.onclose = finish;
    io.stdin.once('end', finish);
    io.stdin.once('close', finish);
    // Claude gone mid-write (EPIPE): stop quietly.
    io.stdout.on('error', finish);
    void stdio.start();
  });
}
