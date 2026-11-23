/** Connect's safer file handling: BOM, UTF-16, backups, config folders, translated errors, the Windows PATH. Temp homes only. */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fakeHome, type FakeHome } from '../testing/fakeTools.js';
import { setupText } from '../setup/texts.js';
import { backupFiles, childEnv, connect, disconnect, secretBackups, settlePrevious, toolStates, tracesOfThisBrain, writeFailure, WriteError, type ToolEnv } from './tools.js';
import { writeAtomic } from './leftovers.js';
import { findBlock } from './rulesBlock.js';
import { runWithLocale } from '../i18n/core.js';

const URL_ = 'http://localhost:3100/mcp';

function world(t: TestContext, tools?: Parameters<typeof fakeHome>[0], system: Record<string, string | undefined> = {}): { f: FakeHome; env: ToolEnv } {
  const f = fakeHome(tools);
  t.after(() => f.cleanup());
  const env: ToolEnv = {
    home: f.home, apps: f.apps, mcpUrl: URL_, path: `${f.bin}:${dirname(process.execPath)}:/usr/bin:/bin`,
    rules: (slug) => setupText(slug, URL_), system, claudeConfig: join(f.home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'),
  };
  return { f, env };
}
const cursorWorld = (t: TestContext, system?: Record<string, string | undefined>) => { const w = world(t, [], system); mkdirSync(join(w.f.home, '.cursor'), { recursive: true }); return w; };
const bytes = (f: FakeHome, rel: string) => readFileSync(join(f.home, rel));

test('a UTF-8 BOM is stripped to parse and put back on write', async (t) => {
  const { f, env } = cursorWorld(t);
  writeFileSync(join(f.home, '.cursor', 'mcp.json'), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(JSON.stringify({ mcpServers: { other: { url: 'https://x.example/mcp' } } }))]));
  const r = await connect('cursor', env, {});
  assert.equal(r.ok, true);
  const out = bytes(f, '.cursor/mcp.json');
  assert.deepEqual([...out.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'the BOM is still there');
  assert.equal(JSON.parse(out.subarray(3).toString('utf8')).mcpServers.brainai.url, URL_);
  assert.equal(JSON.parse(out.subarray(3).toString('utf8')).mcpServers.other.url, 'https://x.example/mcp');
  // No BOM, none added.
  const second = cursorWorld(t);
  writeFileSync(join(second.f.home, '.cursor', 'mcp.json'), '{}');
  await connect('cursor', second.env, {});
  assert.notEqual(bytes(second.f, '.cursor/mcp.json')[0], 0xef);
});

test('a UTF-16 file is refused untouched, with a message that says how to save it as UTF-8 (EN and ES)', async (t) => {
  const { f, env } = cursorWorld(t);
  const file = join(f.home, '.cursor', 'mcp.json');
  const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('{"mcpServers":{}}', 'utf16le')]);
  writeFileSync(file, utf16);
  const r = await connect('cursor', env, {});
  assert.equal(r.ok, false);
  assert.match((r as { reason: string }).reason, /UTF-16.*UTF-8/s);
  const es = await runWithLocale('es', () => connect('cursor', env, {}));
  assert.match((es as { reason: string }).reason, /UTF-16.*UTF-8.*inténtalo de nuevo/s);
  assert.deepEqual(readFileSync(file), utf16);
  // Big-endian too.
  const be = Buffer.from([0xfe, 0xff, 0x00, 0x7b, 0x00, 0x7d]);
  writeFileSync(file, be);
  assert.equal((await connect('cursor', env, {})).ok, false);
  assert.deepEqual(readFileSync(file), be);
});

test('config writes leave no temp file behind', async (t) => {
  const { f, env } = cursorWorld(t);
  writeFileSync(join(f.home, '.cursor', 'mcp.json'), '{}');
  await connect('cursor', env, {});
  assert.deepEqual(readdirSync(join(f.home, '.cursor')).filter((n) => n.endsWith('.tmp')), []);
});

