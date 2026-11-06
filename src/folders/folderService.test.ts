import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp } from '../testing/helpers.js';

test('a second folder whose name differs only by case or spaces cannot be added as a project, so the original keeps its folder', async (t) => {
  const app = await startTestApp();
  t.after(() => app.close());
  app.deps.registry.create('pavlova', { state: 'open' }, 'owner');
  app.deps.registry.setInfo('pavlova', { folder: 'Pine Lodge' }, 'owner');
  const { device } = app.deps.devices.create('Mac');
  app.deps.devices.storeReport(device.id, ['Pine Lodge', 'pine-lodge'].map((name) => (
    { name, git: true, branch: 'main', uncommitted: 0, unpushed: 0, lastCommit: null, remotes: [] })) as never);
  const before = app.deps.folders.match();
  assert.equal(before.byProject.get('pavlova')?.name, 'Pine Lodge');
  assert.deepEqual(before.unmatched.map((f) => f.name), ['pine-lodge']);

  assert.throws(() => app.deps.folders.add('pine-lodge'), /same folder as pavlova's “Pine Lodge”/);
  assert.equal(app.deps.registry.get('pine-lodge'), undefined);
  assert.equal(app.deps.folders.match().byProject.get('pavlova')?.name, 'Pine Lodge');
});
