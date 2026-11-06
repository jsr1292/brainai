// The publish gate's secret scan (scripts/publish/check-public-tree.sh): every text file under a folder, line by line,
// through the brain's own key detector: in code, key shapes only (looksLikeKey: "password = x" is normal test data);
// in docs and settings files (.md, .yml, .json, .txt, .env*), credentials written out too (findSecret). Also a
// Cloudflare tunnel token, which is base64 JSON with no dots, so the detector's JWT shape misses it.
// Prints file:line and the kind of key, never the key. Usage: tsx src/scripts/secretScan.ts <folder>; exit 1 on a find.
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findSecret, looksLikeKey } from '../memory/secrets.js';

/**
 * The made-up keys the detector's own tests use. A key counts as synthetic by its shape, not by the file it is in,
 * so a real key pasted into one of those test files is still found.
 */
const SYNTHETIC: RegExp[] = [
  /\b(?:sk|rk|pk|gh[pousr]|github_pat)[-_][\w-]*?abcdefghij[\w-]*/g, // an alphabet run: ghp_abcdefghij…, sk-ant-api03-abcdefghij…
  /\bghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8\b/g,
  /\bAKIAABCDEFGHIJKLMNOP\b/g,
  /\beyJhIjoiYWJjZGVmZ2hpams\.[\w.-]*/g, // a JWT whose payload is {"a":"abcdefghijk…
  // A header alone inside a string literal in code; not when a key body follows it (a key inside JSON).
  /-----BEGIN [A-Z ]*PRIVATE KEY-----(?=['"`]|\\n(?![A-Za-z0-9+/=]{20}))/g,
];

const TUNNEL_TOKEN = /\beyJhIjoi[A-Za-z0-9+/=]{60,}/;

/** Docs and settings files, where a written-out credential ("password: x") is a leak, not test data. */
export const isProse = (path: string): boolean => /(^|\/)\.env[^/]*$|\.(md|ya?ml|json|txt|example)$/i.test(path);

export interface Found { line: number; reason: string }

/**
 * Every line of the text that holds a key-shaped string once the known synthetic fixtures are taken out; in prose,
 * also a written-out credential.
 */
export function scanText(text: string, prose = false): Found[] {
  const found: Found[] = [];
  text.split('\n').forEach((raw, i) => {
    const line = SYNTHETIC.reduce((s, re) => s.replace(re, ' '), raw);
    const reason = TUNNEL_TOKEN.test(line) ? 'tunnel token' : prose ? findSecret(line)?.reason ?? null : looksLikeKey(line);
    if (reason) found.push({ line: i + 1, reason });
  });
  return found;
}

function* files(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* files(path);
    else if (entry.isFile()) yield path;
  }
}

/** Every find in the text files under root (a file with a NUL byte in its first 8000 is binary and skipped). */
export function scanTree(root: string): (Found & { file: string })[] {
  const out: (Found & { file: string })[] = [];
  for (const path of files(root)) {
    const bytes = readFileSync(path);
    if (bytes.subarray(0, 8000).includes(0)) continue;
    const file = relative(root, path);
    for (const f of scanText(bytes.toString('utf8'), isProse(file))) out.push({ file, ...f });
  }
  return out;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = process.argv[2];
  if (!root) {
    console.error('Usage: secretScan.ts <folder>');
    process.exit(2);
  }
  const found = scanTree(root);
  for (const f of found) console.log(`${f.file}:${f.line}: a key-shaped string (${f.reason})`);
  process.exit(found.length > 0 ? 1 : 0);
}
