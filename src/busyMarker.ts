import { renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The desktop app asks the server "are you there?" every few seconds, and starts a server that stops answering again.
 * Some work blocks the server's one thread for minutes (backups to a slow second folder, packing a copy, unpacking a
 * restore, hashing model files). While it runs the server writes `<data>/busy.json` ({what, since} in ms), so the app
 * knows the silence is work, not a hang. The app honours a marker for 30 minutes at most (watch.rs).
 */
const FILE = 'busy.json';
let dir: string | undefined;
let depth = 0;

/** Where the marker goes (the data folder). Until it is set, `busy` only runs the work. */
export function setBusyDir(dataDir: string | undefined): void {
  dir = dataDir;
  depth = 0;
  current = '';
  lastWrite = 0;
  // A server that has just started cannot be busy yet: a marker left by one that was killed is not to be believed.
  if (dir) {
    for (const f of [FILE, `.${FILE}.tmp`]) {
      try { rmSync(join(dir, f), { force: true }); } catch { /* as below */ }
    }
  }
}

let current = '';
let lastWrite = 0;
/** How often a long loop refreshes the marker's time at most. */
export const TICK_EVERY_MS = 30_000;

/** Called inside a long loop (per file, per 64 MB): refreshes the marker's time, at most every 30 s, while work is marked. */
export function busyTick(now: number = Date.now()): void {
  if (depth > 0 && now - lastWrite >= TICK_EVERY_MS) write(current, now);
}

function write(what: string, now: number = Date.now()): void {
  if (!dir) return;
  current = what;
  lastWrite = now;
  try {
    const tmp = join(dir, `.${FILE}.tmp`);
    writeFileSync(tmp, JSON.stringify({ what, since: now }));
    renameSync(tmp, join(dir, FILE));
  } catch { /* a marker that cannot be written must never stop the work */ }
}

function end(): void {
  depth = Math.max(0, depth - 1);
  if (depth === 0 && dir) {
    try { rmSync(join(dir, FILE), { force: true }); } catch { /* as above */ }
  }
}

/** Runs `fn` with the marker up; it comes down when `fn` ends (or its promise settles), however it ends. Nested and overlapping uses share one marker. */
export function busy<T>(what: string, fn: () => T): T {
  depth++;
  write(what);
  let out: T;
  try {
    out = fn();
  } catch (e) {
    end();
    throw e;
  }
  if (out && typeof (out as { then?: unknown }).then === 'function') {
    return (out as unknown as Promise<unknown>).finally(end) as unknown as T;
  }
  end();
  return out;
}
