import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { loggedIn, startTestApp } from '../testing/helpers.js';

/** An empty brain says so once on every screen. */
async function start(t: TestContext, opts: Parameters<typeof startTestApp>[0] = {}) {
  const app = await startTestApp(opts);
  t.after(() => app.close());
  return { app, f: await loggedIn(app) };
}

test('an empty brain looks right', async (t) => {
  // A brain with nothing in it: every place says so once, and nothing counts zero.
  const empty = await start(t);
  for (const [path, sentence] of [
    ['/', /No projects yet\./],
    ['/pages', /No pages yet\./],
    ['/facts', /No facts yet\./],
    ['/discussions', /No discussions yet\. Ask an assistant to open one when you want several opinions\./],
    ['/approvals', /Nothing waits for you\. Suggestions from assistants, facts that disagree, possible tidy-ups and discussions that need your answer land here\./],
    ['/review', /There is no finished week yet\./],
    ['/review/now', /No changes yet this week\./],
    ['/growth', /Nothing yet\. Assistants add an entry/],
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
