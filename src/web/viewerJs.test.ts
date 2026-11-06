/*
 * viewer.js, the full-size viewer for pictures (and, from batch I3, diagrams): its pure helpers run here in node; the
 * page part is guarded by `typeof document`, so importing it has no side effects.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const v = await import(new URL('./static/viewer.js', import.meta.url).href);

test('viewerScale starts at the largest scale that fits (never above 1), steps by 1.25, and stays between Fit and 4', () => {
  const fit = v.viewerScale({ w: 1179, h: 2556 }, { w: 390, h: 700 }, 0);
  assert.ok(Math.abs(fit - 700 / 2556) < 1e-9);
  assert.ok(Math.abs(v.viewerScale({ w: 1179, h: 2556 }, { w: 390, h: 700 }, 1) - fit * 1.25) < 1e-9);
  assert.equal(v.viewerScale({ w: 1179, h: 2556 }, { w: 390, h: 700 }, -3), fit);
  assert.equal(v.viewerScale({ w: 1179, h: 2556 }, { w: 390, h: 700 }, 40), 4);
  assert.equal(v.viewerScale({ w: 200, h: 100 }, { w: 390, h: 700 }, 0), 1, 'a small picture is not blown up');
  assert.equal(v.viewerScale({ w: 0, h: 0 }, { w: 390, h: 700 }, 0), 1, 'no size yet');
});