test('the backup keeps the first original through Connect and Disconnect, but is refreshed once the owner has a newer file without BrainAI', async (t) => {
  const { f, env } = cursorWorld(t);
  const file = join(f.home, '.cursor', 'mcp.json');
  writeFileSync(file, '{"mcpServers":{"a":{"url":"https://a.example"}}}');
  await connect('cursor', env, { replace: true });
  const first = readFileSync(`${file}.brainai-backup`, 'utf8');
  assert.match(first, /"a"/);
  await connect('cursor', env, { replace: true });
  assert.equal(readFileSync(`${file}.brainai-backup`, 'utf8'), first, 'still the original while BrainAI is in the file');
  // The owner takes BrainAI out by hand and changes the file; connecting again backs that up.
  writeFileSync(file, '{"mcpServers":{"b":{"url":"https://b.example"}}}');
  await connect('cursor', env, { replace: true });
  assert.match(readFileSync(`${file}.brainai-backup`, 'utf8'), /"b"/);
});

test('backups that can hold other tools\' keys are never offered to Remove for the saved folder', async (t) => {
  const { f, env } = cursorWorld(t);
  const cfg = join(f.home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  mkdirSync(dirname(cfg), { recursive: true });
  for (const rel of ['.cursor/mcp.json', '.gemini/settings.json', '.config/opencode/opencode.json', '.claude/settings.json', '.claude/CLAUDE.md', '.codex/AGENTS.md']) {
    f.write(`${rel}.brainai-backup`, '{"env":{"TOKEN":"secret"}}');
  }
  writeFileSync(`${cfg}.brainai-backup`, '{}');
  const moved = backupFiles(env).map((p) => p.slice(f.home.length + 1));
  assert.deepEqual(moved.sort(), ['.claude/CLAUDE.md.brainai-backup', '.codex/AGENTS.md.brainai-backup']);
  assert.equal(secretBackups(env).length, 5);
});

test('CLAUDE_CONFIG_DIR and CODEX_HOME decide where the rules go, and reach the tools\' commands', async (t) => {
  const base = mkdtempSync(join(tmpdir(), 'brainai-cfg-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const system = { CLAUDE_CONFIG_DIR: join(base, 'claude'), CODEX_HOME: join(base, 'codex'), XDG_CONFIG_HOME: join(base, 'xdg') };
  const { f, env } = world(t, ['claude', 'codex', 'opencode'], system);
  assert.equal((await connect('claude-code', env, {})).ok, true);
  assert.equal((await connect('codex', env, {})).ok, true);
  assert.equal((await connect('opencode', env, {})).ok, true);
  assert.match(readFileSync(join(base, 'claude', 'CLAUDE.md'), 'utf8'), /localhost:3100/);
  assert.match(readFileSync(join(base, 'codex', 'AGENTS.md'), 'utf8'), /localhost:3100/);
  assert.equal(JSON.parse(readFileSync(join(base, 'xdg', 'opencode', 'opencode.json'), 'utf8')).mcp.brainai.url, URL_);
  assert.equal(existsSync(join(f.home, '.claude', 'CLAUDE.md')), false);
  assert.equal(existsSync(join(f.home, '.codex', 'AGENTS.md')), false);
  const mac = childEnv(env);
  assert.equal(mac.CLAUDE_CONFIG_DIR, system.CLAUDE_CONFIG_DIR);
  assert.equal(mac.CODEX_HOME, system.CODEX_HOME);
  const win = childEnv({ ...env, platform: 'win32', system: { ...system, ProgramFiles: 'C:\\Program Files', ProgramData: 'C:\\ProgramData', SECRET: 'x' } });
  assert.equal(win.CLAUDE_CONFIG_DIR, system.CLAUDE_CONFIG_DIR);
  assert.equal(win.ProgramFiles, 'C:\\Program Files');
  assert.equal(win.ProgramData, 'C:\\ProgramData');
  assert.equal(win.SECRET, undefined, 'nothing else of the environment');
  // A relative folder is not trusted.
  assert.equal(childEnv({ ...env, system: { CODEX_HOME: 'relative' } }).CODEX_HOME, undefined, 'a relative folder is not passed on, as it is not used for the files');
  const rel = world(t, ['codex'], { CODEX_HOME: 'relative' });
  await connect('codex', rel.env, {});
  assert.ok(existsSync(join(rel.f.home, '.codex', 'AGENTS.md')), 'falls back to ~/.codex');
});

test('connect errors come in Spanish, quoting the tool\'s own words as they are', async (t) => {
  const noCursor = world(t, []);
  const es = await runWithLocale('es', () => connect('codex', noCursor.env, {}));
  assert.match((es as { reason: string }).reason, /^Codex no está instalado en .*\. ¿Lo acabas de instalar\? Cierra BrainAI desde la barra de menús o la bandeja y ábrelo de nuevo\.$/s);
  const en = await connect('codex', noCursor.env, {});
  assert.match((en as { reason: string }).reason, /is not installed.*Installed it just now\? Quit BrainAI from the menu bar or tray and open it again\./s);
  // A refused JSON file.
  const c = cursorWorld(t);
  writeFileSync(join(c.f.home, '.cursor', 'mcp.json'), '{ // comment');
  assert.match(((await runWithLocale('es', () => connect('cursor', c.env, {}))) as { reason: string }).reason, /no es JSON simple/);
  assert.match(((await connect('cursor', c.env, {})) as { reason: string }).reason, /is not plain JSON/);
});

test('a read-only settings file is a message, not an error: Connect and Disconnect say so (EN and ES) and leave it as it is', async (t) => {
  const { f, env } = cursorWorld(t);
  const file = join(f.home, '.cursor', 'mcp.json');
  writeFileSync(file, '{"mcpServers":{}}');
  chmodSync(file, 0o444);
  const r = await connect('cursor', env, {});
  assert.deepEqual([r.ok, (r as { reason: string }).reason], [false, `${file} is read-only: BrainAI did not change it. Make it writable (or change it yourself) and try again.`]);
  assert.match(((await runWithLocale('es', () => connect('cursor', env, {}))) as { reason: string }).reason, /es de solo lectura: BrainAI no lo ha cambiado/);
  assert.equal(readFileSync(file, 'utf8'), '{"mcpServers":{}}');
  chmodSync(file, 0o644);
  writeFileSync(file, '{"mcpServers":{"brainai":{"url":"' + URL_ + '"}}}');
  chmodSync(file, 0o444);
  assert.equal(((await disconnect('cursor', env)) as { ok: boolean }).ok, false, 'a failed removal is a message too');
  chmodSync(file, 0o644);
});

test('a write that fails with EBUSY names the other program (EN and ES); writeFailure leaves other errors in the system\'s words', () => {
  const e = new WriteError('C:\\a\\mcp.json', 'EBUSY', 'busy');
  assert.equal(writeFailure(e), 'Another program has C:\\a\\mcp.json open: close it and try again.');
  assert.match(runWithLocale('es', () => writeFailure(new WriteError('x', 'EPERM', 'm'))), /Otro programa tiene abierto x/);
  assert.equal(writeFailure(new Error('disk full'), 'f'), 'BrainAI could not write f: disk full');
});

test('writeAtomic on Windows retries a rename that is refused, then writes into the file; elsewhere the error stands; no temp file stays', () => {
  const dir = mkdtempSync(join(tmpdir(), 'brainai-atomic-'));
  const file = join(dir, 'c.json');
  try {
    writeFileSync(file, 'old');
    let tries = 0;
    const waits: number[] = [];
    const busy = () => { tries++; throw Object.assign(new Error('busy'), { code: 'EBUSY' }); };
    writeAtomic(file, 'new', { platform: 'win32', rename: busy, sleep: (ms) => waits.push(ms) });
    assert.equal(readFileSync(file, 'utf8'), 'new', 'written in place after the retries');
    assert.equal(tries, 6);
    assert.ok(waits.reduce((a, b) => a + b, 0) < 2000, 'under 2 s in all');
    assert.deepEqual(readdirSync(dir), ['c.json'], 'the temp file is gone');
    // A rename that works the second time never reaches the in-place write.
    writeFileSync(file, 'old');
    let n = 0;
    writeAtomic(file, 'second', { platform: 'win32', sleep: () => {}, rename: (a, b) => { if (n++ === 0) throw Object.assign(new Error('x'), { code: 'EPERM' }); renameSync(a, b); } });
    assert.equal(readFileSync(file, 'utf8'), 'second');
    // Not Windows: the error is the caller's, and the file is untouched.
    writeFileSync(file, 'old');
    assert.throws(() => writeAtomic(file, 'x', { platform: 'darwin', rename: busy }), /busy/);
    assert.equal(readFileSync(file, 'utf8'), 'old');
    assert.deepEqual(readdirSync(dir), ['c.json']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('Disconnect with CLAUDE_CONFIG_DIR takes Claude Code\'s hooks out of that folder, even with a BOM', async (t) => {
  const base = mkdtempSync(join(tmpdir(), 'brainai-cfgd-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const dirc = join(base, 'claude');
  const { f, env } = world(t, ['claude'], { CLAUDE_CONFIG_DIR: dirc });
  const hooksSrc = join(base, 'src');
  mkdirSync(hooksSrc);
  for (const n of ['memoryStart.js', 'memorySave.js']) writeFileSync(join(hooksSrc, n), '//');
  env.hooksDir = hooksSrc;
  writeFileSync(join(base, 'unused'), '');
  mkdirSync(dirc, { recursive: true });
  writeFileSync(join(dirc, 'settings.json'), `\uFEFF${JSON.stringify({ theme: 'dark' })}`);
  assert.equal((await connect('claude-code', env, {})).ok, true);
  assert.ok(existsSync(join(dirc, 'hooks', 'memory-save.mjs')), 'installed in the Claude folder');
  assert.equal(existsSync(join(f.home, '.claude', 'hooks')), false);
  assert.ok(readFileSync(join(dirc, 'settings.json'), 'utf8').startsWith('\uFEFF'), 'the BOM is kept');
  const { removeHooks } = await import('./leftovers.js');
  const out = removeHooks(env, false);
  assert.equal(out.kept, null);
  assert.equal(existsSync(join(dirc, 'hooks', 'memory-save.mjs')), false);
  const settings = readFileSync(join(dirc, 'settings.json'), 'utf8');
  assert.ok(settings.startsWith('\uFEFF'));
  assert.deepEqual(JSON.parse(settings.slice(1)), { theme: 'dark' });
  // Another brain's script with the same name in another folder is not ours.
  writeFileSync(join(dirc, 'settings.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node "/elsewhere/hooks/memory-save.mjs"' }] }] } }));
  assert.deepEqual(removeHooks(env, false), { removed: [], kept: null });
  assert.match(readFileSync(join(dirc, 'settings.json'), 'utf8'), /elsewhere/);
});

test('an entry or rules block at a port BrainAI left is its own, stale: Connect again fixes it, Disconnect removes it', async (t) => {
  const { f, env } = world(t);
  env.previousUrls = ['http://localhost:3099/mcp'];
  f.write('.fake-claude.json', JSON.stringify({ brainai: 'http://localhost:3099/mcp' }));
  f.write('.claude/CLAUDE.md', `# Mine\n\n${setupText('claude-code', 'http://localhost:3099/mcp')}\n`);
  const s = (await toolStates(env)).find((x) => x.id === 'claude-code')!;
  assert.equal(s.state, 'not-connected');
  assert.equal(s.detail, 'needs connecting again');
  assert.equal((await connect('claude-code', env, {})).ok, true, 'no Replace needed');
  assert.deepEqual(f.servers('claude'), { brainai: URL_ });
  assert.equal(findBlock(f.read('.claude/CLAUDE.md')!)!.host, 'localhost:3100');
  assert.equal(((await toolStates(env)).find((x) => x.id === 'claude-code')!).state, 'connected');
  // Disconnect also clears a stale one.
  f.write('.fake-claude.json', JSON.stringify({ brainai: 'http://localhost:3099/mcp' }));
  f.write('.claude/CLAUDE.md', `# Mine\n\n${setupText('claude-code', 'http://localhost:3099/mcp')}\n`);
  assert.equal((await disconnect('claude-code', env)).ok, true);
  assert.deepEqual(f.servers('claude'), {});
  assert.equal(findBlock(f.read('.claude/CLAUDE.md')!), null);
  assert.equal(await tracesOfThisBrain('claude-code', { ...env, previousUrls: [] }), 'no');
});

test('a previous port is stale-own only while no BrainAI answers there; one that answers stays "another BrainAI"', async (t) => {
  const { f, env } = world(t);
  f.write('.fake-claude.json', JSON.stringify({ brainai: 'http://localhost:3099/mcp' }));
  f.write('.claude/CLAUDE.md', `# Mine\n\n${setupText('claude-code', 'http://localhost:3099/mcp')}\n`);
  env.previousUrls = ['http://localhost:3099/mcp'];
  const state = async () => (await toolStates(env)).find((x) => x.id === 'claude-code')!;
  env.probe = async () => true; // another BrainAI took the port
  await settlePrevious(env);
  assert.deepEqual(env.previousUrls, []);
  assert.equal((await state()).state, 'other-brainai');
  env.previousUrls = ['http://localhost:3099/mcp'];
  env.probe = async () => false; // nothing there
  await settlePrevious(env);
  assert.equal((await state()).state, 'not-connected');
  // The real probe: something that is not BrainAI (no OAuth metadata) does not count; BrainAI's metadata does.
  let body = '{}';
  const srv = createServer((_q, r) => { r.setHeader('content-type', 'application/json'); r.end(body); });
  await new Promise<void>((ok) => srv.listen(0, '127.0.0.1', ok));
  t.after(() => srv.close());
  const url = `http://127.0.0.1:${(srv.address() as { port: number }).port}/mcp`;
  const real: ToolEnv = { ...env, previousUrls: [url], probe: undefined };
  await settlePrevious(real);
  assert.deepEqual(real.previousUrls, [url], 'an unrelated server there: still stale');
  body = JSON.stringify({ issuer: 'http://x', authorization_endpoint: 'http://x/authorize' });
  await settlePrevious(real);
  assert.deepEqual(real.previousUrls, [], 'a BrainAI answers: not ours to clean up');
});

test('a file that cannot be written is said to be read-only whatever the system code (Windows says EPERM)', () => {
  assert.equal(writeFailure(new WriteError('C:\\a.json', 'READONLY', 'EPERM: operation not permitted')), 'C:\\a.json is read-only: BrainAI did not change it. Make it writable (or change it yourself) and try again.');
});

test('writeAtomic: a failed in-place write leaves the original and the error goes on; the temp file is gone', () => {
  const dir = mkdtempSync(join(tmpdir(), 'brainai-inplace-'));
  const file = join(dir, 'c.json');
  try {
    writeFileSync(file, 'original');
    chmodSync(file, 0o444);
    const busy = () => { throw Object.assign(new Error('busy'), { code: 'EBUSY' }); };
    assert.throws(() => writeAtomic(file, 'new', { platform: 'win32', rename: busy, sleep: () => {} }));
    assert.equal(readFileSync(file, 'utf8'), 'original');
    assert.deepEqual(readdirSync(dir), ['c.json']);
  } finally { chmodSync(file, 0o644); rmSync(dir, { recursive: true, force: true }); }
});

test('Codex: when its approval cannot be set, Connect still succeeds and says so', async (t) => {
  const { f, env } = world(t, ['codex']);
  // The tool adds its entry, then the file turns read-only (a stand-in for any failure of the approval edit).
  const real = join(f.bin, 'codex-real');
  renameSync(join(f.bin, 'codex'), real);
  writeFileSync(join(f.bin, 'codex'), ['#!/bin/sh', `"${real}" "$@"`, 'status=$?', 'case "$*" in *" add "*) chmod 444 "$HOME/.codex/config.toml";; esac', 'exit $status', ''].join('\n'));
  chmodSync(join(f.bin, 'codex'), 0o755);
  f.write('.codex/config.toml', '# mine\n');
  t.after(() => { try { chmodSync(join(f.home, '.codex', 'config.toml'), 0o644); } catch { /* gone */ } });
  const r = await connect('codex', env, {});
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.match((r as { hooksNote?: string }).hooksNote ?? '', /Codex is connected, but BrainAI could not set it to use BrainAI's tools without asking \(.* is read-only/);
});
