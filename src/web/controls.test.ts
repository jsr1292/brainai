/** C2: "Saves wait for me" per connection and "Pause all saves from assistants", through Settings and the real /mcp route. */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { connectClient, loggedIn, startTestApp } from '../testing/helpers.js';
import { HOLD_REASON } from '../memory/service.js';

async function world(t: TestContext) {
  const app = await startTestApp();
  t.after(() => app.close());
  const f = await loggedIn(app);
  app.deps.registry.create('brainai', { state: 'open', area: 'apps' }, 'owner');
  const { accessToken } = await connectClient(app.baseUrl, f, 'Codex');
  let id = 0;
  const call = async (name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> => {
    const res = await fetch(app.baseUrl + '/mcp', {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json', 'mcp-protocol-version': '2025-06-18' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } }),
    });
    const raw = await res.text();
    const json = JSON.parse(raw.startsWith('{') ? raw : raw.split('\n').find((l) => l.startsWith('data:'))!.slice(5));
    const r = json.result;
    return { text: r.content.find((b: any) => !String(b.text).startsWith('BrainAI operating rules'))?.text ?? '', isError: !!r.isError };
  };
  const grant = () => app.deps.provider.listGrants().find((g) => !g.revokedAt)!;
  return { app, f, call, grant };
}
const form = (body: Record<string, string>) => ({ method: 'POST', body: new URLSearchParams(body) });

test('Settings › Assistants: each connection has "Saves wait for me", off by default, with help text that says page edits are paused', async (t) => {
  const { f, grant } = await world(t);
  assert.equal(grant().savesWait, false);
  const html = await (await f('/settings')).text();
  assert.match(html, new RegExp(`<form method="post" action="/clients/${grant().id}/saves-wait"`));
  assert.match(html, /<input type="checkbox" name="wait" value="1"> Saves wait for me/);
  assert.match(html, /These cannot wait and are refused instead: page writes and edits/);
  assert.doesNotMatch(html, /saves wait for you<\/span>/);
});

test('turning it on holds that connection\'s saves in the Inbox with the reason, through the real /mcp route, and the setting shows', async (t) => {
  const { app, f, call, grant } = await world(t);
  assert.equal((await f(`/clients/${grant().id}/saves-wait`, form({ wait: '1' }))).status, 303);
  assert.equal(grant().savesWait, true);
  const r = await call('remember', { kind: 'decision', project: 'brainai', content: 'Held by the connection setting' });
  assert.match(r.text, /^Held for the owner: this assistant's saves wait for the owner's review, so nothing is saved yet\./);
  const pending = app.deps.service.pendingSuggestions();
  assert.equal(pending.length, 1);
  assert.equal(pending[0]!.reason, HOLD_REASON);
  // The Inbox shows it with its reason, and it is offered for approval like any held save.
  const inbox = await (await f('/approvals')).text();
  assert.match(inbox, /Held by the connection setting/);
  assert.match(inbox, /This assistant&#39;s saves wait for you\. Saved as a decision in brainai if you approve\./);
  assert.match(await (await f('/settings')).text(), /saves wait for you<\/span>/);
  // Page edits from it are refused.
  const page = await call('write_page', { title: 'brainai — notes', project: 'brainai', body: 'x' });
  assert.deepEqual([page.isError, page.text], [true, 'Page edits from this assistant are paused: the owner reviews its saves.']);
  assert.equal(app.deps.pages.list().length, 0);
  // Off again: the very next call saves directly.
  await f(`/clients/${grant().id}/saves-wait`, form({}));
  assert.equal(grant().savesWait, false);
  assert.match((await call('remember', { kind: 'decision', project: 'brainai', content: 'Saved right away now' })).text, /^Saved\./);
});

test('a held removal says it deletes, not that it saves', async (t) => {
  const { app, f, call, grant } = await world(t);
  const m = (await app.deps.service.remember({ kind: 'decision', project: 'brainai', content: 'A fact the assistant wants removed' }, { type: 'owner' })) as any;
  await f(`/clients/${grant().id}/saves-wait`, form({ wait: '1' }));
  await call('forget', { id: m.memory.id });
  const inbox = await (await f('/approvals')).text();
  assert.match(inbox, /This assistant&#39;s saves wait for you\. Deleted from brainai if you approve\./);
  assert.doesNotMatch(inbox, /Saved as a decision in brainai if you approve/);
});

test('an unknown connection id is a 404', async (t) => {
  const { f } = await world(t);
  assert.equal((await f('/clients/nope/saves-wait', form({ wait: '1' }))).status, 404);
});

test('Pause all saves: the switch in Settings stops every write through /mcp, reads work, the banner shows on every dashboard page, and Resume undoes it', async (t) => {
  const { app, f, call } = await world(t);
  const before = await (await f('/settings')).text();
  assert.match(before, /<form method="post" action="\/settings\/pause"><button type="submit" class="secondary">Pause all saves from assistants<\/button><\/form>/);
  assert.doesNotMatch(before, /Saving is paused/);
  const fact = await app.deps.service.remember({ kind: 'decision', project: 'brainai', content: 'A fact that stays as it is' }, { type: 'owner' });
  const id = (fact as any).memory.id as string;

  assert.equal((await f('/settings/pause', form({}))).status, 303);
  assert.ok(app.deps.service.savesPausedSince());
  const paused = 'Saving is paused by the owner right now; tell the owner what you would have saved.';
  assert.equal((await call('remember', { kind: 'decision', project: 'brainai', content: 'Not saved while paused' })).text, paused);
  assert.equal((await call('update_memory', { id, content: 'Not changed while paused' })).text, paused);
  assert.equal((await call('forget', { id })).text, paused);
  assert.equal((await call('write_page', { title: 'brainai — notes', project: 'brainai', body: 'x' })).text, paused);
  assert.equal(app.deps.service.get(id)!.content, 'A fact that stays as it is');
  assert.equal(app.deps.service.pendingSuggestions().length, 0);
  assert.match((await call('recall', { query: 'fact that stays' })).text, /A fact that stays as it is/);
  assert.match((await call('project_brief', { project: 'brainai' })).text, /A fact that stays as it is/);

  for (const path of ['/', '/pages', '/facts', '/approvals', '/review/now', '/activity', '/graph', '/settings']) {
    const html = await (await f(path)).text();
    assert.match(html, /<div class="notice undo-line" role="status"><span>Saving is paused: assistants cannot save, change or forget anything\.<\/span><form method="post" action="\/settings\/pause\/resume"><button type="submit" class="linklike">Resume<\/button><\/form><\/div>/, path);
  }
  assert.match(await (await f('/settings')).text(), /Saving is paused since[\s\S]*Resume saves/);

  // Resume from the banner on a page goes back to that page.
  const res = await f('/settings/pause/resume', { ...form({}), headers: { Referer: `${app.baseUrl}/facts?show=replaced` } });
  assert.deepEqual([res.status, res.headers.get('location')], [303, '/facts?show=replaced']);
  assert.equal(app.deps.service.savesPausedSince(), null);
  assert.doesNotMatch(await (await f('/facts')).text(), /Saving is paused/);
  assert.match((await call('remember', { kind: 'decision', project: 'brainai', content: 'Saved after resume' })).text, /^Saved\./);
});

test('Resume never redirects to a protocol-relative path from the Referer', async (t) => {
  const { app, f } = await world(t);
  for (const path of ['//evil.example/x', '/\\evil.example/x']) {
    await f('/settings/pause', form({}));
    const res = await f('/settings/pause/resume', { ...form({}), headers: { Referer: `${app.baseUrl}${path}` } });
    assert.equal(res.status, 303, path);
    assert.equal(res.headers.get('location'), '/settings#connections', path);
  }
});

test('Resume without a usable Referer goes to Settings; both switches need the owner', async (t) => {
  const { app, f } = await world(t);
  await f('/settings/pause', form({}));
  const res = await f('/settings/pause/resume', { ...form({}), headers: { Referer: 'https://evil.example/x' } });
  assert.deepEqual([res.status, res.headers.get('location')], [303, '/settings#connections']);
  for (const path of ['/settings/pause', '/settings/pause/resume']) {
    const anon = await fetch(app.baseUrl + path, { method: 'POST', redirect: 'manual', headers: { Origin: app.baseUrl } });
    assert.equal(anon.status, 302);
    assert.match(anon.headers.get('location') ?? '', /^\/login/);
  }
  assert.equal(app.deps.service.savesPausedSince(), null, 'an anonymous POST did not pause anything');
});
