/*
 * The owner's OpenRouter key, kept in <data>/openrouter-key (mode 600) and nowhere else: never the database, a saved
 * copy, a page, a log line or an error. Written whole or not at all (a temp file, flushed, then a rename).
 */
import { chmodSync, closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from 'node:fs';
import { join } from 'node:path';

const FILE = 'openrouter-key';

/** A key is one printable word: no spaces, no line breaks. */
export function isKeyShaped(key: string): boolean {
  return /^[\x21-\x7e]{1,300}$/.test(key);
}

/** The saved key, or null when there is none. */
export function readKey(dataDir: string): string | null {
  try {
    const k = readFileSync(join(dataDir, FILE), 'utf8').trim();
    return k === '' ? null : k;
  } catch {
    return null;
  }
}

export function writeKey(dataDir: string, key: string): void {
  const k = key.trim();
  if (!isKeyShaped(k)) throw new Error('that does not look like an OpenRouter key');
  mkdirSync(dataDir, { recursive: true });
  const tmp = join(dataDir, `${FILE}.tmp`);
  try {
    rmSync(tmp, { force: true }); // a temp left by a crash may have a wider mode: never reused
    const fd = openSync(tmp, 'wx', 0o600);
    try {
      writeSync(fd, `${k}\n`);
      fsyncSync(fd);
    } finally { closeSync(fd); }
    chmodSync(tmp, 0o600);
    renameSync(tmp, join(dataDir, FILE));
  } catch (e) {
    rmSync(tmp, { force: true });
    throw new Error(`the key could not be saved (${(e as NodeJS.ErrnoException).code ?? 'write failed'})`);
  }
}

export function deleteKey(dataDir: string): void {
  rmSync(join(dataDir, FILE), { force: true });
}
