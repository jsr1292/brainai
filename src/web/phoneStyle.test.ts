/*
 * The phone's stylesheet is locked: below 1100 px nothing may change, so style.css must stay exactly the snapshot taken
 * before the desktop work (src/web/phone-style.snapshot.css, kept out of static/ so it never ships), with only the three
 * edits of the desktop boundary (desktop design §5.2): two wide rules moved to desk.css, and the off-by-one at 1100 fixed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const now = readFileSync(new URL('./static/style.css', import.meta.url), 'utf8');
const snap = readFileSync(new URL('./phone-style.snapshot.css', import.meta.url), 'utf8');

/** Replaces `from` with `to`, and throws unless `from` occurs exactly once. */
function once(text: string, from: string, to: string): string {
  const at = text.indexOf(from);
  if (at < 0 || text.indexOf(from, at + 1) >= 0) throw new Error(`anchor not found exactly once: ${from.slice(0, 60)}`);
  return text.slice(0, at) + to + text.slice(at + from.length);
}

/** The snapshot with the three desk edits applied; exported only for this file's own tests. */
export function deskEdits(snapshot: string): string {
  const start = snapshot.indexOf('@media (min-width: 1100px) {\n  .phome.has-panel');
  if (start < 0 || snapshot.indexOf('@media (min-width: 1100px) {\n  .phome.has-panel', start + 1) >= 0) throw new Error('anchor not found exactly once: the wide project panel block');
  const block = snapshot.slice(start, snapshot.indexOf('\n}\n', start) + 3);
  let out = once(snapshot, block, '');
  out = once(out, '@media (min-width: 1101px) { .toc-fold { display: none; } }\n', '');
  out = once(out, '(below 1101px)', '(below 1100px)');
  out = once(out, '@media (max-width: 1100px) {', '@media (max-width: 1099px) {');
  return out;
}

test('style.css is the phone snapshot with exactly the three desk edits', () => {
  assert.equal(now, deskEdits(snap));
  assert.doesNotMatch(now, /min-width: 110[01]px/);
  assert.match(now, /@media \(max-width: 1099px\) \{\n  \.pages-wrap\.with-aside/);
});

test('deskEdits refuses a snapshot whose anchors are missing or doubled', () => {
  assert.throws(() => deskEdits(snap.replace('@media (max-width: 1100px) {', '@media (max-width: 1000px) {')), /exactly once/);
  assert.throws(() => deskEdits(snap + '\n@media (min-width: 1101px) { .toc-fold { display: none; } }\n'), /exactly once/);
});
