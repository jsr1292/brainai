import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// BrainAI is one product for anyone (spec 2026-11-13, goal 5): the separate work copy, its names and its rules are gone
// from the code, comments included. Tests may still name them to check they stay gone.
const src = dirname(fileURLToPath(import.meta.url));
const FORBIDDEN = ['work-memory', 'Work brain', 'Work memory', 'WORK_INSTRUCTIONS', "=== 'work'"];

function files(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (relative(src, path).split(sep).join('/') === 'web/static/vendor') continue;
      out.push(...files(path));
    } else if (entry.isFile() && !entry.name.endsWith('.test.ts')) {
      out.push(path);
    }
  }
  return out;
}

test('no file in src/ keeps the work split: its names, its rules or a branch on it', () => {
  const found: string[] = [];
  for (const file of files(src)) {
    const bytes = readFileSync(file);
    if (bytes.includes(0)) continue; // an image
    const text = bytes.toString('utf8');
    for (const word of FORBIDDEN) if (text.includes(word)) found.push(`${relative(src, file)}: ${word}`);
  }
  assert.deepEqual(found, []);
});

test('the check sees the folders it must see and skips only tests and vendored code', () => {
  const seen = files(src).map((f) => relative(src, f).split(sep).join('/'));
  assert.ok(seen.includes('mcp/server.ts') && seen.includes('web/static/desk.js'));
  assert.ok(!seen.some((f) => f.endsWith('.test.ts') || f.startsWith('web/static/vendor/')));
});
