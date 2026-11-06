import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { loggedIn, startTestApp } from '../testing/helpers.js';

const owner = { type: 'owner' } as const;

async function start(t: TestContext) {
  const app = await startTestApp();
  t.after(() => app.close());
  app.deps.registry.create('wildlog', { state: 'open', area: 'apps' }, 'owner');
  await app.deps.service.remember({ kind: 'decision', content: 'wildlog is a SwiftUI app', project: 'wildlog' }, owner);
  return { app, f: await loggedIn(app) };
}
const form = (body: Record<string, string>) => ({ method: 'POST', body: new URLSearchParams(body) });
function report(app: Awaited<ReturnType<typeof start>>['app'], folders: Record<string, unknown>[]) {
  const { device } = app.deps.devices.create('Mac');
  app.deps.devices.storeReport(device.id, folders.map((x) => ({ git: true, branch: 'main', uncommitted: 0, unpushed: 0, lastCommit: null, remotes: [], ...x })) as never);
}

test('the panel shows the folder\'s git state, and the row shows not pushed', async (t) => {
  const { app, f } = await start(t);
  report(app, [{ name: 'wildlog', uncommitted: 3, unpushed: 2, lastCommit: new Date(Date.now() - 2 * 86_400_000).toISOString() }]);
  const body = await (await f('/?project=wildlog')).text();
  assert.match(body, /<li class="gitline">Folder <code>~\/Projects\/wildlog<\/code> · main · 3 uncommitted · 2 not pushed · last commit <time[^>]*>/);
  assert.match(body, /<span class="prow-name">wildlog<\/span>[\s\S]{0,400}<span class="chip plain">not pushed<\/span>/);
});

test('a folder whose git state is unknown says so instead of 0 uncommitted and 0 not pushed', async (t) => {
  const { app, f } = await start(t);
  report(app, [{ name: 'wildlog', uncommitted: null, unpushed: null }]);
  const body = await (await f('/?project=wildlog')).text();
  assert.match(body, /<li class="gitline">Folder <code>~\/Projects\/wildlog<\/code> · main · git state unknown \(git did not answer on the Mac\)/);
  assert.doesNotMatch(body, /0 not pushed/);
});

test('a folder report older than a day is marked on the git line, so old git state never reads as current', async (t) => {
  const { app, f } = await start(t);
  report(app, [{ name: 'wildlog', unpushed: 0 }]);
  assert.doesNotMatch(await (await f('/?project=wildlog')).text(), /last report from the Mac/);
  app.advance(3 * 86_400_000);
  const body = await (await loggedIn(app))('/?project=wildlog').then((r) => r.text());
  assert.match(body, /<li class="gitline">[^<]*<code>~\/Projects\/wildlog<\/code> · main · 0 uncommitted · 0 not pushed · no commits yet · <strong class="late-text">last report from the Mac 3 days ago<\/strong><\/li>/);
});

test('Not in the brain yet lists unmatched folders; Add creates the project with its folder, and Ignore hides the folder', async (t) => {
  const { app, f } = await start(t);
  report(app, [{ name: 'wildlog' }, { name: 'Casa Azul' }, { name: 'carpeta sin título', git: false }]);
  const home = await (await f('/')).text();
  const fold = home.slice(home.indexOf('<details class="fold notinbrain"'), home.indexOf('</details>', home.indexOf('<details class="fold notinbrain"')));
  // The hidden peek is the 1920 px shelf's (desktop only); on the phone the summary reads as before.
  assert.match(fold, /<summary class="row nolead">Not in the brain yet<span class="n">2<\/span><span class="nib-peek" hidden><span>Casa Azul<\/span><span>carpeta sin título<\/span><\/span><span class="chev"><\/span><\/summary>/);
  assert.match(fold, /<p class="nib-intro">Folders in ~\/Projects that no project matches\. Last report from Mac <time datetime="[^"]+" title="[^"]+">just now<\/time>\.<\/p>/,
    'one sentence, not a flex .meta row that puts the time and the full stop on lines of their own');
  assert.match(fold, /Casa Azul[\s\S]*<form method="post" action="\/folders\/add"><input type="hidden" name="name" value="Casa Azul"><button type="submit" class="sm" aria-label="Add as project: Casa Azul">Add as project<\/button><\/form>/);
  assert.doesNotMatch(fold, />wildlog</);
  const add = await f('/folders/add', form({ name: 'Casa Azul' }));
  assert.equal(add.status, 303);
  assert.equal(add.headers.get('location'), '/?project=casa-azul#panel');
  const p = app.deps.registry.get('casa-azul')!;
  assert.deepEqual([p.state, p.folder], ['open', 'Casa Azul']);
  const ign = await f('/folders/ignore', form({ name: 'carpeta sin título' }));
  assert.equal(ign.status, 303);
  assert.equal(ign.headers.get('location'), '/#notyet');
  // Ignored folders stay under the fold, each with an Undo, until the Mac stops reporting them.
  const after = await (await f('/')).text();
  assert.match(after, /<details class="fold notinbrain" id="notyet">/);
  assert.match(after, /Ignored <span class="n">1<\/span>/);
  assert.equal((await f('/folders/add', form({ name: 'not-in-report' }))).status, 400);
  assert.equal((await f('/folders/ignore', form({ name: 'not-in-report' }))).status, 400);
});

