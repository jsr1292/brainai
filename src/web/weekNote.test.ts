import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeBackupStatus } from '../backupStatus.js';
import { loggedIn, startTestApp } from '../testing/helpers.js';
import { clockTo, seedWildlogWeek } from '../testing/reviewFixtures.js';
import { UI_LANGUAGE_SWITCH } from '../i18n/uiLanguage.js';
import { WEEK_NOTICE_SWITCH } from './weekNote.js';

const KEY = 'a-made-up-app-key';

async function monday(t: TestContext, opts: Parameters<typeof startTestApp>[0] = {}) {
  const app = await startTestApp({ startAt: new Date('2026-10-18T08:00:00Z'), localMode: true, appSecret: KEY, ...opts });
  t.after(() => app.close());
  await seedWildlogWeek(app.deps, app.advance);
  return app;
}
const ask = (app: { baseUrl: string }, key: string | null = KEY) => fetch(app.baseUrl + '/app/week-note', { headers: key === null ? {} : { 'X-App-Key': key } });

test('GET /app/week-note: 200 with one English line, and reading it does not open the review', async (t) => {
  const app = await monday(t);
  const r = await ask(app);
  assert.equal(r.status, 200);
  const body = await r.json() as { monday: string; text: string };
  assert.equal(body.monday, '2026-10-26');
  assert.match(body.text, /^Your week: 3 steps done, \d+ waiting on you, \d+ stuck\.$/);
  assert.equal((await ask(app)).status, 200, 'still there: asking did not mark it read');
  assert.equal(app.deps.reviews.ensure('2026-10-26', 'owner')!.openedAt, null);
});

test('GET /app/week-note answers in the owner\'s language', async (t) => {
  const app = await monday(t);
  app.deps.store.setSwitch(UI_LANGUAGE_SWITCH, 'es');
  const body = await (await ask(app)).json() as { text: string };
  assert.match(body.text, /^Tu semana: 3 pasos hechos, /);
});

test('GET /app/week-note: 204 when the switch is off, and back to 200 when it is removed', async (t) => {
  const app = await monday(t);
  app.deps.store.setSwitch(WEEK_NOTICE_SWITCH, 'off');
  assert.equal((await ask(app)).status, 204);
  app.deps.store.setSwitch(WEEK_NOTICE_SWITCH, null);
  assert.equal((await ask(app)).status, 200);
});

test('GET /app/week-note: 204 once read, once dismissed, for an empty week and behind a backup warning', async (t) => {
  const read = await monday(t);
  assert.equal((await ask(read)).status, 200);
  read.deps.reviews.open('2026-10-26');
  assert.equal((await ask(read)).status, 204);

  const dismissed = await monday(t);
  assert.equal((await ask(dismissed)).status, 200);
  dismissed.deps.reviews.dismiss('2026-10-26');
  assert.equal((await ask(dismissed)).status, 204);

  // A week with nothing in it: the only fact is older than the reviewed week, so the review exists and is empty.
  const quiet = await startTestApp({ startAt: new Date('2026-10-05T08:00:00Z'), localMode: true, appSecret: KEY });
  t.after(() => quiet.close());
  await quiet.deps.service.remember({ kind: 'decision', content: 'a first fact', project: 'wildlog', newProject: true }, { type: 'ai', name: 'Claude Code' });
  clockTo(quiet.deps, quiet.advance, '2026-10-20T08:00:00Z');
  assert.equal(quiet.deps.reviews.present(quiet.deps.reviews.ensure('2026-10-12', 'owner')!, 'last', { kind: 'owner' }).empty, true);
  assert.equal((await ask(quiet)).status, 204);

  const dir = mkdtempSync(join(tmpdir(), 'status-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const warned = await monday(t, { statusDir: dir });
  writeBackupStatus(dir, 'nightly', { at: warned.deps.now().toISOString(), ok: false, error: 'disk full' });
  assert.equal((await ask(warned)).status, 204);
});

test('GET /app/week-note: 404 like an unknown page without the app key, with a wrong one, and outside the desktop app', async (t) => {
  const app = await monday(t);
  const unknown = await fetch(app.baseUrl + '/no-such-page-here');
  assert.equal((await ask(app, null)).status, unknown.status);
  assert.equal((await ask(app, 'nope')).status, 404);
  const server = await monday(t, { localMode: false });
  assert.equal((await ask(server)).status, 404);
});

test('POST /settings/week-notice turns the switch off and on, in the desktop app only', async (t) => {
  const app = await monday(t);
  const f = await loggedIn(app);
  const post = (body: string) => f('/settings/week-notice', { method: 'POST', body: new URLSearchParams(body) });
  assert.equal((await post('')).status, 303);
  assert.equal(app.deps.store.switchValue(WEEK_NOTICE_SWITCH), 'off');
  const box = /<input type="checkbox" name="weekNotice" value="on"( checked)?>/;
  const off = await (await f('/settings')).text();
  assert.match(off, /Tell me on Monday when my week is ready/);
  assert.equal(box.exec(off)?.[1], undefined, 'unchecked after off');
  assert.equal((await post('weekNotice=on')).status, 303);
  assert.equal(app.deps.store.switchValue(WEEK_NOTICE_SWITCH), null);
  assert.equal(box.exec(await (await f('/settings')).text())?.[1], ' checked', 'checked after on');
  const web = await monday(t, { localMode: false });
  const wf = await loggedIn(web);
  assert.doesNotMatch(await (await wf('/settings')).text(), /Tell me on Monday/);
});
