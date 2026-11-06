import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connectClient, loggedIn, startTestApp } from '../testing/helpers.js';

test('a brand-new brain points to the first step: connect an assistant; once one is connected, it no longer does', async (t) => {
  const app = await startTestApp();
  t.after(() => app.close());
  const f = await loggedIn(app);
  const first = await (await f('/')).text();
  assert.match(first, /No projects yet\./);
  assert.match(first, /<a class="button" href="\/settings#setup">Connect your first assistant<\/a>/);
  await connectClient(app.baseUrl, f, 'Claude Code');
  const after = await (await f('/')).text();
  assert.match(after, /No projects yet\. They appear here as soon as an assistant saves something about one\./);
  assert.doesNotMatch(after, /Connect your first assistant/);
});
