/**
 * Move it to a server (D5): the moving file is one archive with a copy of the database, made as the nightly backup
 * makes it (no password, authenticator, sessions or tokens), and the picture files. It is written only inside the
 * data folder, readable by the owner alone, and never served over HTTP: the person copies it to the server and
 * unpacks it there (docs/RUNBOOK.md, "Moving from the app").
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import type { DB } from '../db.js';
import { ARCHIVE_NAME, packArchive } from '../saved/archive.js';
import { busy } from '../busyMarker.js';

const folder = (dataDir: string) => join(dataDir, 'move');

/** Makes the moving file in `<dataDir>/move` and gives its path; an earlier moving file there is replaced. */
export function makeMoveFile(db: DB, dataDir: string, now: Date): Promise<string> {
  return busy('preparing the moving file', () => makeMoveFileWork(db, dataDir, now));
}

async function makeMoveFileWork(db: DB, dataDir: string, now: Date): Promise<string> {
  const dir = folder(dataDir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // The local date, as the nightly backup names its copies.
  const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const out = join(dir, `brainai-saved-${day}.tar.gz`);
  const partial = join(dataDir, `.move-${randomBytes(6).toString('hex')}.tar.gz`);
  try {
    await packArchive(db, dataDir, partial, now);
    for (const old of readdirSync(dir).filter((f) => ARCHIVE_NAME.test(f))) rmSync(join(dir, old));
    renameSync(partial, out);
    return out;
  } finally {
    rmSync(partial, { force: true });
  }
}

/** The moving file waiting in the data folder, if any. */
export function moveFile(dataDir: string): string | null {
  const dir = folder(dataDir);
  if (!existsSync(dir)) return null;
  const name = readdirSync(dir).filter((f) => ARCHIVE_NAME.test(f)).sort().pop();
  return name ? join(dir, name) : null;
}

export function deleteMoveFile(dataDir: string): void {
  const dir = folder(dataDir);
  if (!existsSync(dir)) return;
  for (const f of readdirSync(dir).filter((n) => ARCHIVE_NAME.test(n))) rmSync(join(dir, f));
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
