import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { connect as tcpConnect, createServer as createTcpServer, type AddressInfo, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { startTestApp } from '../testing/helpers.js';
import { BRIDGE_KEY_FILE, NOT_CONNECTED, NOT_RUNNING, runClaudeBridge } from './claudeBridge.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const CHALLENGE = 'ab'.repeat(32);

async function freePort(): Promise<number> {
  const s = createTcpServer();
  await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', resolve));
  const port = (s.address() as AddressInfo).port;
  await new Promise<void>((resolve) => s.close(() => resolve()));
  return port;
}

/** A program on 127.0.0.1:port that is not BrainAI: it keeps every byte it receives and answers 503. */
async function squatter(t: TestContext, port: number) {
  let received = '';
  const sockets = new Set<Socket>();
  const server = createTcpServer((s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
    s.on('error', () => {});
    s.on('data', (c) => { received += c.toString('latin1'); s.end('HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'); });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  const close = () => new Promise<void>((resolve) => { if (!server.listening) return resolve(); for (const s of sockets) s.destroy(); server.close(() => resolve()); });
  t.after(close);
  return { received: () => received, close };
}

/**
 * A byte relay on 127.0.0.1:port to the real app on `target`, keeping what the client sent and what the app answered.
 * With `asHost` it rewrites the Host header as a relaying attacker would. close() drops its connections and stops
 * listening; dropConnections() only drops them, as an idle timeout does.
 */
async function relay(t: TestContext, port: number, target: number, asHost?: string) {
  let received = '';
  let answered = '';
  const sockets = new Set<Socket>();
  const server = createTcpServer((client) => {
    const upstream = tcpConnect(target, '127.0.0.1');
    for (const s of [client, upstream]) {
      sockets.add(s);
      s.on('close', () => sockets.delete(s));
      s.on('error', () => { client.destroy(); upstream.destroy(); });
    }
    client.on('data', (c) => {
      received += c.toString('latin1');
      upstream.write(asHost === undefined ? c : Buffer.from(c.toString('latin1').replace(/^Host: .*$/m, `Host: ${asHost}`), 'latin1'));
    });
    upstream.on('data', (c) => { answered += c.toString('latin1'); client.write(c); });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  const close = () => new Promise<void>((resolve) => { if (!server.listening) return resolve(); for (const s of sockets) s.destroy(); server.close(() => resolve()); });
  const dropConnections = () => { for (const s of sockets) s.destroy(); };
  t.after(close);
  return { received: () => received, answered: () => answered, close, dropConnections };
}

/** What a BrainAI that knows the key answers to the hello of `challenge` on `port`. */
const realProof = (token: string, challenge: string, port: number) =>
  createHmac('sha256', createHash('sha256').update(token).digest('hex')).update(challenge + String(port)).digest('hex');

/**
 * A program on 127.0.0.1:port that answers every request with the raw `answer` (nothing at all when null). A function
 * gets the hello's challenge, so an answer can carry the real proof and have only the one defect a test is about.
 */
async function rawListener(t: TestContext, port: number, answer: string | Buffer | ((challenge: string) => string) | null) {
  let received = '';
  const sockets = new Set<Socket>();
  const server = createTcpServer((s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
    s.on('error', () => {});
    s.on('data', (c) => {
      received += c.toString('latin1');
      if (answer === null) return;
      s.write(typeof answer === 'function' ? answer(/challenge=([0-9a-f]{64})/.exec(received)?.[1] ?? '') : answer);
    });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  t.after(() => new Promise<void>((resolve) => { for (const s of sockets) s.destroy(); server.close(() => resolve()); }));
  return { received: () => received, openConnections: () => sockets.size };
}

/** A local-mode BrainAI whose public URL names `publicPort`, a bridge key for it, and a bridge reading its port from a file. */
async function setup(t: TestContext, publicPort: number | null, bridgePort: () => number, helloTimeoutMs?: number) {
  const app = await startTestApp({ localMode: true, publicUrl: publicPort === null ? undefined : `http://localhost:${publicPort}` });
  const { grantId, token } = app.deps.provider.issueLocalGrant({ name: 'Claude (desktop app)', clientName: 'Claude (desktop app)' });
  const dir = mkdtempSync(join(tmpdir(), 'brainai-bridge-proof-'));
  writeFileSync(join(dir, BRIDGE_KEY_FILE), JSON.stringify({ grant: grantId, token }), { mode: 0o600 });
  const portFile = join(dir, 'brainai.json');
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const replies = new Map<number, any>();
  const waiting = new Map<number, (r: any) => void>();
  let buffer = '';
  stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString();
    let nl: number;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const msg = JSON.parse(buffer.slice(0, nl));
      buffer = buffer.slice(nl + 1);
      replies.set(msg.id, msg);
      waiting.get(msg.id)?.(msg);
    }
  });
  const done = runClaudeBridge({ BRAINAI_DATA_DIR: dir, BRAINAI_PORT_FILE: portFile }, { stdin, stdout }, { initializeRetry: { intervalMs: 1, attempts: 0 }, helloTimeoutMs });
  t.after(async () => {
    stdin.end();
    await done;
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });
  let nextId = 1;
  const request = (method: string, params: unknown = {}): Promise<any> => {
    const id = nextId++;
    writeFileSync(portFile, JSON.stringify({ port: bridgePort() }));
    const reply = new Promise<any>((resolve) => waiting.set(id, resolve));
    stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    return reply;
  };
  const initialize = () => request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'made-up-client', version: '0.0.1' } });
  const notify = (method: string) => stdin.write(JSON.stringify({ jsonrpc: '2.0', method }) + '\n');
  return { app, token, grantId, dir, request, initialize, notify, stdin, done };
}

test('the bridge never sends its key to a listener that cannot prove it is BrainAI', async (t) => {
  const P = await freePort();
  const b = await setup(t, P, () => P);
  const sq = await squatter(t, P);
  const reply = await b.initialize();
  assert.equal(reply.error?.message, NOT_RUNNING);
  assert.ok(!sq.received().includes(b.token), 'the key never reached the listener');
  assert.ok(!/authorization/i.test(sq.received()), 'no Authorization header was sent');
  assert.match(sq.received(), /^GET \/app\/bridge-hello\?/, 'it only asked for the proof');
});

test('after BrainAI quits, the bridge\'s next connection must prove itself before the key is sent', async (t) => {
  const P = await freePort();
  const b = await setup(t, P, () => P);
  const brain = await relay(t, P, Number(new URL(b.app.baseUrl).port));
  assert.equal((await b.initialize()).error, undefined);
  b.notify('notifications/initialized');
  assert.equal((await b.request('tools/list')).error, undefined);
  assert.ok(brain.received().includes(b.token), 'the real BrainAI got the key');

  await brain.close();
  await sleep(100);
  const sq = await squatter(t, P);
  const reply = await b.request('tools/list');
  assert.equal(reply.error?.message, NOT_RUNNING);
  assert.ok(sq.received().length > 0, 'the bridge did try the new listener');
  assert.ok(!sq.received().includes(b.token), 'the key never reached the new listener');
});

test('a listener answering 410 not_connected never receives an Authorization header', async (t) => {
  const P = await freePort();
  const b = await setup(t, P, () => P);
  let received = '';
  const server = createTcpServer((s) => {
    s.on('error', () => {});
    s.on('data', (c) => { received += c.toString('latin1'); s.end('HTTP/1.1 410 Gone\r\nContent-Type: application/json\r\nContent-Length: 25\r\nConnection: close\r\n\r\n{"state":"not_connected"}'); });
  });
  await new Promise<void>((resolve) => server.listen(P, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const reply = await b.initialize();
  assert.equal(reply.error?.message, NOT_CONNECTED);
  assert.ok(!/authorization/i.test(received), 'no Authorization header was sent');
  assert.ok(!received.includes(b.token), 'the key never reached the listener');
});

test('the bridge refuses a proof made by a BrainAI on another port', async (t) => {
  const P = await freePort();
  // The app believes it is on its own port Q; a listener on P relays to it, rewriting Host as an attacker would.
  const b = await setup(t, null, () => P);
  const q = new URL(b.app.baseUrl).port;
  const brain = await relay(t, P, Number(q), `localhost:${q}`);
  const reply = await b.initialize();
  assert.match(brain.answered(), /^HTTP\/1\.1 200 [\s\S]*"proof"/, 'the app really made a proof, for its own port');
  assert.equal(reply.error?.message, NOT_RUNNING);
  assert.ok(!brain.received().includes(b.token), 'the key never crossed the relay');
});

test('through the proof, initialize and a tool call still reach the real app', async (t) => {
  const P = await freePort();
  const b = await setup(t, P, () => P);
  await relay(t, P, Number(new URL(b.app.baseUrl).port));
  const init = await b.initialize();
  assert.equal(init.error, undefined);
  assert.ok(init.result.protocolVersion);
  b.notify('notifications/initialized');
  const call = await b.request('tools/call', {
    name: 'remember',
    arguments: { kind: 'decision', content: 'Larkspur bakery: the rye loaf bakes at 230 degrees.', project: 'larkspur', new_project: true },
  });
  assert.equal(call.error, undefined);
  assert.notEqual(call.result.isError, true, JSON.stringify(call.result));
  const row = b.app.deps.db!.prepare('SELECT content FROM memories WHERE content LIKE ?').get('%rye loaf%');
  assert.ok(row, 'the fact was saved');
});

test('bridge-hello answers only for a live local grant, and not outside local mode', async (t) => {
  const local = await startTestApp({ localMode: true });
  t.after(() => local.close());
  const port = new URL(local.baseUrl).port;
  const { grantId, token } = local.deps.provider.issueLocalGrant({ name: 'Claude (desktop app)', clientName: 'Claude (desktop app)' });
  const hello = (base: string, grant: string, challenge: string) =>
    fetch(`${base}/app/bridge-hello?grant=${encodeURIComponent(grant)}&challenge=${challenge}`);

  const ok = await hello(local.baseUrl, grantId, CHALLENGE);
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('cache-control'), 'no-store');
  const expected = createHmac('sha256', createHash('sha256').update(token).digest('hex')).update(CHALLENGE + port).digest('hex');
  assert.deepEqual(await ok.json(), { proof: expected });

  const gone = async (r: Response) => { assert.equal(r.status, 410); assert.equal(r.headers.get('cache-control'), 'no-store'); assert.deepEqual(await r.json(), { state: 'not_connected' }); };
  await gone(await hello(local.baseUrl, 'made-up-grant', CHALLENGE));
  assert.equal((await hello(local.baseUrl, grantId, 'abc')).status, 404, 'challenge not 64 hex characters');
  assert.equal((await hello(local.baseUrl, grantId, CHALLENGE.toUpperCase())).status, 404, 'uppercase challenge');
  local.deps.provider.revokeGrant(grantId);
  await gone(await hello(local.baseUrl, grantId, CHALLENGE));

  const server = await startTestApp();
  t.after(() => server.close());
  const other = server.deps.provider.issueLocalGrant({ name: 'Claude (desktop app)', clientName: 'Claude (desktop app)' });
  assert.equal((await hello(server.baseUrl, other.grantId, CHALLENGE)).status, 404, 'not in local mode');
});

const json = (body: string, extra = '') => `HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n${extra}\r\n${body}`;
/** Each answer carries the real proof; the one thing wrong with it is the named defect. */
const REFUSED_ANSWERS: [string, (token: string, port: number) => (challenge: string) => string][] = [
  ['a proof with non-ASCII characters of the right length', () => () => json(`{"proof":"\u00e9${'a'.repeat(63)}"}`)],
  ['an answer larger than 8 KiB', (token, port) => (c) => json(`{"proof":"${realProof(token, c, port)}","padding":"${'x'.repeat(9000)}"}`)],
  ['a chunked answer', (token, port) => (c) => {
    const body = `{"proof":"${realProof(token, c, port)}"}`;
    return `HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n${body.length.toString(16)}\r\n${body}\r\n0\r\n\r\n`;
  }],
  ['a 200 that says Connection: close', (token, port) => (c) => json(`{"proof":"${realProof(token, c, port)}"}`, 'Connection: close\r\n')],
  ['bytes after the body', (token, port) => (c) => json(`{"proof":"${realProof(token, c, port)}"}`) + '\r\n'],
];
for (const [what, answerFor] of REFUSED_ANSWERS) {
  test(`the bridge refuses ${what}, tells Claude BrainAI is not running and keeps running`, async (t) => {
    const P = await freePort();
    const b = await setup(t, P, () => P);
    const l = await rawListener(t, P, answerFor(b.token, P));
    assert.equal((await b.initialize()).error?.message, NOT_RUNNING);
    assert.equal((await b.request('tools/list')).error?.message, NOT_RUNNING, 'the bridge still answers');
    assert.ok(!/authorization/i.test(l.received()) && !l.received().includes(b.token), 'the key was never sent');
  });
}

test('a listener that accepts and says nothing: the request gets NOT_RUNNING after the time limit', async (t) => {
  const P = await freePort();
  const b = await setup(t, P, () => P, 150);
  const l = await rawListener(t, P, null);
  const started = Date.now();
  assert.equal((await b.initialize()).error?.message, NOT_RUNNING);
  assert.ok(Date.now() - started < 3000);
  assert.ok(!/authorization/i.test(l.received()), 'the key was never sent');
});

test('the bridge ends when Claude goes, and drops the connection still waiting for its proof', async (t) => {
  const P = await freePort();
  const b = await setup(t, P, () => P, 60_000);
  const l = await rawListener(t, P, null);
  void b.initialize();
  await sleep(100);
  assert.equal(l.openConnections(), 1, 'the bridge is waiting on its proof');
  b.stdin.end();
  const ended = await Promise.race([b.done.then(() => true), sleep(2000).then(() => false)]);
  assert.equal(ended, true);
  await sleep(300);
  assert.equal(l.openConnections(), 0, 'the waiting connection was closed');
});

test('after Connect again, the first request on a new connection uses the new key and succeeds', async (t) => {
  const P = await freePort();
  const b = await setup(t, P, () => P);
  const brain = await relay(t, P, Number(new URL(b.app.baseUrl).port));
  assert.equal((await b.initialize()).error, undefined);
  const fresh = b.app.deps.provider.issueLocalGrant({ name: 'Claude (desktop app)', clientName: 'Claude (desktop app)' });
  writeFileSync(join(b.dir, BRIDGE_KEY_FILE), JSON.stringify({ grant: fresh.grantId, token: fresh.token }), { mode: 0o600 });
  b.app.deps.provider.revokeGrant(b.grantId);
  brain.dropConnections(); // the idle connection is gone, as after the server's keep-alive timeout
  await sleep(50);
  const list = await b.request('tools/list');
  assert.equal(list.error, undefined);
});
