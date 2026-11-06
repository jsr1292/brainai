import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { loggedIn, startTestApp } from '../testing/helpers.js';

async function start(t: TestContext) {
  const app = await startTestApp();
  t.after(() => app.close());
  return { app, f: await loggedIn(app) };
}
const report = (folders: unknown[]) => JSON.stringify({ folders });
const send = (app: { baseUrl: string }, token: string | null, body: string, path = '/api/folder-report') =>
  fetch(`${app.baseUrl}${path}`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/json', ...(token === null ? {} : { authorization: `Bearer ${token}` }) }, body });
const form = (body: Record<string, string>) => ({ method: 'POST', body: new URLSearchParams(body) });

test('a device token sends a report and the brain stores it', async (t) => {
  const { app } = await start(t);
  const { token } = app.deps.devices.create('Mac');
  const res = await send(app, token, report([{ name: 'wildlog', git: true, branch: 'main', uncommitted: 1, unpushed: 2, remotes: [] }]));
  assert.equal(res.status, 204);
  const latest = app.deps.devices.latestReport()!;
  assert.deepEqual(latest.folders.map((f) => [f.name, f.unpushed]), [['wildlog', 2]]);
  assert.equal(latest.device.name, 'Mac');
});

test('a missing, wrong or revoked token gets the same 401, and a device token opens neither /mcp nor an owner page', async (t) => {
  const { app } = await start(t);
  const { device, token } = app.deps.devices.create('Mac');
  const body = report([{ name: 'x', git: false }]);
  const missing = await send(app, null, body);
  const wrong = await send(app, 'brain_dev_wrongwrongwrongwrongwrongwrongwrongwro', body);
  app.deps.devices.revoke(device.id);
  const revoked = await send(app, token, body);
  for (const r of [missing, wrong, revoked]) {
    assert.equal(r.status, 401);
    assert.deepEqual(await r.json(), { error: 'unauthorized' });
  }
  const live = app.deps.devices.create('Mac 2').token;
  const mcp = await fetch(`${app.baseUrl}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${live}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
  assert.equal(mcp.status, 401);
  const settings = await fetch(`${app.baseUrl}/settings`, { headers: { authorization: `Bearer ${live}` }, redirect: 'manual' });
  assert.equal(settings.status, 302);
  assert.equal(app.deps.devices.latestReport(), undefined);
});

test('a bad report answers 400 and keeps the previous report', async (t) => {
  const { app } = await start(t);
  const { token } = app.deps.devices.create('Mac');
  assert.equal((await send(app, token, report([{ name: 'wildlog', git: true }]))).status, 204);
  for (const bad of [report([{ name: 'a/b', git: true }]), report([{ name: 'x', git: true, uncommitted: '3' }]), '{not json', JSON.stringify({ folders: Array.from({ length: 301 }, (_, i) => ({ name: `f${i}`, git: false })) })]) {
    const res = await send(app, token, bad);
    assert.equal(res.status, 400, bad.slice(0, 40));
    assert.ok(typeof (await res.json()).error === 'string');
  }
  assert.deepEqual(app.deps.devices.latestReport()!.folders.map((f) => f.name), ['wildlog']);
});

test('a body over 256 KB answers 413', async (t) => {
  const { app } = await start(t);
  const { token } = app.deps.devices.create('Mac');
  const res = await send(app, token, JSON.stringify({ folders: [], pad: 'x'.repeat(300 * 1024) }));
  assert.equal(res.status, 413);
});

test('Settings lists devices with their last report, adds one showing the token once, and revokes one', async (t) => {
  const { app, f } = await start(t);
  const before = await (await f('/settings')).text();
  assert.match(before, /<section id="devices"[\s\S]*No devices yet\./);
  assert.match(before, /<nav class="settings-nav"[^>]*>[\s\S]*href="#devices">Devices</);
  const added = await f('/settings/devices', form({ name: 'Mac' }));
  // Post, then redirect: reloading the page that shows the token never adds a second device.
  assert.equal(added.status, 303);
  const shown = added.headers.get('location')!;
  assert.match(shown, /^\/settings\?added=[A-Za-z0-9_-]+#devices$/);
  assert.doesNotMatch(shown, /brain_dev_/, 'the token is never in the address');
  const body = await (await f(shown)).text();
  const token = /<code class="token">(brain_dev_[A-Za-z0-9_-]{43})<\/code>/.exec(body)?.[1];
  assert.ok(token, 'the token is shown');
  assert.match(body, /Copy this token now\. It is shown once\./);
  assert.match(body, /scripts\/mac\/install-folder-report\.sh/);
  assert.equal(app.deps.devices.authenticate(token!)!.name, 'Mac');
  const reloaded = await (await f(shown)).text();
  assert.doesNotMatch(reloaded, new RegExp(token!), 'a reload does not show the token again');
  assert.doesNotMatch(reloaded, /<code class="token">/);
  assert.equal(app.deps.devices.list().length, 1, 'and does not mint another');
  const again = await (await f('/settings')).text();
  assert.doesNotMatch(again, new RegExp(token!));
  assert.match(again, /<section id="devices"[\s\S]*Mac[\s\S]*never reported/);
  await send(app, token!, report([{ name: 'wildlog', git: true }]));
  const reported = await (await f('/settings')).text();
  assert.doesNotMatch(reported, /never reported/);
  // Without app.js (or before it runs) the time still says which zone it is in.
  assert.match(reported, /<li>added <time datetime="[^"]+" title="[^"]+">just now<\/time><\/li><li>last report <time datetime="[^"]+" title="[^"]+">just now<\/time><\/li>/);
  const id = app.deps.devices.list()[0]!.id;
  const revoked = await f(`/settings/devices/${id}/revoke`, form({}));
  assert.equal(revoked.status, 303);
  assert.equal(revoked.headers.get('location'), '/settings#devices');
  assert.equal(app.deps.devices.authenticate(token!), undefined);
});

test('the device routes need the owner and refuse another origin', async (t) => {
  const { app } = await start(t);
  const anon = await fetch(`${app.baseUrl}/settings/devices`, { method: 'POST', redirect: 'manual', headers: { origin: app.baseUrl, 'content-type': 'application/x-www-form-urlencoded' }, body: 'name=Evil' });
  assert.equal(anon.status, 302);
  const cross = await fetch(`${app.baseUrl}/settings/devices`, { method: 'POST', redirect: 'manual', headers: { origin: 'https://evil.example', 'content-type': 'application/x-www-form-urlencoded' }, body: 'name=Evil' });
  assert.equal(cross.status, 403);
  assert.deepEqual(app.deps.devices.list(), []);
});

test('a server error while storing a report answers 500, not "not valid JSON"', async (t) => {
  const { app } = await start(t);
  const { token } = app.deps.devices.create('Mac');
  app.deps.devices.storeReport = () => { throw new Error('disk full'); };
  const errors: unknown[] = [];
  const original = console.error;
  console.error = (...a: unknown[]) => { errors.push(a); };
  t.after(() => { console.error = original; });
  const res = await send(app, token, report([{ name: 'x', git: false }]));
  assert.equal(res.status, 500);
});

test('Settings marks a device whose last report is more than a day old', async (t) => {
  const { app, f } = await start(t);
  const { token } = app.deps.devices.create('Mac');
  await send(app, token, report([{ name: 'wildlog', git: true }]));
  assert.doesNotMatch(await (await f('/settings')).text(), /no report for/);
  app.advance(2 * 86_400_000);
  const body = await (await (await loggedIn(app))('/settings')).text();
  assert.match(body, /<section id="devices"[\s\S]*last report <time[^>]*>[^<]*<\/time><\/li><\/ul> <strong class="late-text">no report for 2 days: is the reporter still running\?<\/strong>/);
});

test('a device sending far more reports than the reporter does is slowed down with 429, per device', async (t) => {
  const { app } = await start(t);
  const { token } = app.deps.devices.create('Mac');
  const other = app.deps.devices.create('Mac 2').token;
  const body = report([{ name: 'wildlog', git: true }]);
  for (let i = 0; i < 30; i++) assert.equal((await send(app, token, body)).status, 204, `report ${i + 1}`);
  const limited = await send(app, token, report([{ name: 'flood', git: true }]));
  assert.equal(limited.status, 429);
  assert.match(limited.headers.get('retry-after') ?? '', /^\d+$/);
  assert.ok(typeof (await limited.json()).error === 'string');
  assert.deepEqual(app.deps.devices.latestReport()!.folders.map((f) => f.name), ['wildlog']);
  assert.equal((await send(app, other, body)).status, 204, 'another device is not slowed down');
});

test("the new device's install command carries the brain's own address (O1)", async () => {
  const app = await startTestApp();
  try {
    const f = await loggedIn(app);
    const r = await f('/settings/devices', { method: 'POST', body: new URLSearchParams({ name: 'Mac' }), redirect: 'manual' });
    const body = await (await f(r.headers.get('location')!)).text();
    assert.ok(body.includes(`scripts/mac/install-folder-report.sh --url ${app.deps.publicUrl.origin} <span class="token-arg">TOKEN</span>`), body.slice(body.indexOf('token-once'), body.indexOf('token-once') + 400));
  } finally { await app.close(); }
});
