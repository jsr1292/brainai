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
