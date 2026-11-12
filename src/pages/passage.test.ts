/** B10: a page hit shows the passage that matched, not just the section's first lines. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { passage } from './passage.js';

const filler = (n: number) => Array.from({ length: n }, (_, i) => `word${i}`).join(' ');

test('the passage is the window with the query words, marked with … where it was cut', () => {
  const md = `${filler(80)} The restic retention keeps 7 daily and 4 weekly snapshots. ${filler(80)}`;
  const p = passage(md, 'restic retention');
  assert.match(p, /restic retention keeps 7 daily/);
  assert.ok(p.startsWith('…') && p.endsWith('…'), p);
  assert.ok(p.length <= 302, `${p.length}`);
});

test('accents and case do not matter to the match', () => {
  const md = `${filler(80)} La RETENCIÓN de copias dura treinta días. ${filler(80)}`;
  assert.match(passage(md, 'retencion copias'), /RETENCIÓN de copias/);
});

test('with no word of the query in it, the section\'s first lines', () => {
  const md = `Backups run nightly. ${filler(100)}`;
  const p = passage(md, 'zebra');
  assert.ok(p.startsWith('Backups run nightly.'), p);
  assert.ok(p.endsWith('…'));
});

test('a short section is returned whole, without marks', () => {
  assert.equal(passage('Backups run **nightly**.', 'nightly'), 'Backups run nightly.');
});

test('the window never cuts a [[link]] or a character in two', () => {
  const md = `${filler(70)} see [[homelab — the mini PC at home]] for restic 😀😀😀 retention ${'😀'.repeat(200)}`;
  const p = passage(md, 'restic retention');
  assert.doesNotMatch(p, /\[\[|\]\]/);
  assert.doesNotMatch(p, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/, 'no lone surrogate');
  assert.match(p, /retention/);
});

test('a huge section with an unclosed mark, or a query word found thousands of times, stays fast', () => {
  const big = `${'_x '.repeat(10)}\`unclosed ${'pc word '.repeat(12_000)}`;
  const t0 = performance.now();
  const p = passage(big, 'pc');
  const ms = performance.now() - t0;
  assert.match(p, /pc/);
  assert.ok(ms < 60, `${ms.toFixed(0)} ms`);
});
