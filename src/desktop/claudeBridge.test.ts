import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { startTestApp } from '../testing/helpers.js';
import { BRIDGE_KEY_FILE, COULD_NOT_ANSWER, NOT_CONNECTED, NOT_RUNNING, notConnectedText, runClaudeBridge } from './claudeBridge.js';

type Reply = { id: number; result?: any; error?: { code: number; message: string } };
type Retry = { intervalMs: number; attempts: number };
/** Tests that don't test the login race answer a failed initialize at once. */
const NO_RETRY: Retry = { intervalMs: 1, attempts: 0 };

/** A port nothing listens on: bound once by the OS, then released. */
async function closedPort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', resolve));
  const port = (s.address() as { port: number }).port;
  await new Promise<void>((resolve) => s.close(() => resolve()));
  return port;
}

/** A stand-in for BrainAI on 127.0.0.1 only, answering with `handle`; closed (connections dropped) after the test. */
async function fakeBrainAI(t: TestContext, handle: (req: IncomingMessage, body: any, res: ServerResponse) => void) {
  const server = createHttpServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => { raw += c.toString(); });
    req.on('end', () => handle(req, raw ? JSON.parse(raw) : undefined, res));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const stop = () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); });
  t.after(async () => { if (server.listening) await stop(); });
  return { port: (server.address() as { port: number }).port, stop };
}

/**
 * A data folder (with a key holding `token`, unless it is null, and a port file for `port`, unless it is null) and a
 * running bridge on in-memory stdio. Everything the bridge writes (stdout) and everything written to stderr while it
 * runs is kept, to check for the token afterwards.
 */
function runBridge(t: TestContext, opts: { token: string; grantId?: string; key?: boolean; port: number | null; retry?: Retry; onEnd?: () => Promise<void> }) {
  const dir = mkdtempSync(join(tmpdir(), 'brainai-bridge-'));
  const portFile = join(dir, 'brainai.json');
  if (opts.key !== false) writeFileSync(join(dir, BRIDGE_KEY_FILE), JSON.stringify({ grant: opts.grantId ?? 'made-up-grant', token: opts.token }), { mode: 0o600 });
  const writePort = (port: number) => writeFileSync(portFile, JSON.stringify({ port }));
  if (opts.port !== null) writePort(opts.port);

  let stderr = '';
  const realWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    stderr += String(chunk);
    return realWrite(chunk as never, ...(rest as []));
  }) as typeof process.stderr.write;

  const stdin = new PassThrough();
  const stdout = new PassThrough();
  let out = '';
  let all = '';
  const waiting = new Map<number, (r: Reply) => void>();
  stdout.on('data', (chunk: Buffer) => {
    out += chunk.toString();
    let nl: number;
    while ((nl = out.indexOf('\n')) !== -1) {
      const line = out.slice(0, nl);
      out = out.slice(nl + 1);
      all += line + '\n';
      const msg = JSON.parse(line) as Reply;
      waiting.get(msg.id)?.(msg);
      waiting.delete(msg.id);
    }
  });
  const done = runClaudeBridge({ BRAINAI_DATA_DIR: dir, BRAINAI_PORT_FILE: portFile }, { stdin, stdout }, { initializeRetry: opts.retry ?? NO_RETRY });

  t.after(async () => {
    stdin.end();
    await done;
    process.stderr.write = realWrite;
    await opts.onEnd?.();
    rmSync(dir, { recursive: true, force: true });
    assert.ok(!stderr.includes(opts.token), 'the token never reaches stderr');
    assert.ok(!all.includes(opts.token), 'the token never reaches stdout');
  });

  let nextId = 1;
  const request = (method: string, params: unknown = {}): Promise<Reply> => {
    const id = nextId++;
    const reply = new Promise<Reply>((resolve) => waiting.set(id, resolve));
    stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    return reply;
  };
  const notify = (method: string) => stdin.write(JSON.stringify({ jsonrpc: '2.0', method }) + '\n');
  const initialize = () => request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'made-up-client', version: '0.0.1' } });
  return { dir, writePort, request, notify, initialize, stdin, done };
}

