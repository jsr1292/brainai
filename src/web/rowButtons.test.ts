/*
 * Buttons repeated once per row (Undo, Revoke, Add as project, Withdraw, Copy) say which row they act on, so a
 * screen reader moving from button to button does not hear "Undo, button" five times. Each name starts with the
 * visible word, so speech control ("click Revoke") still finds it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connectClient, loggedIn, startTestApp } from '../testing/helpers.js';

const ai = { type: 'ai', name: 'Claude Code' } as const;

test('row buttons on Projects, Settings, page notes and discussions name their row', async (t) => {
  const app = await startTestApp();
  t.after(() => app.close());
  const f = await loggedIn(app);
  const post = (path: string, body: Record<string, string>) => f(path, { method: 'POST', body: new URLSearchParams(body) });

  // Projects: Not in the brain yet, and Done today.
  const { device } = app.deps.devices.create('Mac');
  app.deps.devices.storeReport(device.id, ['Casa Azul', 'carpeta sin título'].map((name) => ({ name, git: true, branch: 'main', uncommitted: 0, unpushed: 0, lastCommit: null, remotes: [] })) as never);
  app.deps.devices.ignore('carpeta sin título');
  await app.deps.service.remember({ kind: 'roadmap', project: 'wildlog', content: 'Now: release\nWaiting on you: run release.sh; connect ChatGPT' }, ai);
  assert.equal((await post('/projects/wildlog/waiting/1/done', { text: 'connect ChatGPT' })).status, 303);
  const home = await (await f('/?project=wildlog')).text();
  assert.match(home, /<button type="submit" class="sm" aria-label="Add as project: Casa Azul">Add as project<\/button>/);
  assert.match(home, /<button type="submit" class="ghost sm" aria-label="Ignore Casa Azul">Ignore<\/button>/);
  assert.match(home, /<button type="submit" class="ghost sm" aria-label="Undo ignoring carpeta sin título">Undo<\/button>/);
  assert.match(home, /<button type="submit" class="ghost small" aria-label="Undo done: connect ChatGPT">Undo<\/button>/);

  // Settings: devices and connections.
  await connectClient(app.baseUrl, f, 'Claude Code');
  const settings = await (await f('/settings')).text();
  assert.match(settings, /<button type="submit" class="secondary" aria-label="Revoke the device Mac">Revoke<\/button>/);
  assert.match(settings, /<button type="submit" class="secondary" aria-label="Revoke Claude Code">Revoke<\/button>/);
  assert.match(settings, /<summary>Change<span class="visually-hidden"> Claude Code<\/span><span class="chev"><\/span><\/summary>/);

  // A page's notes: Withdraw names the note, cut short when it is long.
  app.deps.registry.create('cellar', { state: 'open' }, 'owner');
  const page = await app.deps.pages.create({ title: 'Cellar', project: 'cellar', body: 'The cellar app.' }, 'owner');
  const long = 'Deploys go through Xcode Cloud now, and TestFlight builds are made every night from the main branch';
  assert.equal((await post(`/pages/${page.id}/notes`, { text: long, section: '' })).status, 303);
  const pageBody = await (await f(`/pages/${page.id}`)).text();
  assert.match(pageBody, /<button type="submit" class="ghost small" aria-label="Withdraw note: Deploys go through Xcode Cloud now, and TestFlight builds are made every…">Withdraw<\/button>/);

  // A discussion: Copy says whose request it copies.
  const d = app.deps.discussions.open({ name: 'Claude Code', model: 'Opus 4', access: 'full' }, { title: 'Which database?', question: 'SQLite or Postgres?', ask: ['ChatGPT', 'Grok'] });
  const disc = await (await f(`/discussions/${d.id}`)).text();
  assert.match(disc, /aria-label="Copy the request for ChatGPT">Copy<\/button>/);
  assert.match(disc, /aria-label="Copy the request for Grok">Copy<\/button>/);
});
