/* B1: Brain health says which connected app read the memory a lot this week and saved nothing, computed when Settings renders. */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { quietAppsBlock } from './healthViews.js';
import { loggedIn, startTestApp } from '../testing/helpers.js';

async function start(t: TestContext) {
  const app = await startTestApp();
  t.after(() => app.close());
  return { app, f: await loggedIn(app) };
}
const log = (app: Awaited<ReturnType<typeof start>>['app'], client: string, tool: string, n: number) => { for (let i = 0; i < n; i++) app.deps.store.logToolCall(client, tool); };

test('a connected app with 40 reads and no saves gets the line; one that saved, or is not connected, does not', async (t) => {
  const { app, f } = await start(t);
  const { provider } = app.deps;
  provider.issueLocalGrant({ name: 'Codex', clientName: 'Codex' });
  provider.issueLocalGrant({ name: 'Grok', clientName: 'Grok' });
  log(app, 'Codex', 'recall', 30); log(app, 'Codex', 'project_brief', 10);
  log(app, 'Grok', 'recall', 50); log(app, 'Grok', 'suggest_memories', 1);
  log(app, 'Gone app', 'recall', 90);
  const body = await (await f('/settings')).text();
  assert.match(body, /Codex used your memory 40 times this week but saved nothing\. Its tool may not be reminding it: set up its save reminders/);
  assert.doesNotMatch(body, /Grok used your memory/);
  assert.doesNotMatch(body, /Gone app used/);
});

test('on this computer the line points at Tools on this computer', () => {
  const v = quietAppsBlock([{ app: 'Codex', reads: 40 }], true)!.value;
  assert.match(v, /Codex used your memory 40 times this week but saved nothing\. Its tool may not be reminding it: see <a href="\/settings\/tools">Tools on this computer<\/a>\./);
  assert.equal(quietAppsBlock([], true), null);
});

test('calls older than a week do not count, and nothing is said when no app is quiet', async (t) => {
  const { app, f } = await start(t);
  app.deps.provider.issueLocalGrant({ name: 'Codex', clientName: 'Codex' });
  log(app, 'Codex', 'recall', 30);
  app.advance(8 * 86_400_000);
  assert.doesNotMatch(await (await f('/settings')).text(), /used your memory/);
});

test('an app without hook support is told to save as it works or run the harvest-session skill, not pointed to Tools', () => {
  for (const name of ['Grok Build', 'OpenCode', 'Claude']) {
    for (const local of [true, false]) {
      const v = quietAppsBlock([{ app: name, reads: 24 }], local)!.value;
      assert.match(v, /ask it to save as it works, or to run the harvest-session skill\./);
      assert.doesNotMatch(v, /settings\/tools|Tools on this computer|docs\/CLIENTS/);
    }
  }
  assert.match(quietAppsBlock([{ app: 'Claude Code', reads: 24 }], true)!.value, /Tools on this computer/);
});
