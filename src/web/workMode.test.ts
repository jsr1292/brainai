import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { loggedIn, startTestApp } from '../testing/helpers.js';

/** Work mode trims the personal parts; an empty personal brain says so once on every screen. */
async function start(t: TestContext, opts: Parameters<typeof startTestApp>[0] = {}) {
  const app = await startTestApp(opts);
  t.after(() => app.close());
  return { app, f: await loggedIn(app) };
}

test('work mode and an empty brain look right', async (t) => {
  // Work mode: no This-device section, no Growth anywhere, no For-you card on Projects.
  const work = await start(t, { mode: 'work' });
  const settings = await (await work.f('/settings')).text();
  assert.deepEqual([...settings.matchAll(/<section id="([a-z-]+)"/g)].map((m) => m[1]!), ['connections', 'devices', 'health', 'login']);
  assert.doesNotMatch(await (await work.f('/review')).text(), /href="\/growth"/);
  assert.equal((await work.f('/growth')).status, 404);
  assert.doesNotMatch(await (await work.f('/')).text(), /class="group foryou"/);

  // A personal brain with nothing in it: every place says so once, and nothing counts zero.
  const empty = await start(t);
  for (const [path, sentence] of [
    ['/', /No projects yet\./],
    ['/pages', /No pages yet\./],
    ['/facts', /No facts yet\./],
    ['/discussions', /No discussions yet\. Ask an assistant to open one when you want several opinions\./],
    ['/approvals', /Nothing waits for your approval\./],
    ['/review', /There is no finished week yet\./],
    ['/review/now', /No changes yet this week\./],
    ['/growth', /Nothing noticed yet\./],
  ] as const) {
    const res = await empty.f(path);
    assert.equal(res.status, 200, path);
    const body = await res.text();
    assert.match(body, sentence, path);
    assert.doesNotMatch(body, />0</, path);
  }
  // The empty review ends by pointing at this week so far.
  const review = await (await empty.f('/review')).text();
  assert.match(review, /There is no finished week yet\.<\/p>\s*<p class="also"><a href="\/review\/now">This week so far<\/a><\/p>/);
});
