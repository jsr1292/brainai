import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { loggedIn, startTestApp } from '../testing/helpers.js';

test('each place lights its own tab, and only Settings lights Settings', async (t: TestContext) => {
  const app = await startTestApp();
  t.after(() => app.close());
  const f = await loggedIn(app);
  const fact = (await app.deps.service.remember({ kind: 'decision', content: 'wildlog uses SwiftUI', project: 'wildlog', newProject: true }, { type: 'owner' }) as any).memory;
  const profile = (await app.deps.service.remember({ kind: 'profile', content: 'I prefer short answers' }, { type: 'owner' }) as any).memory;
  const pageRecord = await app.deps.pages.create({ title: 'Wine cellar', area: 'apps', project: 'wildlog', body: 'A page.' }, 'owner');
  const discussion = app.deps.discussions.open({ name: 'Claude Code', model: 'opus', access: 'full' }, { title: 'Which icon?', question: 'Which icon?', ask: ['Grok'] });
  for (const [path, expected] of [
    ['/', 'Projects'], ['/?project=wildlog', 'Projects'], ['/discussions', 'Projects'], [`/discussions/${discussion.id}`, 'Projects'],
    ['/pages', 'Pages'], ['/facts', 'Pages'], ['/facts?kind=profile', 'Pages'], ['/facts?project=wildlog', 'Pages'], ['/facts/tidy', 'Pages'], ['/memories/new', 'Pages'], [`/memories/${fact.id}`, 'Projects'], [`/memories/${profile.id}`, 'Pages'], [`/pages/${pageRecord.id}`, 'Pages'], ['/pages/new', 'Pages'],
    ['/review', 'Week'], ['/review/now', 'Week'], ['/review/all', 'Week'], ['/growth', 'Week'],
    ['/graph', 'Graph'], ['/settings', 'Settings'], ['/search?q=wine', null],
  ] as const) {
    const response = await f(path);
    assert.equal(response.status, 200, path);
    const header = (await response.text()).split('</header>')[0]!;
    const current = [...header.matchAll(/<a[^>]*aria-current="page"[^>]*>(?:<span class="settings-word">)?([^<]*)/g)].map((m) => m[1]);
    assert.deepEqual(current, expected === null ? [] : [expected], path);
  }
});
