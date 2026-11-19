/** Remove BrainAI from this computer: the server side of the app's removal. */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { connect } from '../desktop/tools.js';
import { installHooks } from '../desktop/hooksInstall.js';
import { prepareTunnel, startSignIn } from '../desktop/cloudflared.js';
import { fakeCloudflared } from '../testing/fakeCloudflared.js';
import { fakeTailscale } from '../testing/fakeTailscale.js';
import { fakeHome } from '../testing/fakeTools.js';
import { loggedIn, startTestApp } from '../testing/helpers.js';
import { toolEnv } from './desktopRoutes.js';
import { removeSeams } from './removeRoutes.js';
import { decodeEntities, withoutClientCatalog } from '../testing/entities.js';

const FORM = { 'Content-Type': 'application/x-www-form-urlencoded' };
const PUBLIC = 'https://brainai-mac.tail1234.ts.net';

const KEY = 'k'.repeat(40);

async function desktop(t: TestContext, o: { platform?: NodeJS.Platform; extraPath?: string; tools?: Parameters<typeof fakeHome>[0] } = {}) {
  const home = fakeHome(o.tools);
  const statusDir = mkdtempSync(join(tmpdir(), 'brainai-remove-data-'));
  const path = `${home.bin}:${o.extraPath ? `${o.extraPath}:` : ''}${dirname(process.execPath)}:/usr/bin:/bin`;
  const app = await startTestApp({ localMode: true, appSecret: KEY, statusDir, tools: { home: home.home, path, apps: home.apps, platform: o.platform ?? 'linux' } });
  t.after(() => { app.close(); home.cleanup(); });
  const shown: string[] = [];
  app.deps.reveal = (p) => { shown.push(p); };
  return { app, home, statusDir, shown, f: await loggedIn(app), env: toolEnv(app.deps)! };
}
const savedFolders = (home: string) => readdirSync(join(home, 'Documents')).filter((n) => n.startsWith('BrainAI saved '));
/** The done page as text, with HTML's escaped apostrophes put back. */
const doneText = async (f: Awaited<ReturnType<typeof loggedIn>>) => decodeEntities((await (await f('/settings/remove/done')).text()));
const post = (f: Awaited<ReturnType<typeof loggedIn>>, body = 'where=documents') => f('/settings/remove', { method: 'POST', headers: FORM, body });

test('the page says what will happen and offers the same where-choice as Save a copy', async (t) => {
  const { f, home } = await desktop(t, { platform: 'darwin' });
  assert.match(await (await f('/settings')).text(), /href="\/settings\/remove"[\s\S]*Remove BrainAI from/);
  const page = await (await f('/settings/remove')).text();
  assert.match(page, /What happens, in this order/);
  assert.match(page, /action="\/settings\/remove"/);
  assert.match(page, />Save a copy and start removing</);
  assert.match(page, /Your tools are disconnected next\. Your memories stay until you press Finish on the last page\./);
  assert.doesNotMatch(page, /Save to Documents/);
  assert.match(page, /A saved copy of every memory and page is made in your Documents folder\./);
  mkdirSync(join(home.home, 'Library/Mobile Documents/com~apple~CloudDocs/Documents'), { recursive: true });
  assert.match(await (await f('/settings/remove')).text(), /Save a copy to my home folder and start removing/);
  assert.match(await (await f('/settings/remove')).text(), /A saved copy of every memory and page is made in the folder you choose below: your Documents folder or your home folder\./);
});

