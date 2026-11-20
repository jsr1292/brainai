import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connectClient, loggedIn, startTestApp } from '../testing/helpers.js';
import { firstSteps, firstStepsDue } from './firstSteps.js';
import type { GrantInfo } from '../auth/provider.js';

const grant = (clientName: string, revokedAt: string | null = null): GrantInfo => ({
  id: clientName, clientId: clientName, clientName, createdAt: '2026-11-01T00:00:00Z', lastUsedAt: null, revokedAt, access: 'full', projects: [], setupVersion: null, setupSeenAt: null, toolNames: null, toolsSeenAt: null, savesWait: false,
});
const base = { localMode: true, grants: [] as GrantInfo[], hasMemory: false, backupElsewhere: false, canHide: true };
const done = (i: Parameters<typeof firstSteps>[0]) => firstSteps(i).map((s) => s.done);

test('the first steps: each rule on its own', () => {
  assert.deepEqual(done(base), [false, false, false, false, false, false]);
  // Any live grant is an assistant added and signed in; a revoked one is neither.
  assert.deepEqual(done({ ...base, grants: [grant('Claude Code')] }), [true, true, false, false, false, false]);
  assert.deepEqual(done({ ...base, grants: [grant('Claude Code', '2026-11-02T00:00:00Z')] }), [false, false, false, false, false, false]);
  assert.deepEqual(done({ ...base, hasMemory: true }), [false, false, true, true, false, false]);
  // A second assistant is a second distinct app: two sign-ins of one app, or a revoked second one, are not.
  assert.equal(done({ ...base, grants: [grant('Claude Code'), grant('Claude Code (laptop)')] })[4], false);
  assert.equal(done({ ...base, grants: [grant('Claude Code'), grant('Codex', '2026-11-02T00:00:00Z')] })[4], false);
  assert.equal(done({ ...base, grants: [grant('Claude Code'), grant('Codex')] })[4], true);
  assert.equal(done({ ...base, backupElsewhere: true })[5], true);
});

test('on a server, adding and signing in are one step and there is no "added" state', () => {
  const steps = firstSteps({ ...base, localMode: false, grants: [grant('Claude Code')] });
  assert.deepEqual(steps.map((s) => s.label), ['Connect an assistant', 'Save your first memory', 'Bring in what you already have', 'Add a second assistant, so they share what they know', 'Keep a backup somewhere other than this server']);
  assert.deepEqual(steps.map((s) => s.done), [true, false, false, false, false]);
  assert.ok(steps.every((s) => !s.addedTick));
});

test('the checklist is due until every step is done or it is hidden', () => {
  const all = firstSteps({ localMode: true, grants: [grant('Claude Code'), grant('Codex')], hasMemory: true, backupElsewhere: true, canHide: true });
  assert.equal(firstStepsDue(all, false), false);
  assert.equal(firstStepsDue(firstSteps(base), false), true);
  assert.equal(firstStepsDue(firstSteps(base), true), false);
});

test('a brand-new brain shows the first steps; once an assistant is connected that step is ticked', async (t) => {
  const statusDir = mkdtempSync(join(tmpdir(), 'brainai-steps-'));
  const app = await startTestApp({ statusDir });
  t.after(() => app.close());
  const f = await loggedIn(app);
  const first = await (await f('/')).text();
  assert.match(first, /No projects yet\. They appear here as soon as an assistant saves something about one\./);
  assert.doesNotMatch(first, /Connect your first assistant/);
  assert.match(first, /<h2 id="first-steps-h">First steps<\/h2>/);
  assert.match(first, /<span class="fs-label">Connect an assistant<\/span>/);
  assert.match(first, /<a class="fs-do" href="\/settings#setup">Connect ›<\/a>/);
  assert.match(first, /data-copy="Remember that I prefer short answers\."/);
  assert.doesNotMatch(first, />0</);
  await connectClient(app.baseUrl, f, 'Claude Code');
  const after = await (await f('/')).text();
  assert.match(after, /<li class="fs-item is-done"[^>]*>\s*<span class="fs-mark" data-n="1"[^>]*><\/span>\s*<span class="fs-text"><span class="fs-label">Connect an assistant /);
});

test('Hide these steps hides them for good, in a file in the data directory', async (t) => {
  const statusDir = mkdtempSync(join(tmpdir(), 'brainai-steps-'));
  const app = await startTestApp({ statusDir });
  t.after(() => app.close());
  const f = await loggedIn(app);
  assert.match(await (await f('/')).text(), /<form method="post" action="\/first-steps\/hide"[^>]*><button[^>]*>Hide these steps<\/button><\/form>/);
  const r = await f('/first-steps/hide', { method: 'POST', body: new URLSearchParams(), redirect: 'manual' });
  assert.equal(r.status, 303);
  assert.equal(r.headers.get('location'), '/');
  assert.ok(existsSync(join(statusDir, 'first-steps-hidden')));
  assert.doesNotMatch(await (await f('/')).text(), /First steps/);
});

test('the checklist is only on the plain home, never in the desktop list pane', async (t) => {
  const app = await startTestApp({ statusDir: mkdtempSync(join(tmpdir(), 'brainai-steps-')) });
  t.after(() => app.close());
  const f = await loggedIn(app);
  assert.doesNotMatch(await (await f('/?pane=projects')).text(), /First steps/);
});

test('the backup step is ticked only by a current second copy, and says why otherwise', () => {
  const step = (backupCopy: Parameters<typeof firstSteps>[0]['backupCopy'], backupElsewhere = false) => firstSteps({ ...base, backupElsewhere, backupCopy }).at(-1)!;
  assert.equal(step({ kind: 'first' }).done, false);
  assert.equal(step({ kind: 'first' }).hint, 'Copied with the next backup, or press Back up now in Settings');
  assert.equal(step({ kind: 'failed', reason: 'Disk full /Volumes/Spare/x', why: 'write', at: 'x' }).hint, 'Last copy failed: The copy could not be written.');
  assert.equal(step({ kind: 'failed', reason: 'Disk full', why: 'write', at: 'x' }).href, '/settings#backup-copy');
  assert.match(step({ kind: 'old', at: 'x' }).hint!, /more than 8 days/);
  assert.equal(step({ kind: 'ok', at: 'x' }, true).done, true);
  assert.equal(step({ kind: 'ok', at: 'x' }, true).hint, undefined);
  // Once a copy has worked, later failures and staleness do not un-tick the step.
  const ever = (backupCopy: Parameters<typeof firstSteps>[0]['backupCopy']) => firstSteps({ ...base, backupElsewhere: false, backupCopy, backupCopyEverWorked: true }).at(-1)!;
  assert.equal(ever({ kind: 'failed', reason: 'x', why: 'folder', at: 'x' }).done, true);
  assert.equal(ever({ kind: 'old', at: 'x' }).done, true);
  assert.equal(ever({ kind: 'old', at: 'x' }).hint, undefined);
  assert.equal(ever({ kind: 'off' }).done, false);
});
