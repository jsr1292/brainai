/** The Spanish docs mirror the English ones: same files, same headings and code blocks, linked to each other, links that resolve. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/** Contributor notes that are English only (they explain how to translate). */
const ENGLISH_ONLY = new Set(['I18N.md']);

const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');
const mdIn = (dir: string): string[] => readdirSync(join(ROOT, dir)).filter((f) => f.endsWith('.md')).sort();

const pairs: { en: string; es: string }[] = [
  { en: 'README.md', es: 'README.es.md' },
  { en: 'SECURITY.md', es: 'SECURITY.es.md' },
  ...mdIn('docs').filter((f) => !ENGLISH_ONLY.has(f)).map((f) => ({ en: `docs/${f}`, es: `docs/es/${f}` })),
];

/** Headings (outside code blocks) and fence lines of a Markdown text. */
function shape(text: string): { headings: number; fences: number } {
  let inFence = false, headings = 0, fences = 0;
  for (const line of text.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) { fences++; inFence = !inFence; continue; }
    if (!inFence && /^#{1,6}\s+\S/.test(line)) headings++;
  }
  return { headings, fences };
}

test('every English doc has a Spanish twin and every Spanish doc an English one', () => {
  for (const { en, es } of pairs) {
    assert.ok(existsSync(join(ROOT, en)), `${en} exists`);
    assert.ok(existsSync(join(ROOT, es)), `${en} has a Spanish twin ${es}`);
  }
  const spanish = [...mdIn('docs/es').map((f) => `docs/es/${f}`), 'README.es.md', 'SECURITY.es.md'];
  assert.deepEqual(spanish.sort(), pairs.map((p) => p.es).sort(), 'no Spanish file without an English one');
});

test('twins have the same number of headings and code fences', () => {
  for (const { en, es } of pairs) assert.deepEqual(shape(read(es)), shape(read(en)), `${es} vs ${en}`);
});

test('each English file starts with "Leer en español" and each Spanish file with "Read in English", linking to its twin', () => {
  for (const { en, es } of pairs) {
    const first = (p: string): string => read(p).split('\n')[0]!;
    const toEs = /^Leer en español: \[([^\]]+)\]\(([^)]+)\)$/.exec(first(en));
    const toEn = /^Read in English: \[([^\]]+)\]\(([^)]+)\)$/.exec(first(es));
    assert.ok(toEs, `${en} starts with the "Leer en español" line`);
    assert.ok(toEn, `${es} starts with the "Read in English" line`);
    assert.equal(resolve(ROOT, dirname(en), toEs![2]!), resolve(ROOT, es), `${en} links to ${es}`);
    assert.equal(resolve(ROOT, dirname(es), toEn![2]!), resolve(ROOT, en), `${es} links to ${en}`);
  }
});

test('the relative links of the Spanish docs resolve to files that exist', () => {
  for (const { es } of pairs) {
    const text = read(es).replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '');
    for (const m of text.matchAll(/\]\(([^)\s]+)\)/g)) {
      const target = m[1]!.split('#')[0]!;
      if (target === '' || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
      assert.ok(existsSync(resolve(ROOT, dirname(es), target)), `${es}: ${m[1]} does not resolve`);
    }
  }
});

test('one word for the start page in the Spanish docs: Inicio', () => {
  for (const { es } of pairs) assert.doesNotMatch(read(es), /página de inicio(?! de sesión)|\bla Home\b|\bHome\b(?! Assistant)/, es);
});
