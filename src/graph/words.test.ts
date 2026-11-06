import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_WORDS, normalWords, sectionText, threadWords, WORD_BAR, WordCounts, wordList } from './words.js';

/** 20 items: 'restic' in 3, 'nas' in 4, 'backups' in 15. */
function corpus(): WordCounts {
  const counts = new WordCounts();
  for (let i = 0; i < 20; i++) {
    const parts = [`item${i}`];
    if (i < 15) parts.push('backups');
    if (i < 3) parts.push('restic');
    if (i >= 3 && i < 7) parts.push('nas');
    counts.add(parts.join(' '));
  }
  return counts;
}

test('normalWords is the search normalisation', () => {
  assert.equal(normalWords('Fútbol: Lanes-blocks!'), 'futbol lanes blocks');
});

test('wordList drops stopwords, short words and the excluded names', () => {
  assert.deepEqual(wordList('The NAS keeps restic backups of wildlog', new Set(['wildlog'])), ['nas', 'keeps', 'restic', 'backups']);
});

test('rarity counts a word once per item', () => {
  const counts = new WordCounts();
  counts.add('restic restic nas');
  counts.add('restic');
  assert.equal(counts.items, 2);
  assert.equal(counts.df('restic'), 2);
  assert.equal(counts.df('nas'), 1);
  assert.equal(counts.rarity('restic'), Math.log(3 / 3));
  assert.equal(counts.rarity('nas'), Math.log(3 / 2));
});

test('thread words are shared, rare, not stopwords and not the project names', () => {
  const counts = corpus();
  assert.equal(WORD_BAR, 1.0);
  assert.equal(MAX_WORDS, 2);
  assert.deepEqual(threadWords(['Nightly backups of cairn to the NAS with restic'], ['outline backups go to the nas with restic'],
    counts, new Set(['cairn', 'outline'])), ['restic', 'nas']);
  assert.deepEqual(threadWords(['backups nightly'], ['backups weekly'], counts, new Set()), []);
});

test('a word the counts never saw gets a finite score and the order stays the same', () => {
  const counts = corpus();
  assert.ok(Number.isFinite(counts.rarity('telemetry')));
  assert.equal(counts.rarity('telemetry'), Math.log(21));
  for (let i = 0; i < 3; i++) {
    assert.deepEqual(threadWords(['restic telemetry nas'], ['telemetry restic nas'], counts, new Set()), ['telemetry', 'restic']);
  }
  assert.deepEqual(threadWords(['telemetry only here'], ['restic nas'], counts, new Set()), []);
});

test('a fenced block gives no words', () => {
  const t = sectionText('Flow', '```mermaid\nflowchart TD\nA-->B\n```\nrestic runs nightly');
  assert.match(t, /restic/);
  assert.doesNotMatch(t, /flowchart/);
  assert.match(t, /Flow/);
  const tilde = sectionText('Code', '~~~\nsecretword here\n~~~\nafter');
  assert.doesNotMatch(tilde, /secretword/);
  assert.match(tilde, /after/);
});
