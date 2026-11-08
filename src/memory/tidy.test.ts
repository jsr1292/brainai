import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeService } from '../testing/helpers.js';
import { keepStatuses, projectOverlaps, statusGroups } from './tidy.js';
import type { Kind } from './types.js';

const owner = { type: 'owner' } as const;

function setup() {
  let t = Date.parse('2026-10-01T10:00:00Z');
  const ctx = makeService({ now: () => new Date(t) });
  const add = async (kind: Kind, content: string, project: string, tags: string[] = []) => {
    t += 60_000;
    const r = await ctx.service.remember({ kind, content, project, tags }, owner);
    assert.equal(r.status, 'saved');
    return (r as { memory: { id: string; updatedAt: string } }).memory;
  };
  return { ...ctx, add, later: (ms: number) => { t += ms; } };
}

test('projects with more than one status are listed with their statuses newest first', async () => {
  const { store, add } = setup();
  const old = await add('summary', 'brainai session: connected Claude', 'brainai');
  const tagged = await add('decision', 'brainai status: Grok connected', 'brainai', ['status']);
  await add('decision', 'brainai uses OAuth only', 'brainai');
  await add('summary', 'wildlog status: v0.2 released', 'wildlog');

  assert.deepEqual(statusGroups(store).map((g) => ({ project: g.project, ids: g.statuses.map((m) => m.id) })),
    [{ project: 'brainai', ids: [tagged.id, old.id] }]);
});

test('"all still current" hides a project\'s statuses until a new status arrives', async () => {
  const { store, add } = setup();
  await add('summary', 'casa status: reservations closed', 'casa');
  await add('summary', 'casa rules fixed by the committee', 'casa');
  keepStatuses(store, 'casa');
  assert.deepEqual(statusGroups(store), []);

  await add('summary', 'casa status: results published', 'casa');
  assert.equal(statusGroups(store)[0]!.statuses.length, 3);
});

test('a project whose memories match another project\'s closely is offered as the same project', async () => {
  const { store, add } = setup();
  await add('decision', 'Dossier app plays mkv video files in the player', 'dossier-app');
  await add('decision', 'Dossier app signs PDFs with the signing certificate', 'dossier-app');
  await add('summary', 'Dossier app plays mkv video files in the player now', 'dossiers');
  await add('decision', 'Bramble is a wine cellar app for the club', 'wildlog');

  const overlaps = projectOverlaps(store);
  assert.equal(overlaps.length, 1);
  assert.deepEqual(overlaps[0]!.smaller, { project: 'dossiers', count: 1 });
  assert.deepEqual(overlaps[0]!.larger, { project: 'dossier-app', count: 2 });
  assert.ok(overlaps[0]!.similarity > 0.88 && overlaps[0]!.similarity <= 1);
});

test('"different projects" hides the pair for good', async () => {
  const { store, add } = setup();
  await add('decision', 'CSV merge tool for seed catalogues', 'seedsheet');
  await add('decision', 'CSV merge tool for seed catalogues v1', 'csvmerge');
  assert.equal(projectOverlaps(store).length, 1);
  store.dismissProjects('seedsheet', 'csvmerge');
  assert.deepEqual(projectOverlaps(store), []);
  assert.equal(store.isProjectPairDismissed('csvmerge', 'seedsheet'), true);
});

test('moving a project renames it on every active memory, records history and keeps the dates', async () => {
  const { service, store, add, later } = setup();
  const a = await add('summary', 'Dossier task 7 done', 'dossiers');
  const b = await add('decision', 'Dossier plays ogg', 'dossiers');
  const gone = await add('decision', 'Dossier dropped idea', 'dossiers');
  service.forget(gone.id, owner);
  await add('decision', 'Dossier signs PDFs', 'dossier-app');
  later(60_000);

  assert.equal(service.moveProject('dossiers', 'dossier-app', owner), 2);
  assert.equal(store.get(a.id)!.project, 'dossier-app');
  assert.equal(store.get(b.id)!.project, 'dossier-app');
  assert.equal(store.get(a.id)!.updatedAt, a.updatedAt);
  assert.equal(store.get(gone.id)!.project, 'dossiers');
  const h = store.history(a.id)[0]!;
  assert.equal(h.action, 'update');
  assert.equal(h.project, 'dossiers');
  assert.equal(h.changedBy, 'owner');
  assert.deepEqual(service.listProjects(), [{ project: 'dossier-app', count: 3, aliases: ['dossiers'] }]);
  assert.equal((await service.recall({ query: 'ogg', project: 'dossier-app' })).length, 1);
});

test('moving a project checks both names', async () => {
  const { service, add } = setup();
  await add('decision', 'Dossier plays ogg', 'dossiers');
  assert.throws(() => service.moveProject('dossiers', 'dossiers', owner), (e: any) => e.code === 'invalid');
  assert.throws(() => service.moveProject('dossiers', 'Not Valid', owner), (e: any) => e.code === 'invalid');
  assert.throws(() => service.moveProject('nothing-here', 'dossier-app', owner), (e: any) => e.code === 'not_found');
});

test('cli aliases add / list / remove', async () => {
  const { COMMANDS } = await import('../cli.js');
  const { OwnerAuth } = await import('../auth/owner.js');
  const { db, store, service } = makeService();
  await service.remember({ kind: 'decision', content: 'Coyote uses Jellyfin', project: 'coyote' }, { type: 'owner' });
  await service.remember({ kind: 'decision', content: 'Coyote is in the inflow repo', project: 'inflow' }, { type: 'owner' });
  const ctx = (args: string[]) => ({ db, owner: new OwnerAuth(db, () => new Date()), args });
  const logged: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => { logged.push(a.join(' ')); };
  try {
    await COMMANDS.aliases(ctx(['add', 'coyote', 'inflow']));
    await COMMANDS.aliases(ctx(['list']));
  } finally {
    console.log = orig;
  }
  assert.deepEqual(logged, ['coyote is now another name of inflow (1 memory moved).', 'coyote -> inflow']);
  assert.equal(store.list({ project: 'inflow' }).length, 2);
  await COMMANDS.aliases(ctx(['remove', 'coyote']));
  assert.deepEqual(store.aliases(), []);
  await assert.rejects(COMMANDS.aliases(ctx(['remove', 'coyote'])));
  await assert.rejects(COMMANDS.aliases(ctx([])));
});
