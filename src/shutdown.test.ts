import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { installShutdown } from './shutdown.js';

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  test(`${signal} stops accepting connections, clears the cleanup timer, closes the DB and exits 0`, async () => {
    const server = createServer((_req, res) => res.end('ok'));
    await new Promise<void>((resolve) => server.listen(0, resolve));
    let ticks = 0;
    const timer = setInterval(() => ticks++, 2);
    let closed = 0;
    const db = { close: () => { closed++; } };
    const proc = new EventEmitter();
    const exited = new Promise<number>((resolve) => installShutdown({ server, timer, db, proc, exit: resolve }));
    proc.emit(signal);
    proc.emit(signal);
    assert.equal(await exited, 0);
    assert.equal(server.listening, false);
    assert.equal(closed, 1);
    const seen = ticks;
    await sleep(20);
    assert.equal(ticks, seen, 'cleanup timer still running');
  });
}

test('docker-compose runs the app under an init process', () => {
  const compose = readFileSync(new URL('../docker-compose.yml', import.meta.url), 'utf8');
  const app = compose.split(/\n  tunnel:/)[0]!;
  assert.match(app, /\n    init: true\n/);
});

test('a stop waits for a running backup in parallel with closing the server, closes the DB after both, and never later than its deadline', async () => {
  const server = createServer((_req, res) => res.end('ok'));
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const events: string[] = [];
  server.on('close', () => events.push('server closed'));
  const db = { close: () => { events.push('db closed'); } };
  const proc = new EventEmitter();
  let release!: () => void;
  const idle = new Promise<void>((r) => { release = () => { events.push('backup ended'); r(); }; });
  const began = Date.now();
  const exited = new Promise<number>((resolve) => installShutdown({ server, timer: setInterval(() => {}, 1000), db, proc, exit: resolve, waitIdle: () => idle }));
  proc.emit('SIGTERM');
  await sleep(60);
  assert.equal(events.join(','), 'server closed', 'the server did not wait for the backup to close');
  release();
  assert.equal(await exited, 0);
  assert.equal(events.join(','), 'server closed,backup ended,db closed');
  assert.ok(Date.now() - began < 1000);
});

test('a backup that never ends cannot hold the stop past its deadline', async () => {
  const server = createServer((_req, res) => res.end('ok'));
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const events: string[] = [];
  const db = { close: () => { events.push('db closed'); } };
  const proc = new EventEmitter();
  const began = Date.now();
  const exited = new Promise<number>((resolve) => installShutdown({ server, timer: setInterval(() => {}, 1000), db, proc, exit: resolve, waitIdle: () => new Promise<void>(() => {}), deadlineMs: 150 }));
  proc.emit('SIGTERM');
  assert.equal(await exited, 0);
  assert.deepEqual(events, ['db closed']);
  assert.ok(Date.now() - began < 1500, 'stopped at the deadline');
});
