import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { openDb } from '../db.js';
import { RedirectAllowlist } from '../auth/redirects.js';
import { ClientsStore } from '../auth/clientsStore.js';
import { MemoryOAuthProvider } from '../auth/provider.js';
import { systemClock } from '../clock.js';
import { fakeHome } from '../testing/fakeTools.js';
import { main } from '../cli.js';
import { takeToolsOut } from './removeTools.js';
import { setupText } from '../setup/texts.js';
import type { ToolEnv } from './tools.js';

/** Runs `cli disconnect-tools` with a PATH that does NOT hold the fake tools' folder. */
async function run(t: TestContext, home: string, data: string): Promise<number> {
  const keep = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, APPDATA: process.env.APPDATA, LOCALAPPDATA: process.env.LOCALAPPDATA, PATH: process.env.PATH, DATA_DIR: process.env.DATA_DIR };
  t.after(() => { for (const [k, v] of Object.entries(keep)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  delete process.env.USERPROFILE;
  process.env.APPDATA = join(home, 'AppData', 'Roaming');
  process.env.LOCALAPPDATA = join(home, 'AppData', 'Local');
  process.env.HOME = home;
  process.env.PATH = `${dirname(process.execPath)}:/usr/bin:/bin`;
  process.env.DATA_DIR = data;
  return main(['disconnect-tools']);
}
const providerOf = (db: ReturnType<typeof openDb>) => {
  const allow = new RedirectAllowlist(db);
  return new MemoryOAuthProvider(db, new ClientsStore(db, allow, systemClock), allow, systemClock, new URL('http://localhost:3107/mcp'));
};
const setup = (t: TestContext) => {
  const f = fakeHome(['claude', 'codex']);
  const data = mkdtempSync(join(tmpdir(), 'brainai-data-'));
  t.after(() => { f.cleanup(); rmSync(data, { recursive: true, force: true }); });
  mkdirSync(join(data, 'data'));
  writeFileSync(join(data, 'brainai.json'), JSON.stringify({ port: 3107 }));
  return { f, data };
};

test('disconnect-tools finds a tool that is only in ~/.local/bin, and ends its sign-in', async (t) => {
  const { f, data } = setup(t);
  // The stub moves from the usual bin folder to ~/.local/bin: the PATH the uninstaller gets has no sign of it.
  mkdirSync(join(f.home, '.local', 'bin'), { recursive: true });
  copyFileSync(join(f.bin, 'claude'), join(f.home, '.local', 'bin', 'claude'));
  rmSync(join(f.bin, 'claude'));
  f.write('.fake-claude.json', JSON.stringify({ brainai: 'http://localhost:3107/mcp' }));
  const db = openDb(join(data, 'data', 'memory.db'));
  const code = providerOf(db).issueLocalGrant({ name: 'Claude Code', clientName: 'Claude Code' });
  const web = providerOf(db).issueLocalGrant({ name: 'ChatGPT', clientName: 'ChatGPT' });
  db.close();
  assert.equal(await run(t, f.home, data), 0);
  assert.deepEqual(f.servers('claude'), {}, 'the entry is gone');
  const again = openDb(join(data, 'data', 'memory.db'));
  t.after(() => again.close());
  const grants = providerOf(again).listGrants();
  assert.ok(grants.find((g) => g.id === code.grantId)?.revokedAt, "Claude Code's sign-in ended");
  assert.equal(grants.find((g) => g.id === web.grantId)?.revokedAt, null, "another app's sign-in is untouched");
});

test('disconnect-tools also takes out Claude Code hooks whose server entry was removed by hand, and leaves every .brainai-backup beside its original', async (t) => {
  const { f, data } = setup(t);
  mkdirSync(join(f.home, '.local', 'bin'), { recursive: true });
  copyFileSync(join(f.bin, 'claude'), join(f.home, '.local', 'bin', 'claude'));
  copyFileSync(join(f.bin, 'codex'), join(f.home, '.local', 'bin', 'codex'));
  f.write('.claude/hooks/memory-start.mjs', '// start');
  f.write('.claude/hooks/memory-save.mjs', '// save');
  f.write('.claude/settings.json', JSON.stringify({ theme: 'dark', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node "/h/.claude/hooks/memory-save.mjs"' }, { type: 'command', command: 'say done' }] }] } }));
  f.write('.claude/settings.json.brainai-backup', '{"env":{"TOKEN":"secret"}}');
  f.write('.cursor/mcp.json.brainai-backup', '{"mcpServers":{}}');
  f.write('.codex/config.toml.brainai-backup', 'x');
  f.write('.codex/hooks.json', JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node "/h/.brainai/hooks/memory-nudge.mjs"' }] }] } }));
  f.write('.codex/config.toml', '');
  f.write(".brainai/hooks/memory-nudge.mjs", "// nudge");
  f.write('.cursor/mcp.json', '{}');
  assert.equal(await run(t, f.home, data), 0);
  assert.equal(existsSync(join(f.home, '.claude/hooks/memory-save.mjs')), false);
  const settings = JSON.parse(f.read('.claude/settings.json')!) as { theme: string; hooks: { Stop: { hooks: { command: string }[] }[] } };
  assert.equal(settings.theme, 'dark');
  assert.deepEqual(settings.hooks.Stop[0]!.hooks.map((h) => h.command), ['say done']);
  for (const b of ['.claude/settings.json.brainai-backup', '.cursor/mcp.json.brainai-backup', '.codex/config.toml.brainai-backup']) assert.notEqual(f.read(b), null, `${b} stays beside its original`);
  assert.equal(f.read('.codex/hooks.json'), null, "Codex's save reminder is gone");
});

test('one tool that throws never leaves the tools after it connected', async (t) => {
  const { f } = setup(t);
  f.write('.fake-claude.json', JSON.stringify({ brainai: 'http://localhost:3107/mcp' }));
  f.write('.fake-codex.json', JSON.stringify({ brainai: 'http://localhost:3107/mcp' }));
  const env: ToolEnv = {
    home: f.home, apps: f.apps, mcpUrl: 'http://localhost:3107/mcp', path: `${f.bin}:${dirname(process.execPath)}:/usr/bin:/bin`,
    rules: (slug) => setupText(slug, 'http://localhost:3107/mcp'), system: {},
    endSignIns: (name) => { if (name === 'Claude Code') throw new Error('SQLITE_BUSY'); return 0; },
  };
  const kept: string[] = [];
  const out = await takeToolsOut(env, kept);
  assert.ok(out.tools.some((o) => o.name === 'Claude Code' && o.what === 'failed' && /SQLITE_BUSY/.test(o.detail ?? '')));
  assert.ok(out.leftTools.some((l) => l.name === 'Claude Code'));
  assert.deepEqual(f.servers('codex'), {}, 'Codex was still disconnected');
});

test('save-copy --app refuses (exit 3) when there is no memory.db, and creates none', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'brainai-nodb-'));
  const to = mkdtempSync(join(tmpdir(), 'brainai-to-'));
  const keep = { DATA_DIR: process.env.DATA_DIR, BRAINAI_COPY_TO: process.env.BRAINAI_COPY_TO };
  t.after(() => { for (const [k, v] of Object.entries(keep)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } rmSync(dir, { recursive: true, force: true }); rmSync(to, { recursive: true, force: true }); });
  process.env.DATA_DIR = dir;
  process.env.BRAINAI_COPY_TO = to;
  t.mock.method(console, 'error', () => {});
  assert.equal(await main(['save-copy', '--app']), 3);
  assert.equal(existsSync(join(dir, 'memory.db')), false);
});

test('disconnect-tools uses the usual port (home), not the temporary one the last run was on', async (t) => {
  const { f, data } = setup(t);
  mkdirSync(join(f.home, '.local', 'bin'), { recursive: true });
  copyFileSync(join(f.bin, 'claude'), join(f.home, '.local', 'bin', 'claude'));
  // The last run was on 3110 (a one-off); the apps are connected to 3104.
  writeFileSync(join(data, 'brainai.json'), JSON.stringify({ port: 3110, home: 3104, misses: 1 }));
  f.write('.fake-claude.json', JSON.stringify({ brainai: 'http://localhost:3104/mcp' }));
  assert.equal(await run(t, f.home, data), 0);
  assert.deepEqual(f.servers('claude'), {}, 'our own entry at the usual port is taken out, not left as another BrainAI');
});

test('disconnect-tools also takes out an entry at a port the home moved away from', async (t) => {
  const { f, data } = setup(t);
  mkdirSync(join(f.home, '.local', 'bin'), { recursive: true });
  copyFileSync(join(f.bin, 'claude'), join(f.home, '.local', 'bin', 'claude'));
  writeFileSync(join(data, 'brainai.json'), JSON.stringify({ port: 3105, home: 3105, previous: [3100] }));
  f.write('.fake-claude.json', JSON.stringify({ brainai: 'http://localhost:3100/mcp' }));
  assert.equal(await run(t, f.home, data), 0);
  assert.deepEqual(f.servers('claude'), {});
});

test('disconnect-tools leaves an entry at a previous port alone when a BrainAI answers there', async (t) => {
  const { f, data } = setup(t);
  mkdirSync(join(f.home, '.local', 'bin'), { recursive: true });
  copyFileSync(join(f.bin, 'claude'), join(f.home, '.local', 'bin', 'claude'));
  const srv = createServer((_q, r) => { r.setHeader('content-type', 'application/json'); r.end(JSON.stringify({ issuer: 'http://x', authorization_endpoint: 'http://x/authorize' })); });
  await new Promise<void>((ok) => srv.listen(0, '127.0.0.1', ok));
  t.after(() => srv.close());
  const other = (srv.address() as { port: number }).port;
  writeFileSync(join(data, 'brainai.json'), JSON.stringify({ port: 3105, home: 3105, previous: [other] }));
  f.write('.fake-claude.json', JSON.stringify({ brainai: `http://localhost:${other}/mcp` }));
  assert.equal(await run(t, f.home, data), 0);
  assert.deepEqual(f.servers('claude'), { brainai: `http://localhost:${other}/mcp` }, "another BrainAI's entry stays");
});
