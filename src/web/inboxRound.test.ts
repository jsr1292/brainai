/* The layout round's Inbox rules: the badge counts only what needs the owner and never scans for tidy-ups, one count for
   Home, Settings and the Inbox, the answer line sits outside the pane, and an answer opens the next item. */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loggedIn, startTestApp } from '../testing/helpers.js';
import { createSideStatus } from './sideStatus.js';
import { nextHref } from './back.js';
import type { Memory } from '../memory/types.js';

const ai = { type: 'ai', name: 'Claude Code' } as const;
const grok = { type: 'ai', name: 'Grok' } as const;
const form = (body: Record<string, string> = {}): RequestInit => ({ method: 'POST', body: new URLSearchParams(body) });

async function start(t: TestContext, opts: Parameters<typeof startTestApp>[0] = {}) {
  const app = await startTestApp(opts);
  t.after(() => app.close());
  return { app, f: await loggedIn(app) };
}
type Ctx = Awaited<ReturnType<typeof start>>;
const suggest = async ({ app }: Ctx, content: string) => (await app.deps.service.remember({ kind: 'profile', content }, grok) as any).suggestion as { id: string };
const duplicatePair = async ({ app }: Ctx) => {
  const save = async (content: string) => ((await app.deps.service.remember({ kind: 'decision', content, project: 'garden', allowDuplicate: true, newProject: true }, ai)) as { memory: Memory }).memory;
  await save('Prefers dark mode');
  await save('Prefers dark mode');
};

test('the badge and every other page never run the duplicate or tidy scans; the Inbox page runs them once', async (t) => {
  const c = await start(t);
  await duplicatePair(c);
  await suggest(c, 'Has a Synology NAS');
  let scans = 0;
  const dup = c.app.deps.service.duplicates.bind(c.app.deps.service);
  c.app.deps.service.duplicates = (...a: Parameters<typeof dup>) => { scans++; return dup(...a); };
  c.app.advance(60_000);
  for (const path of ['/', '/settings', '/review', '/pages', '/graph', '/skills']) { assert.equal((await c.f(path)).status, 200, path); assert.equal(scans, 0, `${path} never scans for duplicates`); }
  assert.match(await (await c.f('/')).text(), /aria-label="1 waiting">1</);
  await (await c.f('/approvals')).text();
  await (await c.f('/approvals')).text();
  assert.equal(scans, 1, 'the Inbox scans once; the second look reuses the memo');
});

test('tidy-ups are listed under a quiet heading and are not in the badge or the header count', async (t) => {
  const c = await start(t);
  await duplicatePair(c);
  const only = await (await c.f('/approvals')).text();
  assert.match(only, /Nothing waits for you · 1 tidy-up when you have time/);
  assert.match(only, /Tidy-ups · 1 · when you have time/);
  assert.doesNotMatch(only, /side-count/, 'no badge for a tidy-up');
  await suggest(c, 'Has a Synology NAS');
  await suggest(c, 'Lives in Berlin');
  const body = await (await c.f('/approvals')).text();
  assert.match(body, /2 things wait for you · 1 tidy-up when you have time/);
  assert.match(body, /<span class="side-count" aria-label="2 waiting">2<\/span>/);
  assert.ok(body.indexOf('Approvals · 2') < body.indexOf('Tidy-ups · 1'), 'tidy-ups come last');
});

test('Home\'s For you, Settings\' Brain health and the Inbox count approvals alike, skill proposals included', async (t) => {
  const c = await start(t);
  await suggest(c, 'Has a Synology NAS');
  c.app.deps.skills.propose({ name: 'release-notes', description: 'Use when writing release notes.', body: 'Group them.', files: [] }, 'Claude');
  assert.match(await (await c.f('/approvals')).text(), /2 things wait for you/);
  assert.match(await (await c.f('/')).text(), /2 changes wait for your approval/);
  assert.match(await (await c.f('/settings')).text(), /2 changes wait for your approval/);
});

