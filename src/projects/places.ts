import { ProjectError } from './types.js';

/** Where a project runs ("Runs on"): short place names such as minipc, pi or cloudflare, shown as diamonds in the graph. */
export const MAX_PLACES = 4;
export const MAX_PLACE_CHARS = 24;

/** Labels for the places everyone uses; any other name shows as written. */
export const PLACE_LABELS: Record<string, string> = {
  minipc: 'Mini PC', pi: 'Pi', mac: 'Mac', iphone: 'iPhone', cloudflare: 'Cloudflare', nas: 'NAS',
};

export function placeLabel(id: string): string {
  return Object.hasOwn(PLACE_LABELS, id) ? PLACE_LABELS[id]! : id;
}

const PLACE_RE = /^[\p{L}\p{N}][\p{L}\p{N}._-]*$/u;

/**
 * A comma-separated string or a list, as place names: trimmed, lowercased, spaces as one hyphen, empty entries and
 * repeats dropped. Throws for more than 4, one over 24 characters, or one with anything but letters, digits, . _ -.
 */
export function normalizePlaces(input: string | readonly string[]): string[] {
  const raw = typeof input === 'string' ? input.split(',') : input;
  const out: string[] = [];
  for (const entry of raw) {
    const s = String(entry).trim().toLowerCase().replace(/\s+/g, '-');
    if (s === '' || out.includes(s)) continue;
    if (s.length > MAX_PLACE_CHARS) throw new ProjectError('invalid', `Each place is at most ${MAX_PLACE_CHARS} characters`);
    if (!PLACE_RE.test(s)) throw new ProjectError('invalid', 'A place name has only letters, digits, dots, hyphens and underscores, such as minipc or pi');
    out.push(s);
  }
  if (out.length > MAX_PLACES) throw new ProjectError('invalid', `At most ${MAX_PLACES} places`);
  return out;
}