/** A local-mode BrainAI with a bridge key, and a bridge pointed at it (or at `port`). */
async function harness(t: TestContext, opts: { key?: boolean; port?: number | null; retry?: Retry } = {}) {
  const app = await startTestApp({ localMode: true });
  const livePort = Number(new URL(app.baseUrl).port);
  const { grantId, token } = app.deps.provider.issueLocalGrant({ name: 'Claude (desktop app)', clientName: 'Claude (desktop app)' });
  const b = runBridge(t, { token, grantId, key: opts.key, port: opts.port === undefined ? livePort : opts.port, retry: opts.retry, onEnd: () => app.close() });
  return { ...b, app, grantId, livePort };
}

test('the bridge carries initialize, tools/list and tools/call to BrainAI', async (t) => {
  const h = await harness(t);
  const init = await h.initialize();
  assert.equal(init.error, undefined);
  assert.equal(init.result.serverInfo.name !== undefined, true);
  h.notify('notifications/initialized');

  const list = await h.request('tools/list');
  const names = (list.result.tools as { name: string }[]).map((x) => x.name);
  assert.ok(names.includes('recall'), 'BrainAI\'s tools come through');

  const call = await h.request('tools/call', {
    name: 'remember',
    arguments: { kind: 'decision', content: 'Larkspur bakery: the sourdough starter is fed at 7 am.', project: 'larkspur', new_project: true },
  });
  assert.equal(call.error, undefined);
  assert.notEqual(call.result.isError, true, JSON.stringify(call.result));
  const row = h.app.deps.db!.prepare('SELECT content FROM memories WHERE content LIKE ?').get('%sourdough starter%') as { content: string } | undefined;
  assert.ok(row, 'the fact was saved');
});

test('BrainAI not running: a plain error, then the next request works once it is (port read afresh)', async (t) => {
  const h = await harness(t, { port: await closedPort() });
  const first = await h.initialize();
  assert.equal(first.error?.message, NOT_RUNNING);
  assert.equal(first.result, undefined);

  h.writePort(h.livePort);
  const second = await h.initialize();
  assert.equal(second.error, undefined);
  assert.ok(second.result.protocolVersion);
});

test('no port file at all reads as not running', async (t) => {
  const h = await harness(t);
  rmSync(join(h.dir, 'brainai.json'));
  assert.equal((await h.initialize()).error?.message, NOT_RUNNING);
});

test('the not-connected sentence names the Tools page as each computer shows it', () => {
  assert.match(notConnectedText('darwin'), /Settings › Tools on this Mac\.$/);
  assert.match(notConnectedText('win32'), /Settings › Tools on this computer\.$/);
  assert.equal(NOT_CONNECTED, notConnectedText(process.platform));
});

test('no key file: requests get NOT_CONNECTED', async (t) => {
  const h = await harness(t, { key: false });
  assert.equal((await h.initialize()).error?.message, NOT_CONNECTED);
  assert.equal((await h.request('tools/list')).error?.message, NOT_CONNECTED);
});

test('a revoked grant: requests get NOT_CONNECTED, even on a bridge that was working', async (t) => {
  const h = await harness(t);
  assert.equal((await h.initialize()).error, undefined);
  h.app.deps.provider.revokeGrant(h.grantId);
  assert.equal((await h.request('tools/list')).error?.message, NOT_CONNECTED);
  assert.equal((await h.request('tools/list')).error?.message, NOT_CONNECTED);
});

