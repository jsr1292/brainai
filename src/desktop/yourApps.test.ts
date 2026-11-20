import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dismissNext, nextCard, outcome, readAnswer, saveAnswer, YOUR_APPS_SWITCH, type Answer } from './yourApps.js';
import type { ToolId } from './tools.js';

function fakeStore() {
  const m = new Map<string, string | null>();
  return { switchValue: (n: string) => m.get(n) ?? null, setSwitch: (n: string, v: string | null) => { m.set(n, v); } };
}
const found = (...ids: ToolId[]) => new Set<ToolId>(ids);

test('outcome splits ticked apps into works, not found and internet', () => {
  const o = outcome(['claude-code', 'cursor', 'chatgpt'], { found: found('claude-code'), reachOn: false, windows: false });
  assert.deepEqual(o.works, ['claude-code']);
  assert.deepEqual(o.notFound, ['cursor']);
  assert.deepEqual(o.internet, ['chatgpt']);
  assert.deepEqual(o.ways, ['reach', 'server', 'later']);
  assert.equal(o.internetWorks, false);
});

test('outcome offers no choice when Reach is already on', () => {
  const o = outcome(['chatgpt'], { found: found(), reachOn: true, windows: false });
  assert.equal(o.internetWorks, true);
  assert.deepEqual(o.ways, []);
});

test('outcome never offers reach on Windows', () => {
  const o = outcome(['chatgpt'], { found: found(), reachOn: false, windows: true });
  assert.deepEqual(o.ways, ['server', 'later']);
});

test('outcome with only internet apps has nothing that works yet', () => {
  const o = outcome(['chatgpt', 'grok'], { found: found('claude-code'), reachOn: false, windows: false });
  assert.deepEqual(o.works, []);
  assert.deepEqual(o.internet, ['chatgpt', 'grok']);
});

test('outcome offers no choice when only local apps are ticked', () => {
  assert.deepEqual(outcome(['codex'], { found: found('codex'), reachOn: false, windows: false }).ways, []);
});

test('saveAnswer replaces an earlier answer and clears dismissed', () => {
  const s = fakeStore();
  saveAnswer(s, ['chatgpt'], 'reach');
  dismissNext(s);
  assert.equal(readAnswer(s)!.dismissed, true);
  saveAnswer(s, ['grok', 'codex'], 'server');
  assert.deepEqual(readAnswer(s), { apps: ['grok', 'codex'], way: 'server', dismissed: false });
});

test('readAnswer drops unknown ids and reads garbage as null', () => {
  const s = fakeStore();
  assert.equal(readAnswer(s), null);
  s.setSwitch(YOUR_APPS_SWITCH, JSON.stringify({ apps: ['codex', 'bogus', 7], way: 'reach', dismissed: false }));
  assert.deepEqual(readAnswer(s), { apps: ['codex'], way: 'reach', dismissed: false });
  s.setSwitch(YOUR_APPS_SWITCH, JSON.stringify({ apps: ['codex'], way: 'nope' }));
  assert.equal(readAnswer(s)!.way, null);
  s.setSwitch(YOUR_APPS_SWITCH, '{not json');
  assert.equal(readAnswer(s), null);
  s.setSwitch(YOUR_APPS_SWITCH, '[1]');
  assert.equal(readAnswer(s), null);
});

test('nextCard is null after dismiss, for later, after a move, and once Reach is on', () => {
  const a: Answer = { apps: ['chatgpt'], way: 'reach', dismissed: false };
  assert.equal(nextCard({ ...a, dismissed: true }, { reachOn: false, moved: false }), null);
  assert.equal(nextCard({ ...a, way: 'later' }, { reachOn: false, moved: false }), null);
  assert.equal(nextCard(a, { reachOn: false, moved: true }), null);
  assert.equal(nextCard(a, { reachOn: true, moved: false }), null);
  assert.equal(nextCard(null, { reachOn: false, moved: false }), null);
});

test('nextCard is reach or server otherwise', () => {
  const a: Answer = { apps: ['chatgpt'], way: 'reach', dismissed: false };
  assert.equal(nextCard(a, { reachOn: false, moved: false }), 'reach');
  assert.equal(nextCard({ ...a, way: 'server' }, { reachOn: false, moved: false }), 'server');
  assert.equal(nextCard({ ...a, way: 'server' }, { reachOn: true, moved: false }), 'server');
});