test('the page says the data folder and the app go, and only the saved copy is kept', async (t) => {
  const { f } = await desktop(t, { platform: 'darwin' });
  const page = decodeEntities((await (await f('/settings/remove')).text()));
  const kept = page.slice(page.indexOf('<h2>What is kept</h2>'));
  assert.match(kept, /Only the saved copy/);
  assert.match(page, /deletes its data folder \(memories, backups, logs and settings\) and removes the app/);
  assert.doesNotMatch(page, /data folder[^<]*(stays|is kept)|and BrainAI's data folder|stays in Applications|drag it to the Trash/);
  assert.match(page, /folder report on this Mac/);
});

test('on Windows the page never says Mac', async (t) => {
  const { f } = await desktop(t, { platform: 'win32' });
  const page = await (await f('/settings/remove')).text();
  assert.match(page, /Remove BrainAI from this computer/);
  assert.doesNotMatch(withoutClientCatalog(page), /Mac|Applications|Trash|folder report/);
});

test('remove saves first and stops if saving fails', async (t) => {
  const { f, home, env } = await desktop(t);
  home.write('.claude/CLAUDE.md', '# Mine\n');
  home.write('.codex/AGENTS.md', 'Be kind.\n');
  assert.equal((await connect('claude-code', env, {})).ok, true);
  assert.equal((await connect('codex', env, {})).ok, true);
  writeFileSync(join(home.home, 'Documents'), 'not a folder');
  const r = await post(f);
  assert.equal(r.status, 500);
  assert.match(await r.text(), /Nothing was removed: /);
  assert.deepEqual(Object.keys(home.servers('claude')), ['brainai'], 'still connected');
  assert.deepEqual(Object.keys(home.servers('codex')), ['brainai']);
  assert.ok(existsSync(join(home.home, '.claude/CLAUDE.md.brainai-backup')), 'the backup is still beside the tool settings');
  assert.ok(existsSync(join(home.home, '.codex/AGENTS.md.brainai-backup')));
  assert.ok(!existsSync(join(home.home, 'Documents', 'BrainAI saved')), 'nothing was moved');
  assert.deepEqual(home.calls().filter((c) => / remove /.test(c)), []);
});

test('remove disconnects tools and moves their backups', async (t) => {
  const { f, home, env, shown } = await desktop(t);
  home.write('.claude/CLAUDE.md', '# My own rules\n');
  home.write('.codex/AGENTS.md', 'Be kind.\n');
  assert.equal((await connect('claude-code', env, {})).ok, true);
  assert.equal((await connect('codex', env, {})).ok, true);
  assert.ok(existsSync(join(home.home, '.claude/CLAUDE.md.brainai-backup')));
  const r = await post(f);
  assert.equal(r.status, 303);
  assert.equal(r.headers.get('location'), '/settings/remove/done');
  assert.deepEqual(home.servers('claude'), {});
  assert.deepEqual(home.servers('codex'), {});
  assert.equal(home.read('.claude/CLAUDE.md'), '# My own rules\n');
  const folders = savedFolders(home.home);
  assert.equal(folders.length, 1);
  const folder = join(home.home, 'Documents', folders[0]!);
  const orig = join(folder, 'Original tool settings');
  assert.equal(readFileSync(join(orig, '.claude/CLAUDE.md.brainai-backup'), 'utf8'), '# My own rules\n');
  assert.ok(existsSync(join(orig, '.codex/AGENTS.md.brainai-backup')));
  assert.equal(existsSync(join(home.home, '.claude/CLAUDE.md.brainai-backup')), false, 'moved, not copied');
  assert.equal(existsSync(join(home.home, '.codex/AGENTS.md.brainai-backup')), false);
  const readme = readFileSync(join(folder, 'README.txt'), 'utf8');
  assert.match(readme, /Original tool settings\/\.claude\/CLAUDE\.md\.brainai-backup/);
  assert.match(readme, /Things BrainAI could not remove:/);
  const done = await doneText(f);
  assert.match(done, /Claude Code: disconnected/);
  assert.match(done, /Codex: disconnected/);
  assert.match(done, new RegExp(folder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(done, /Show in Finder/);
  await f('/settings/remove/show', { method: 'POST', headers: FORM, body: '' });
  assert.deepEqual(shown, [folder]);
});

test('Remove takes back save reminders left in a tool that is no longer connected, and never copies the settings.json backup into the saved folder', async (t) => {
  const { f, home, env } = await desktop(t, { tools: ['claude', 'codex'] });
  const built = mkdtempSync(join(tmpdir(), 'brainai-hooks-'));
  for (const n of ['memoryStart.js', 'memorySave.js', 'memoryNudge.js']) writeFileSync(join(built, n), '//\n');
  const withHooks = { ...env, hooksDir: built };
  home.write('.claude/settings.json', JSON.stringify({ env: { TOKEN: 'sekret' }, theme: 'dark' }));
  assert.equal(installHooks('claude-code', withHooks), null);
  installHooks('codex', withHooks); // Codex has the reminders but no brainai server entry: its traces are 'no'
  assert.ok(existsSync(join(home.home, '.claude/settings.json.brainai-backup')));
  assert.ok(existsSync(join(home.home, '.brainai/hooks/memory-nudge.mjs')));
  assert.equal((await post(f)).status, 303);
  assert.equal(existsSync(join(home.home, '.codex/hooks.json')), false, 'created by BrainAI, now empty: deleted');
  assert.equal(existsSync(join(home.home, '.brainai/hooks/memory-nudge.mjs')), false);
  assert.deepEqual(JSON.parse(home.read('.claude/settings.json')!), { env: { TOKEN: 'sekret' }, theme: 'dark' });
  assert.equal(existsSync(join(home.home, '.claude/settings.json.brainai-backup')), false, 'deleted, not left behind');
  const folder = join(home.home, 'Documents', savedFolders(home.home)[0]!);
  const all = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? all(join(dir, e.name)) : [join(dir, e.name)]));
  assert.deepEqual(all(folder).filter((p) => p.includes('settings.json')), []);
  assert.match(readFileSync(join(folder, 'README.txt'), 'utf8'), /Not copied into this folder[\s\S]*settings\.json/);
});

test('a tool that fails to disconnect is named on the done page and in the README', async (t) => {
  const { f, home, env } = await desktop(t);
  assert.equal((await connect('claude-code', env, {})).ok, true);
  chmodSync(join(home.home, '.claude/CLAUDE.md'), 0o444);
  assert.equal((await post(f)).status, 303);
  const done = await doneText(f);
  assert.match(done, /Claude Code: failed: BrainAI could not write/);
  assert.match(done, /Still to do by hand/);
  const folder = join(home.home, 'Documents', savedFolders(home.home)[0]!);
  assert.match(readFileSync(join(folder, 'README.txt'), 'utf8'), /Claude Code: BrainAI could not write/);
});

test("a config BrainAI cannot read is reported as not checked, with removal wording, never 'add it'", async (t) => {
  const { f, home } = await desktop(t);
  home.write('.config/opencode/opencode.jsonc', '{ // comments\n}');
  assert.equal((await post(f)).status, 303);
  const done = await doneText(f);
  assert.match(done, /OpenCode: BrainAI couldn't read its settings; if it has a brainai entry for localhost:\d+, remove it by hand\./);
  assert.doesNotMatch(done, /add it/i);
  assert.doesNotMatch(done, /OpenCode: failed/);
  const folder = join(home.home, 'Documents', savedFolders(home.home)[0]!);
  const readme = readFileSync(join(folder, 'README.txt'), 'utf8');
  assert.match(readme, /OpenCode: BrainAI couldn't read its settings/);
  assert.doesNotMatch(readme, /add it/i);
});

test('a step that throws after the save becomes a line in the result; the done page and the final README still come', async (t) => {
  removeSeams.moveIntoSaved = () => { throw new Error('disk said no'); };
  t.after(() => { delete removeSeams.moveIntoSaved; });
  const { f, home, env } = await desktop(t);
  assert.equal((await connect('codex', env, {})).ok, true);
  const r = await post(f);
  assert.equal(r.status, 303);
  const done = await doneText(f);
  assert.match(done, /failed: the tools' original settings, disk said no/i);
  assert.deepEqual(home.servers('codex'), {}, 'the steps before it were done');
  const folder = join(home.home, 'Documents', savedFolders(home.home)[0]!);
  assert.match(readFileSync(join(folder, 'README.txt'), 'utf8'), /disk said no/);
});

test('two submits at once make one saved folder', async (t) => {
  const { f, home } = await desktop(t);
  const [a, b] = await Promise.all([post(f), post(f)]);
  assert.equal(a.status, 303);
  assert.equal(b.status, 303);
  assert.equal(savedFolders(home.home).length, 1);
});

test('hooks stay when Claude Code is not on this computer: nobody could say no brain uses them', async (t) => {
  const { f, home } = await desktop(t, { tools: ['codex'] });
  home.write('.claude/hooks/memory-start.mjs', '// start');
  home.write('.claude/hooks/memory-save.mjs', '// save');
  assert.equal((await post(f)).status, 303);
  assert.equal(home.read('.claude/hooks/memory-start.mjs'), '// start');
  assert.match(await doneText(f), /Claude Code's BrainAI hooks were left in place: BrainAI couldn't confirm no other brain uses them/);
});

test('hooks stay when ~/.claude.json has a brain under any project, even if claude says there is none', async (t) => {
  const { f, home } = await desktop(t);
  home.write('.claude/hooks/memory-start.mjs', '// start');
  home.write('.claude.json', JSON.stringify({ mcpServers: {}, projects: { '/work/larder': { mcpServers: { memory: { url: 'https://memory.example.com/mcp' } } } } }));
  assert.equal((await post(f)).status, 303);
  assert.equal(home.read('.claude/hooks/memory-start.mjs'), '// start');
});

test('a tool on another brain is left alone', async (t) => {
  const { f, home, env } = await desktop(t);
  assert.equal((await connect('claude-code', env, {})).ok, true);
  const elsewhere = JSON.stringify({ mcp: { brainai: { type: 'remote', url: 'https://memory.example.com/mcp', enabled: true } } }, null, 2);
  home.write('.config/opencode/opencode.json', elsewhere);
  assert.equal((await post(f)).status, 303);
  assert.equal(home.read('.config/opencode/opencode.json'), elsewhere);
  assert.equal(home.read('.config/opencode/opencode.json.brainai-backup'), null);
  const done = await doneText(f);
  assert.match(done, /OpenCode: left alone because it uses another brain/);
  assert.match(done, /Claude Code: disconnected/);
  assert.deepEqual(home.servers('claude'), {});
});

test("Remove leaves another BrainAI's entry in Claude's desktop app alone, but revokes and deletes our own leftover key", async (t) => {
  const { app, f, home, statusDir, env } = await desktop(t);
  const config = env.claudeConfig!;
  const other = join(home.home, 'other-cli.js');
  writeFileSync(other, '');
  const theirs = JSON.stringify({ mcpServers: { brainai: { command: process.execPath, args: [other, 'claude-bridge'], env: { BRAINAI_DATA_DIR: join(home.home, 'elsewhere') } } } });
  mkdirSync(dirname(config), { recursive: true });
  writeFileSync(config, theirs);
  const grant = app.deps.provider.issueLocalGrant({ name: 'Claude (desktop app)', clientName: 'Claude (desktop app)' });
  const keyFile = join(statusDir, 'claude-desktop-key');
  writeFileSync(keyFile, JSON.stringify({ grant: grant.grantId, token: grant.token }));
  assert.equal((await post(f)).status, 303);
  assert.equal(readFileSync(config, 'utf8'), theirs);
  assert.equal(existsSync(keyFile), false);
  assert.ok(app.deps.provider.listGrants().find((g) => g.id === grant.grantId)?.revokedAt, 'the grant is revoked');
});

test('a tool with only the rules block, left by an earlier Disconnect that failed, is cleaned too', async (t) => {
  const { f, home, env } = await desktop(t);
  assert.equal((await connect('claude-code', env, {})).ok, true);
  home.write('.fake-claude.json', '{}');
  assert.match(home.read('.claude/CLAUDE.md')!, /brainai|BrainAI|memory/i);
  assert.equal((await post(f)).status, 303);
  assert.doesNotMatch(home.read('.claude/CLAUDE.md') ?? '', /localhost/);
  assert.match(await doneText(f), /Claude Code: disconnected/);
});

test("Claude Code's hooks go when no brain is left there, and stay while one is", async (t) => {
  const hooks = (home: ReturnType<typeof fakeHome>) => {
    home.write('.claude/hooks/memory-start.mjs', '// start');
    home.write('.claude/hooks/memory-save.mjs', '// save');
    home.write('.claude/settings.json', JSON.stringify({ hooks: { Stop: [{ hooks: [{ command: 'node ~/.claude/hooks/memory-save.mjs' }] }] } }));
  };
  const a = await desktop(t);
  hooks(a.home);
  assert.equal((await connect('claude-code', a.env, {})).ok, true);
  await post(a.f);
  assert.equal(a.home.read('.claude/hooks/memory-start.mjs'), null);
  assert.deepEqual(JSON.parse(a.home.read('.claude/settings.json')!), {});
  const b = await desktop(t);
  hooks(b.home);
  b.home.write('.fake-claude.json', JSON.stringify({ memory: 'https://memory.example.com/mcp' }));
  await post(b.f);
  assert.equal(b.home.read('.claude/hooks/memory-start.mjs'), '// start');
  assert.match(await doneText(b.f), /hooks were left in place/);
});

test('the folder report that points at this app is removed (launchctl stood in); one at another brain stays', async (t) => {
  const calls: string[][] = [];
  removeSeams.launchctl = (a) => { calls.push(a); };
  t.after(() => { delete removeSeams.launchctl; });
  const plist = (home: string, url: string) => {
    mkdirSync(join(home, 'Library/LaunchAgents'), { recursive: true });
    writeFileSync(join(home, 'Library/LaunchAgents/org.brain.folder-report.plist'), `<key>BRAIN_URL</key><string>${url}</string>`);
  };
  const a = await desktop(t, { platform: 'darwin' });
  plist(a.home.home, a.app.deps.publicUrl.origin);
  await post(a.f);
  assert.equal(existsSync(join(a.home.home, 'Library/LaunchAgents/org.brain.folder-report.plist')), false);
  assert.equal(calls.length, 1);
  const b = await desktop(t, { platform: 'darwin' });
  plist(b.home.home, 'https://memory.example.com');
  await post(b.f);
  assert.ok(existsSync(join(b.home.home, 'Library/LaunchAgents/org.brain.folder-report.plist')));
  assert.equal(calls.length, 1);
  assert.match(await doneText(b.f), /folder report[\s\S]*another brain/);
});

test('Reach is turned off and a Cloudflare tunnel is deleted, its name left for the checklist', async (t) => {
  const cf = fakeCloudflared({});
  t.after(() => cf.cleanup());
  const { app, f, statusDir, home } = await desktop(t, { extraPath: cf.bin });
  app.deps.tools!.extraEnv = cf.extraEnv;
  const env = { home: cf.home, path: `${cf.bin}:${dirname(process.execPath)}:/usr/bin:/bin` };
  assert.equal((await startSignIn(env).done).ok, true);
  const p = await prepareTunnel(env, statusDir, 'brain.example.net');
  assert.equal(p.ok, true);
  const port = await app.deps.door!.open();
  app.deps.reach!.set(new URL('https://brain.example.net'), port, { via: 'cloudflare' });
  assert.equal((await post(f)).status, 303);
  assert.equal(app.deps.reach!.saved(), null);
  assert.ok(cf.calls().some((c) => / delete -f /.test(c)), cf.calls().join('\n'));
  const done = await doneText(f);
  assert.match(done, /the name brain\.example\.net still exists/);
  const folder = join(home.home, 'Documents', savedFolders(home.home)[0]!);
  assert.match(readFileSync(join(folder, 'README.txt'), 'utf8'), /brain\.example\.net/);
});

test('Remove with Reach never turned on never runs Tailscale: its funnel command opens a browser page on a tailnet without Funnel', async (t) => {
  const ts = fakeTailscale({ backend: 'Running', needsApproval: true });
  t.after(() => ts.cleanup());
  const { f, home } = await desktop(t, { extraPath: ts.bin });
  // The fake logs to and reads from the HOME it is run with: the tools' home.
  writeFileSync(join(home.home, 'tailscale.json'), JSON.stringify({ backend: 'Running', needsApproval: true }));
  assert.equal((await post(f)).status, 303);
  assert.equal(savedFolders(home.home).length, 1);
  const log = join(home.home, 'tailscale.log');
  assert.deepEqual(existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [], []);
});

test('through the public door /settings/remove is 404', async (t) => {
  const { app, home, f } = await desktop(t);
  const port = await app.deps.door!.open();
  app.deps.reach!.set(new URL(PUBLIC), port);
  const viaDoor = (method: string, path: string) => new Promise<number>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method, setHost: false, headers: { Host: new URL(PUBLIC).host, Origin: PUBLIC, ...FORM } }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
    req.on('error', reject);
    req.end();
  });
  for (const [m, p] of [['GET', '/settings/remove'], ['POST', '/settings/remove'], ['GET', '/settings/remove/done'], ['POST', '/settings/remove/show'], ['GET', '/app/removed']] as const) {
    assert.equal(await viaDoor(m, p), 404, `${m} ${p}`);
  }
  assert.equal(existsSync(join(home.home, 'Documents')), false, 'nothing was saved');
  assert.equal((await f('/app/removed')).status, 200);
});

test('the done page links to /app/removed, which answers a plain page', async (t) => {
  const { f } = await desktop(t);
  assert.equal((await f('/settings/remove/done', { redirect: 'manual' })).status, 303, 'nothing done yet');
  await post(f);
  const done = await doneText(f);
  assert.match(done, /<a class="primary button" href="\/app\/removed">Finish removing BrainAI<\/a>/);
  const finishing = await f('/app/removed');
  assert.equal(finishing.status, 200);
  const text = await finishing.text();
  assert.match(text, /BrainAI is finishing/);
  assert.match(text, /deleting its data folder and removing itself/);
  assert.doesNotMatch(text, /Trash/, 'the same words on the Mac and on Windows');
});

/** The app's own call before it deletes anything: GET /app/removed/ready with its key, no cookie. */
const ready = (baseUrl: string, key: string | null) => fetch(`${baseUrl}/app/removed/ready`, { headers: key === null ? {} : { 'X-App-Key': key } });

test('/app/removed/ready answers the saved folder only after a removal, and only to the app', async (t) => {
  const { app, f, home } = await desktop(t);
  const before = await ready(app.baseUrl, KEY);
  assert.equal(before.status, 409, 'no removal yet: the app must not delete anything');
  assert.equal((await post(f)).status, 303);
  const after = await ready(app.baseUrl, KEY);
  assert.equal(after.status, 200);
  const folder = join(home.home, 'Documents', savedFolders(home.home)[0]!);
  assert.deepEqual(await after.json(), { folder });
  for (const key of [null, '', 'x'.repeat(40)]) {
    const r = await ready(app.baseUrl, key);
    assert.equal(r.status, 404, `key ${key}`);
    assert.doesNotMatch(await r.text(), /Documents/);
  }
  // A cookie is not the key: a page in the window cannot ask.
  assert.equal((await f('/app/removed/ready')).status, 404);
});

test('/app/removed/ready is 404 through the public door, even with the key', async (t) => {
  const { app, f } = await desktop(t);
  assert.equal((await post(f)).status, 303);
  const port = await app.deps.door!.open();
  app.deps.reach!.set(new URL(PUBLIC), port);
  const status = await new Promise<number>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: '/app/removed/ready', method: 'GET', setHost: false, headers: { Host: new URL(PUBLIC).host, 'X-App-Key': KEY } }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
    req.on('error', reject);
    req.end();
  });
  assert.equal(status, 404);
});

test('/app/removed/ready is 409 once the saved folder is gone', async (t) => {
  const { app, f, home } = await desktop(t);
  assert.equal((await post(f)).status, 303);
  rmSync(join(home.home, 'Documents', savedFolders(home.home)[0]!), { recursive: true });
  assert.equal((await ready(app.baseUrl, KEY)).status, 409);
});
