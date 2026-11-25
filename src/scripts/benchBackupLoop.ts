/**
 * Shows whether the server stays responsive while a backup runs: seeds a large brain in a temp folder, runs the
 * nightly backup with a second folder (pictures included), and reports the longest time the event loop was stuck.
 *
 *   node --import tsx src/scripts/benchBackupLoop.ts [rows=100000] [pictures=20000]
 *
 * Never touches real data: everything is under a fresh temp folder that is removed at the end.
 */
import { createServer, get } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { runBackup } from '../backup.js';
import { openDb } from '../db.js';
import { BackupCopy } from '../desktop/backupCopy.js';

const rows = Number(process.argv[2] ?? 100_000);
const pictures = Number(process.argv[3] ?? 20_000);
const root = mkdtempSync(join(tmpdir(), 'brain-bench-'));
try {
  const data = join(root, 'data');
  mkdirSync(data, { recursive: true });
  const db = openDb(join(data, 'memory.db'));
  const ins = db.prepare("INSERT INTO memories(id, kind, content, project, tags, embedding, created_at, created_by, updated_at, updated_by) VALUES (?, 'decision', ?, 'bench', '[]', ?, '2026-11-01', 'owner', '2026-11-01', 'owner')");
  const text = randomBytes(1500).toString('base64');
  const emb = randomBytes(3072);
  db.transaction(() => { for (let i = 0; i < rows; i++) ins.run(`m${i}`, `${i} ${text}`, emb); })();
  const pic = randomBytes(8000);
  for (let i = 0; i < pictures; i++) {
    const id = randomBytes(12).toString('hex');
    const d = join(data, 'images', id.slice(0, 2));
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, `${id}.png`), pic);
  }
  const second = join(root, 'second');
  mkdirSync(second);
  const copy = new BackupCopy(data);
  copy.set(second);

  const server = createServer((_q, r) => r.end('ok')).listen(0);
  await new Promise((r) => server.once('listening', r));
  const port = (server.address() as { port: number }).port;
  const ping = () => new Promise<number>((res) => { const t = Date.now(); get({ port, agent: false }, (r) => { r.resume(); r.on('end', () => res(Date.now() - t)); }).on('error', () => res(0)); });

  let last = Date.now();
  let worst = 0;
  const timer = setInterval(() => { const n = Date.now(); worst = Math.max(worst, n - last - 10); last = n; }, 10);
  let worstHttp = 0;
  const pinger = setInterval(() => { void ping().then((ms) => { worstHttp = Math.max(worstHttp, ms); }); }, 50);
  const t0 = Date.now();
  const run = await runBackup(db, join(root, 'main'), 7, new Date(), data, copy);
  const took = Date.now() - t0;
  // One more tick: a stall at the very end is only seen by the first timer that fires after it.
  await new Promise((r) => setTimeout(r, 100));
  clearInterval(timer);
  clearInterval(pinger);
  console.log(JSON.stringify({ rows, pictures, ok: run.ok, backupMs: took, worstLoopStallMs: worst, worstHttpMs: worstHttp }));
  server.closeAllConnections();
  server.close();
  db.close();
} finally {
  rmSync(root, { recursive: true, force: true });
}