test('a key replaced while the bridge runs (Connect again, old grant revoked): the next request uses the new key and succeeds', async (t) => {
  const h = await harness(t);
  assert.equal((await h.initialize()).error, undefined);
  const fresh = h.app.deps.provider.issueLocalGrant({ name: 'Claude (desktop app)', clientName: 'Claude (desktop app)' });
  writeFileSync(join(h.dir, BRIDGE_KEY_FILE), JSON.stringify({ grant: fresh.grantId, token: fresh.token }), { mode: 0o600 });
  h.app.deps.provider.revokeGrant(h.grantId);
  const list = await h.request('tools/list');
  assert.equal(list.error, undefined);
  assert.ok((list.result.tools as unknown[]).length > 0);
});

const KEY = 'made-up-bridge-key-for-a-fake-brainai';
const jsonResult = (res: ServerResponse, id: unknown, result: unknown) =>
  res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id, result }));

test('the bridge dials 127.0.0.1, never localhost (the app listens on 127.0.0.1 only)', async (t) => {
  const hosts: string[] = [];
  const fake = await fakeBrainAI(t, (req, body, res) => {
    hosts.push(req.headers.host ?? '');
    jsonResult(res, body.id, { tools: [] });
  });
  const b = runBridge(t, { token: KEY, port: fake.port });
  const r = await b.request('tools/list');
  assert.deepEqual(r.result, { tools: [] });
  assert.deepEqual(hosts, [`127.0.0.1:${fake.port}`]);
});

test('BrainAI stopping during a slow tools/call: the waiting request gets NOT_RUNNING with its id', async (t) => {
  let arrived!: () => void;
  const held = new Promise<void>((resolve) => { arrived = resolve; });
  const fake = await fakeBrainAI(t, (_req, _body, res) => {
    // The answer stream opens, then nothing comes: the tool is still working.
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.flushHeaders();
    arrived();
  });
  const b = runBridge(t, { token: KEY, port: fake.port });
  const reply = b.request('tools/call', { name: 'recall', arguments: { query: 'sourdough' } });
  await held;
  await fake.stop();
  const r = await reply;
  assert.equal(r.id, 1);
  assert.equal(r.error?.message, NOT_RUNNING);
});

test('an answer that is not MCP (an HTML page) gets a plain sentence, not NOT_RUNNING', async (t) => {
  const fake = await fakeBrainAI(t, (_req, _body, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' }).end('<html><body>Made-up page</body></html>');
  });
  const b = runBridge(t, { token: KEY, port: fake.port });
  const r = await b.request('tools/list');
  assert.equal(r.error?.message, COULD_NOT_ANSWER);
  assert.doesNotMatch(r.error!.message, /HTTP -1/);
});

test('the login race: initialize waits for BrainAI to appear, then succeeds', async (t) => {
  const h = await harness(t, { port: null, retry: { intervalMs: 50, attempts: 40 } });
  const reply = h.initialize();
  await new Promise((resolve) => setTimeout(resolve, 200));
  h.writePort(h.livePort);
  const r = await reply;
  assert.equal(r.error, undefined);
  assert.ok(r.result.protocolVersion);
});

test('the login race: initialize gives up with NOT_RUNNING after its attempts; other requests fail at once', async (t) => {
  const b = runBridge(t, { token: KEY, port: await closedPort(), retry: { intervalMs: 20, attempts: 3 } });
  const started = Date.now();
  assert.equal((await b.request('tools/list')).error?.message, NOT_RUNNING);
  assert.ok(Date.now() - started < 50, 'tools/list is not retried');
  const init = await b.initialize();
  assert.equal(init.error?.message, NOT_RUNNING);
  assert.ok(Date.now() - started >= 60, 'initialize was tried again before giving up');
});

test('the bridge ends when its stdio transport closes by itself (an oversized line)', async (t) => {
  const b = runBridge(t, { token: KEY, port: await closedPort() });
  b.stdin.write(Buffer.alloc(10 * 1024 * 1024 + 1, 'x'));
  const ended = await Promise.race([b.done.then(() => true), new Promise((resolve) => setTimeout(() => resolve(false), 2000))]);
  assert.equal(ended, true);
});