test('the status, notice and error line is the first child of the Inbox, outside the pane that the phone hides', async (t) => {
  const c = await start(t);
  const a = await suggest(c, 'Has a Synology NAS');
  await suggest(c, 'Lives in Berlin');
  await c.f(`/suggestions/${a.id}/reject`, form({ back: '/approvals' }));
  const body = await (await c.f('/approvals')).text();
  const open = body.indexOf('<div class="inbox');
  const head = body.indexOf('<div class="inbox-head">');
  assert.ok(head > open && head < body.indexOf('<nav class="inbox-list"'), 'before the list');
  const pane = body.slice(body.indexOf('<section class="inbox-pane"'));
  assert.doesNotMatch(pane, /undo-line|action="\/inbox\/undo"/, 'not inside .inbox-pane');
  assert.match(body.slice(head, body.indexOf('<nav class="inbox-list"')), /action="\/inbox\/undo"/);
  // An error (an answer already given elsewhere) is outside it too.
  const late = await (await c.f(`/suggestions/${a.id}/approve`, form({ back: '/approvals' }))).text();
  assert.match(late.slice(late.indexOf('<div class="inbox-head">'), late.indexOf('<nav class="inbox-list"')), /already answered/);
  assert.doesNotMatch(late.slice(late.indexOf('<section class="inbox-pane"')), /already answered/);
});

test('approve and reject from the pane open the next item, not always the first', async (t) => {
  const c = await start(t);
  const s = [await suggest(c, 'Has a Synology NAS'), await suggest(c, 'Lives in Berlin'), await suggest(c, 'Walks daily')];
  const order = c.app.deps.service.pendingSuggestions().map((x) => x.id);
  assert.deepEqual([...order].sort(), s.map((x) => x.id).sort());
  const second = await (await c.f(`/approvals?id=${order[1]}`)).text();
  const next = second.match(/name="next" value="([^"]+)"/)?.[1];
  assert.equal(next, `suggestion:${order[2]}`, 'the card carries the one after it');
  const r = await c.f(`/suggestions/${order[1]}/approve`, form({ back: '/approvals', next: next! }));
  assert.equal(r.headers.get('location'), `/approvals?id=${order[2]}`);
  const rej = await c.f(`/suggestions/${order[2]}/reject`, form({ back: '/approvals', next: `suggestion:${order[0]}` }));
  assert.equal(rej.headers.get('location'), `/approvals?id=${order[0]}`);
  // Never anywhere else: a next that is not an Inbox key is ignored, and Home's card keeps going Home.
  assert.equal((await c.f(`/suggestions/${order[0]}/reject`, form({ back: '/approvals', next: '//evil.example' }))).headers.get('location'), '/approvals');
  assert.equal(nextHref('https://evil.example/'), null);
  assert.equal(nextHref('suggestion:a b'), '/approvals?id=a%20b');
});

test('settling a disagreement from the pane says Done and opens the next item', async (t) => {
  const c = await start(t);
  const save = async (content: string, project = 'homelab') => ((await c.app.deps.service.remember({ kind: 'decision', content, project, allowDuplicate: true, newProject: true }, ai)) as { memory: Memory }).memory;
  const a = await save('The server listens on port 3000');
  const b = await save('The server listens on port 3100');
  const dis = c.app.deps.service.flagDisagreement(a.id, b.id, 'Two different ports', ai).disagreement;
  await suggest(c, 'Has a Synology NAS');
  const page = await (await c.f(`/disagreements?id=${dis.id}`)).text();
  const next = page.match(/name="next" value="([^"]+)"/)?.[1];
  assert.ok(next?.startsWith('suggestion:'), 'the pair is followed by the suggestion in the list');
  const r = await c.f(`/disagreements/${dis.id}/settle`, form({ how: 'both', back: '/approvals', next: next! }));
  assert.match(r.headers.get('location')!, /^\/approvals\?id=/);
  assert.match(await (await c.f('/approvals')).text(), /<span>Done\.<\/span>/);
});

