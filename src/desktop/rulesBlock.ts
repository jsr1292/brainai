/**
 * The rules block in a coding tool's instructions file (CLAUDE.md, AGENTS.md): the setup text between
 * `<!-- brain setup N -->` and `<!-- /brain setup -->` (src/setup/texts.ts). Only that part is ever replaced or
 * removed; everything else in the owner's file stays as it is, line ends included (D3).
 */
const START = /<!-- brain setup \d+ -->/;
const END = '<!-- /brain setup -->';

const eolOf = (text: string) => (text.includes('\r\n') ? '\r\n' : '\n');

/**
 * The host named in brain wording, as loose as people write it: "the brain (localhost:3100)" or
 * "the brain (MCP connector \"memory\", memory.example.com)". localhost:<port> first, else the last host-like word;
 * null when the brackets hold neither.
 */
export function hostIn(text: string): string | null {
  const inside = /the brain \(([^)]*)\)/.exec(text)?.[1];
  if (inside === undefined) return null;
  const local = /localhost:\d+/.exec(inside);
  if (local) return local[0];
  const hosts = inside.match(/[a-z0-9-]+(?:\.[a-z0-9-]+)+(?::\d+)?/gi);
  return hosts ? hosts[hosts.length - 1]!.toLowerCase() : null;
}

/**
 * The first complete block, and the host its text names. A block starts at the last opening line before its end
 * line, so a stray opening line further up never pulls the owner's own text into it.
 */
export function findBlock(text: string): { start: number; end: number; host: string | null } | null {
  const close = text.indexOf(END);
  if (close < 0) return null;
  let open = -1;
  for (const m of text.slice(0, close).matchAll(new RegExp(START.source, 'g'))) open = m.index!;
  if (open < 0) return null;
  const end = close + END.length;
  return { start: open, end, host: hostIn(text.slice(open, end)) };
}

/** Brain wording outside BrainAI's block (written by hand, or another installer): its host, or "" when unreadable. */
export function strayBrain(text: string): string | null {
  const b = findBlock(text);
  const rest = b ? text.slice(0, b.start) + text.slice(b.end) : text;
  if (!/the brain \(/.test(rest)) return null;
  return hostIn(rest) ?? '';
}

/** Replaces the block, or appends it after one blank line; keeps the file's line ends and ends with a newline. */
export function putBlock(text: string, block: string): string {
  const eol = text === '' ? '\n' : eolOf(text);
  const b = block.replace(/\r?\n/g, eol);
  const found = findBlock(text);
  if (found) return text.slice(0, found.start) + b + text.slice(found.end);
  if (text === '') return b + eol;
  return (text.endsWith(eol) ? text : text + eol) + eol + b + eol;
}

/** Removes the block and the blank line put before it. */
export function removeBlock(text: string): string {
  const found = findBlock(text);
  if (!found) return text;
  const eol = eolOf(text);
  let before = text.slice(0, found.start);
  let after = text.slice(found.end);
  if (after.startsWith(eol)) after = after.slice(eol.length);
  if (before.endsWith(eol + eol)) before = before.slice(0, -eol.length);
  return before + after;
}
