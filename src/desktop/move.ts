/**
 * Move it to a server (D5): the moving file is one archive with a copy of the database, made as the nightly backup
 * makes it (no password, authenticator, sessions or tokens), and the picture files. It is written only inside the
 * data folder, readable by the owner alone, and never served over HTTP: the person copies it to the server and
 * unpacks it there (docs/RUNBOOK.md, "Moving from the app").
 */
import { execFile } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { backupNow } from '../backup.js';
import type { DB } from '../db.js';

const NAME = /^brainai-move-\d{4}-\d{2}-\d{2}\.tar\.gz$/;
const folder = (dataDir: string) => join(dataDir, 'move');

/** Makes the moving file in `<dataDir>/move` and gives its path; an earlier moving file there is replaced. */
export async function makeMoveFile(db: DB, dataDir: string, now: Date): Promise<string> {
  const dir = folder(dataDir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const staging = mkdtempSync(join(dataDir, '.move-'));
  try {
    const copy = await backupNow(db, staging, 1, now, dataDir);
    renameSync(copy, join(staging, 'memory.db'));
    const day = /memory-(\d{4}-\d{2}-\d{2})\.db$/.exec(copy)![1];
    const out = join(dir, `brainai-move-${day}.tar.gz`);
    // Packed inside this run's own staging folder (same disk), so two runs at once never share a half-written file.
    const partial = join(staging, 'out.tar.gz');
    const parts = existsSync(join(staging, 'images')) ? ['memory.db', 'images'] : ['memory.db'];
    // The system tar (macOS, Linux and Windows 10+ all have one); the server unpacks it with the same command. Without
    // macOS's file attributes and ._ files, which a Linux server's tar would warn about for every file.
    const plain = process.platform === 'darwin' ? ['--no-xattrs', '--no-mac-metadata'] : [];
    await promisify(execFile)('tar', ['-czf', partial, ...plain, '-C', staging, ...parts], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
    chmodSync(partial, 0o600);
    for (const old of readdirSync(dir).filter((f) => NAME.test(f))) rmSync(join(dir, old));
    renameSync(partial, out);
    return out;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

/** The moving file waiting in the data folder, if any. */
export function moveFile(dataDir: string): string | null {
  const dir = folder(dataDir);
  if (!existsSync(dir)) return null;
  const name = readdirSync(dir).filter((f) => NAME.test(f)).sort().pop();
  return name ? join(dir, name) : null;
}

export function deleteMoveFile(dataDir: string): void {
  const dir = folder(dataDir);
  if (!existsSync(dir)) return;
  for (const f of readdirSync(dir).filter((n) => NAME.test(n))) rmSync(join(dir, f));
}

/** Where this brain lives now, once the owner said it moved (`<data>/moved.json`). */
export function movedTo(dataDir: string): URL | null {
  try {
    const to = (JSON.parse(readFileSync(join(dataDir, 'moved.json'), 'utf8')) as { to?: unknown }).to;
    return typeof to === 'string' && to.startsWith('https://') ? new URL(new URL(to).origin) : null;
  } catch {
    return null;
  }
}

export function setMoved(dataDir: string, to: URL | null): void {
  const file = join(dataDir, 'moved.json');
  if (to) writeFileSync(file, `${JSON.stringify({ to: to.origin })}\n`);
  else rmSync(file, { force: true });
}

/** A server address the owner typed: https with a host, else null. */
export function serverAddress(text: string): URL | null {
  try {
    const u = new URL(text.trim());
    return u.protocol === 'https:' && u.hostname.includes('.') ? new URL(u.origin) : null;
  } catch {
    return null;
  }
}