test('tidy answers in the pane come back to the Inbox with a Done line; on Tidy up itself they stay there', async (t) => {
  const c = await start(t);
  await duplicatePair(c);
  const pair = c.app.deps.service.duplicates()[0]!;
  const item = await (await c.f(`/facts/tidy?item=${encodeURIComponent(`pair:${pair.a.id}:${pair.b.id}`)}`)).text();
  assert.match(item, /action="\/duplicates\/keep-both"><input type="hidden" name="back" value="inbox">/);
  const pane = await c.f('/duplicates/keep-both', form({ a: pair.a.id, b: pair.b.id, back: 'inbox' }));
  assert.equal(pane.headers.get('location'), '/approvals');
  assert.match(await (await c.f('/approvals')).text(), /<span>Done\.<\/span>/);
  await duplicatePair(c); // a new pair is not the dismissed one
  const own = await c.f('/tidy/statuses/keep', form({ project: 'garden' }));
  assert.equal(own.headers.get('location'), '/facts/tidy');
});

test('the side status follows an answer (when the response finishes) and an assistant\'s write; the Inbox page primes it', async (t) => {
  const c = await start(t);
  const s = await suggest(c, 'Has a Synology NAS');
  assert.match(await (await c.f('/')).text(), /aria-label="1 waiting">1</);
  await c.f(`/suggestions/${s.id}/reject`, form({ back: '/' }));
  assert.doesNotMatch(await (await c.f('/')).text(), /side-count/, 'the owner\'s answer shows at once');
  // The cache itself: primed with the Inbox page's own number, cleared by invalidate.
  let n = 3;
  const side = createSideStatus({ ...c.app.deps, service: { pendingSuggestions: () => new Array(n), openDisagreements: () => [] } as never, now: () => new Date(0) } as never);
  assert.equal(side.needsYouCount(), 3);
  n = 5;
  assert.equal(side.needsYouCount(), 3, 'cached');
  side.prime(7);
  assert.equal(side.needsYouCount(), 7, 'primed by the Inbox page');
  side.invalidate();
  assert.equal(side.needsYouCount(), 5);
});

test('Settings: Back up now, and saving the second folder, say so; a network path is refused', async (t) => {
  const statusDir = mkdtempSync(join(tmpdir(), 'round-status-'));
  const backups = mkdtempSync(join(tmpdir(), 'round-backups-'));
  const spare = mkdtempSync(join(tmpdir(), 'round-spare-'));
  t.after(() => { for (const d of [statusDir, backups, spare]) rmSync(d, { recursive: true, force: true }); });
  const { app, f } = await start(t, { localMode: true, statusDir, backupDir: backups });
  const ok = await f('/settings/backup-now', { method: 'POST', headers: { Origin: app.baseUrl } });
  assert.equal(ok.headers.get('location'), '/settings#health');
  assert.match(await (await f('/settings')).text(), /<p class="notice" role="status">Backed up at \d\d:\d\d ✓<\/p>/);
  assert.doesNotMatch(await (await f('/settings')).text(), /Backed up at/, 'said once');
  const saved = await f('/settings/backup-copy', form({ folder: spare, action: 'save' }));
  assert.equal(saved.headers.get('location'), '/settings#backup-copy');
  assert.match(await (await f('/settings')).text(), /Saved\. Each daily backup is now copied to/);
  for (const bad of ['\\\\nas\\share\\backups', '//nas/share/backups']) {
    const r = await f('/settings/backup-copy', form({ folder: bad, action: 'save' }));
    assert.equal(r.status, 400, bad);
    assert.match(await r.text(), /network address/);
  }
  assert.doesNotMatch(await (await f('/settings?folder=' + encodeURIComponent('//nas/share'))).text(), /value="\/\/nas/);
  assert.doesNotMatch(await (await f('/settings?folder=' + encodeURIComponent('\\\\nas\\share'))).text(), /value="\\\\nas/);
  const picked = await (await f('/settings?folder=' + encodeURIComponent(backups))).text();
  assert.match(picked, /Chosen just now, not saved yet\. Press Save to use it\./);
  assert.match(picked, /Saved now: <span class="path">/, 'the saved folder still shows');
});