test('ignored folders sit under Not in the brain yet with Undo', async (t) => {
  const { app, f } = await start(t);
  report(app, [{ name: 'old-repo', git: false }]);
  const ign = await f('/folders/ignore', form({ name: 'old-repo' }));
  assert.equal(ign.status, 303);
  assert.equal(ign.headers.get('location'), '/#notyet');
  const home = await (await f('/')).text();
  const fold = home.slice(home.indexOf('<details class="fold notinbrain"'));
  assert.match(fold, /Ignored <span class="n">1<\/span>/);
  assert.match(fold, /aria-label="Undo ignoring old-repo">Undo<\/button>/);
  assert.doesNotMatch(await (await f('/settings')).text(), /Ignored folders/);
  // Undo puts the folder back among the unmatched ones; the new path and the old one both do the work.
  const undo = await f('/folders/unignore', form({ name: 'old-repo' }));
  assert.equal(undo.status, 303);
  assert.equal(undo.headers.get('location'), '/#notyet');
  assert.match(await (await f('/')).text(), /Not in the brain yet<span class="n">1<\/span>[\s\S]*old-repo/);
  await f('/folders/ignore', form({ name: 'old-repo' }));
  const old = await f('/settings/folders/unignore', form({ name: 'old-repo' }));
  assert.equal(old.status, 303);
  assert.equal(old.headers.get('location'), '/#notyet');
  assert.match(await (await f('/')).text(), /Not in the brain yet<span class="n">1<\/span>[\s\S]*old-repo/);
  const anon = await fetch(`${app.baseUrl}/settings/folders/unignore`, { method: 'POST', redirect: 'manual', headers: { origin: app.baseUrl, 'content-type': 'application/x-www-form-urlencoded' }, body: 'name=x' });
  assert.equal(anon.status, 302, 'the owner only');
});

test('with no report there is no fold and no git line', async (t) => {
  const { f } = await start(t);
  const body = await (await f('/?project=wildlog')).text();
  assert.doesNotMatch(body, /notinbrain|class="gitline"|not pushed</);
});

test('Add as project gives folders like example.com and Cámara valid project names, and refuses a folder name it cannot store', async (t) => {
  const { app, f } = await start(t);
  report(app, [{ name: 'example.com' }, { name: 'Cámara' }, { name: "Bob's app" }]);
  assert.equal((await f('/folders/add', form({ name: 'example.com' }))).headers.get('location'), '/?project=example-com#panel');
  assert.equal(app.deps.registry.get('example-com')!.folder, 'example.com');
  assert.equal((await f('/folders/add', form({ name: 'Cámara' }))).headers.get('location'), '/?project=camara#panel');
  assert.equal(app.deps.registry.get('camara')!.folder, 'Cámara');
  const bob = await f('/folders/add', form({ name: "Bob's app" }));
  assert.equal(bob.status, 400);
  assert.match(await bob.text(), /can&#39;t be used as a project folder/);
  assert.equal(app.deps.registry.list().some((p) => p.name.startsWith('bob')), false, 'no half-made project');
  assert.match(await (await f('/')).text(), /Bob&#39;s app/);
});

test('Continue in Claude Code opens the matched folder, quoted safely', async (t) => {
  const { app, f } = await start(t);
  app.deps.registry.create('pine-lodge', { state: 'open' }, 'owner');
  await app.deps.service.remember({ kind: 'decision', content: 'pine-lodge is the website', project: 'pine-lodge' }, owner);
  report(app, [{ name: 'Pine Lodge' }]);
  assert.match(await (await f('/?project=pine-lodge')).text(), /cd ~\/Projects\/&#39;Pine Lodge&#39; &amp;&amp; claude/);
});

test('a done project still shows not pushed, and git activity counts as the last touch', async (t) => {
  const { app } = await start(t);
  app.deps.registry.create('oldapp', { state: 'open' }, 'owner');
  await app.deps.service.remember({ kind: 'decision', content: 'oldapp was finished long ago', project: 'oldapp' }, owner);
  app.deps.registry.setState('oldapp', 'done', 'owner');
  app.advance(60 * 86_400_000);
  // A commit just now on the app's clock: an hour earlier is yesterday when the suite runs between midnight and 1 am.
  report(app, [{ name: 'oldapp', unpushed: 3 }, { name: 'wildlog', lastCommit: app.deps.now().toISOString() }]);
  const f = await loggedIn(app);
  const body = await (await f('/')).text();
  const done = body.slice(body.indexOf('<summary class="row nolead">Done'));
  assert.match(done, /<span class="prow-name">oldapp<\/span>[\s\S]{0,400}<span class="chip plain">not pushed<\/span>/);
  const wine = body.slice(body.indexOf('<span class="prow-name">wildlog</span>'), body.indexOf('</a>', body.indexOf('<span class="prow-name">wildlog</span>')));
  assert.doesNotMatch(wine, /row-note">quiet/);
  assert.match(wine, /<span class="prow-when">just now<\/span>/);
  assert.doesNotMatch(body, /wildlog has been quiet/);
});

test('an ignored folder that is no longer in the report is listed by its key, since its name is not known any more', async (t) => {
  const { app, f } = await start(t);
  app.deps.devices.ignore('Old_Folder');
  assert.match(await (await f('/')).text(), /old-folder/);
});
