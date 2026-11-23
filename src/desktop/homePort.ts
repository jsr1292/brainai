/**
 * BrainAI's usual port and the one it runs on. The app keeps the port its apps were connected to ("home") in brainai.json
 * and, when that port was busy at login, runs on another one for that run only (see src-tauri/src/port.rs). The file
 * is `{ "port": <running now>, "home": <the usual one>, "misses": n, "previous": [<ports the home moved away from>] }`; an
 * older file has only `port`.
 */
import { readFileSync } from 'node:fs';

export interface Ports { port: number | null; home: number | null; previous: number[] }

const valid = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n > 0 && n < 65536;

/** The ports in the file (nothing valid when it is missing or odd). */
export function readPorts(portFile: string): Ports {
  try {
    const f = JSON.parse(readFileSync(portFile, 'utf8')) as { port?: unknown; home?: unknown; previous?: unknown };
    return { port: valid(f.port) ? f.port : null, home: valid(f.home) ? f.home : null, previous: Array.isArray(f.previous) ? f.previous.filter(valid) : [] };
  } catch { return { port: null, home: null, previous: [] }; }
}

/** The port the apps are connected to: `home` when the file has one, else `port` (what an older file holds). */
export const usualPort = (p: Ports): number | null => p.home ?? p.port;

/** The usual port when the app is running on another one this time, else null (also when the file is missing or odd). */
export function temporaryHomePort(portFile: string, running: number): number | null {
  const home = readPorts(portFile).home;
  return home !== null && home !== running ? home : null;
}
