import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../db.js';
import { RedirectAllowlist } from '../auth/redirects.js';
import { ClientsStore } from '../auth/clientsStore.js';
import { MemoryOAuthProvider } from '../auth/provider.js';
import { systemClock } from '../clock.js';
import { fakeHome } from '../testing/fakeTools.js';
import { main } from '../cli.js';

/** Runs the CLI with HOME, PATH and DATA_DIR pointing at throwaway folders; puts the real ones back afterwards. */
async function runDisconnect(t: TestContext, home: string, bin: string, data: string): Promise<number> {
  const keep = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, APPDATA: process.env.APPDATA, PATH: process.env.PATH, DATA_DIR: process.env.DATA_DIR };
  t.after(() => { for (const [k, v] of Object.entries(keep)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  delete process.env.USERPROFILE;
  process.env.APPDATA = join(home, 'AppData', 'Roaming'); // never the real one, on any OS
  process.env.HOME = home;
  process.env.PATH = `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`;
  process.env.DATA_DIR = data;
  return main(['disconnect-tools']);
}

test('disconnect-tools with no brainai.json exits 0 and touches nothing', async (t) => {
  const f = fakeHome();
  const data = mkdtempSync(join(tmpdir(), 'brainai-data-'));
  t.after(() => { f.cleanup(); rmSync(data, { recursive: true, force: true }); });
  f.write('.fake-claude.json', JSON.stringify({ brainai: 'http://localhost:3100/mcp' }));
  assert.equal(await runDisconnect(t, f.home, f.bin, data), 0);
  assert.deepEqual(f.calls(), [], 'no tool was called');
  assert.deepEqual(f.servers('claude'), { brainai: 'http://localhost:3100/mcp' });
});

test("disconnect-tools removes this brain's entry and leaves another brain's", async (t) => {
  const f = fakeHome();
  const data = mkdtempSync(join(tmpdir(), 'brainai-data-'));
  t.after(() => { f.cleanup(); rmSync(data, { recursive: true, force: true }); });
  writeFileSync(join(data, 'brainai.json'), JSON.stringify({ port: 3107 }));
  f.write('.fake-claude.json', JSON.stringify({ brainai: 'http://localhost:3107/mcp', memory: 'https://memory.example.com/mcp', larder: 'http://localhost:9/mcp' }));
  assert.equal(await runDisconnect(t, f.home, f.bin, data), 0);
  assert.deepEqual(f.servers('claude'), { memory: 'https://memory.example.com/mcp', larder: 'http://localhost:9/mcp' });

  // Another BrainAI on another port is left as it is, and the command still succeeds.
  const g = fakeHome(['claude']);
  t.after(() => g.cleanup());
  g.write('.fake-claude.json', JSON.stringify({ brainai: 'http://localhost:3999/mcp' }));
  assert.equal(await runDisconnect(t, g.home, g.bin, data), 0);
  assert.deepEqual(g.servers('claude'), { brainai: 'http://localhost:3999/mcp' });
});

test("disconnect-tools disconnects Claude's desktop app too, and revokes its key in the database", async (t) => {
  const f = fakeHome([]);
  const data = mkdtempSync(join(tmpdir(), 'brainai-data-'));
  t.after(() => { f.cleanup(); rmSync(data, { recursive: true, force: true }); });
  mkdirSync(join(data, 'data'));
  writeFileSync(join(data, 'brainai.json'), JSON.stringify({ port: 3107 }));
  const providerOf = (db: ReturnType<typeof openDb>) => {
    const allow = new RedirectAllowlist(db);
    return new MemoryOAuthProvider(db, new ClientsStore(db, allow, systemClock), allow, systemClock, new URL('http://localhost:3107/mcp'));
  };
  const db = openDb(join(data, 'data', 'memory.db'));
  const grant = providerOf(db).issueLocalGrant({ name: 'Claude (desktop app)', clientName: 'Claude (desktop app)' });
  db.close();
  writeFileSync(join(data, 'data', 'claude-desktop-key'), JSON.stringify({ grant: grant.grantId, token: grant.token }));
  const cli = fileURLToPath(new URL('../cli.ts', import.meta.url));
  f.write('Library/Application Support/Claude/claude_desktop_config.json', JSON.stringify({
    mcpServers: { brainai: { command: process.execPath, args: [cli, 'claude-bridge'] }, other: { command: 'x' } },
  }));
  assert.equal(await runDisconnect(t, f.home, f.bin, data), 0);
  assert.deepEqual(JSON.parse(f.read('Library/Application Support/Claude/claude_desktop_config.json')!).mcpServers, { other: { command: 'x' } });
  assert.equal(existsSync(join(data, 'data', 'claude-desktop-key')), false);
  const again = openDb(join(data, 'data', 'memory.db'));
  t.after(() => again.close());
  assert.ok(providerOf(again).listGrants().find((g) => g.id === grant.grantId)?.revokedAt, 'the grant is revoked');
});

test("disconnect-tools leaves another BrainAI's Claude entry alone but revokes and deletes our own leftover key", async (t) => {
  const f = fakeHome([]);
  const data = mkdtempSync(join(tmpdir(), 'brainai-data-'));
  t.after(() => { f.cleanup(); rmSync(data, { recursive: true, force: true }); });
  mkdirSync(join(data, 'data'));
  writeFileSync(join(data, 'brainai.json'), JSON.stringify({ port: 3107 }));
  const allow = (db: ReturnType<typeof openDb>) => new RedirectAllowlist(db);
  const providerOf = (db: ReturnType<typeof openDb>) => new MemoryOAuthProvider(db, new ClientsStore(db, allow(db), systemClock), allow(db), systemClock, new URL('http://localhost:3107/mcp'));
  const db = openDb(join(data, 'data', 'memory.db'));
  const grant = providerOf(db).issueLocalGrant({ name: 'Claude (desktop app)', clientName: 'Claude (desktop app)' });
  db.close();
  writeFileSync(join(data, 'data', 'claude-desktop-key'), JSON.stringify({ grant: grant.grantId, token: grant.token }));
  const otherCli = join(data, 'other-cli.js');
  writeFileSync(otherCli, '');
  const theirs = JSON.stringify({ mcpServers: { brainai: { command: process.execPath, args: [otherCli, 'claude-bridge'], env: { BRAINAI_DATA_DIR: join(data, 'elsewhere') } } } });
  f.write('Library/Application Support/Claude/claude_desktop_config.json', theirs);
  assert.equal(await runDisconnect(t, f.home, f.bin, data), 0);
  assert.equal(f.read('Library/Application Support/Claude/claude_desktop_config.json'), theirs);
  assert.equal(existsSync(join(data, 'data', 'claude-desktop-key')), false);
  const again = openDb(join(data, 'data', 'memory.db'));
  t.after(() => again.close());
  assert.ok(providerOf(again).listGrants().find((g) => g.id === grant.grantId)?.revokedAt, 'the grant is revoked');
});
