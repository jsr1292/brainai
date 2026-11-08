import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fakeHome, type FakeHome } from '../testing/fakeTools.js';
import { setupText } from '../setup/texts.js';
import { childEnv, commandLine, connect, disconnect, findCommand, toolStates, withCodexApproval, type ToolEnv } from './tools.js';
import { findBlock } from './rulesBlock.js';

const URL_ = 'http://localhost:3100/mcp';
const HOME_BRAINAI = 'https://memory.example.com/mcp';

function world(t: TestContext, tools?: Parameters<typeof fakeHome>[0]): { f: FakeHome; env: ToolEnv } {
  const f = fakeHome(tools);
  t.after(() => f.cleanup());
  const env: ToolEnv = {
    home: f.home, apps: f.apps, mcpUrl: URL_,
    path: `${f.bin}:${dirname(process.execPath)}:/usr/bin:/bin`,
    rules: (slug) => setupText(slug, 'personal', URL_),
  };
  return { f, env };
}
const stateOf = async (env: ToolEnv, id: string) => (await toolStates(env)).find((s) => s.id === id)!;

test('tools that are not installed are listed as such, and nothing is called', async (t) => {
  const { f, env } = world(t, []);
  const states = await toolStates(env);
  assert.deepEqual(states.map((s) => [s.id, s.installed]), [['claude-code', false], ['codex', false], ['opencode', false], ['cursor', false]]);
  assert.deepEqual(f.calls(), []);
});

test('Claude Code: connect adds the brainai server and the rules block; disconnect takes away exactly those', async (t) => {
  const { f, env } = world(t);
  f.write('.claude/CLAUDE.md', '# My own rules\nBe brief.\n');
  assert.equal((await stateOf(env, 'claude-code')).state, 'not-connected');
  const r = await connect('claude-code', env, {});
  assert.equal(r.ok, true);
  assert.match((r as { signIn: string }).signIn, /\/mcp/);
  assert.ok(f.calls().includes(`claude mcp add --transport http --scope user brainai ${URL_}`));
  assert.deepEqual(f.servers('claude'), { brainai: URL_ });
  const md = f.read('.claude/CLAUDE.md')!;
  assert.ok(md.startsWith('# My own rules\nBe brief.\n'));
  assert.equal(findBlock(md)!.host, 'localhost:3100');
  assert.equal(f.read('.claude/CLAUDE.md.brainai-backup'), '# My own rules\nBe brief.\n', 'a backup first');
  assert.equal((await stateOf(env, 'claude-code')).state, 'connected');
  assert.equal((await disconnect('claude-code', env)).ok, true);
  assert.deepEqual(f.servers('claude'), {});
  assert.equal(f.read('.claude/CLAUDE.md'), '# My own rules\nBe brief.\n');
});

test('a tool already on another BrainAI is left alone unless the owner presses Replace, and a memory server is never touched', async (t) => {
  const { f, env } = world(t);
  // The owner's own Mac: the home BrainAI as "memory", and its rules block.
  f.write('.fake-claude.json', JSON.stringify({ memory: HOME_BRAINAI }));
  const home = `# Mine\n\n${setupText('claude-code', 'personal', HOME_BRAINAI)}\n`;
  f.write('.claude/CLAUDE.md', home);
  const s = await stateOf(env, 'claude-code');
  assert.equal(s.state, 'other-brainai');
  assert.match(s.detail!, /memory\.example\.com/);
  const refused = await connect('claude-code', env, {});
  assert.equal(refused.ok, false);
  assert.match((refused as { reason: string }).reason, /another BrainAI/);
  assert.equal(f.read('.claude/CLAUDE.md'), home, 'nothing changed');
  assert.ok(!f.calls().some((c) => c.includes(' add ')));
  const replaced = await connect('claude-code', env, { replace: true });
  assert.equal(replaced.ok, true);
  assert.deepEqual(f.servers('claude'), { memory: HOME_BRAINAI, brainai: URL_ }, 'memory kept as it was');
  assert.equal(findBlock(f.read('.claude/CLAUDE.md')!)!.host, 'localhost:3100');
  assert.equal(f.read('.claude/CLAUDE.md.brainai-backup'), home);
  // A brainai server at another address counts as another BrainAI too.
  const other = world(t);
  other.f.write('.fake-claude.json', JSON.stringify({ brainai: 'http://localhost:3999/mcp' }));
  assert.equal((await stateOf(other.env, 'claude-code')).state, 'other-brainai');
  assert.equal((await disconnect('claude-code', other.env)).ok, false, 'disconnect never removes another BrainAI');
});

test("a tool's command failing leaves its instructions file untouched", async (t) => {
  const { f, env } = world(t);
  f.write('.claude/CLAUDE.md', 'keep\n');
  const r = await connect('claude-code', { ...env, extraEnv: { FAKE_FAIL: 'claude' } }, {});
  assert.equal(r.ok, false);
  assert.match((r as { reason: string }).reason, /Claude Code/);
  assert.equal(f.read('.claude/CLAUDE.md'), 'keep\n');
});

test('Codex: connect adds the server, approves its tools in config.toml, opens the sign-in, and writes AGENTS.md', async (t) => {
  const { f, env } = world(t);
  const r = await connect('codex', env, {});
  assert.equal(r.ok, true);
  assert.ok(f.calls().includes(`codex mcp add brainai --url ${URL_}`));
  // The sign-in is started in the background (it waits for the owner in the browser): give it a moment to begin.
  for (let i = 0; i < 40 && !f.calls().includes('codex mcp login brainai'); i++) await new Promise((r) => setTimeout(r, 50));
  assert.ok(f.calls().includes('codex mcp login brainai'), 'the sign-in opens by itself');
  assert.match(f.read('.codex/config.toml')!, /\[mcp_servers\.brainai\]\nurl = "http:\/\/localhost:3100\/mcp"\ndefault_tools_approval_mode = "approve"\n/);
  assert.equal(findBlock(f.read('.codex/AGENTS.md')!)!.host, 'localhost:3100');
  assert.equal((await stateOf(env, 'codex')).state, 'connected');
  assert.equal((await disconnect('codex', env)).ok, true);
  assert.deepEqual(f.servers('codex'), {});
  assert.equal(findBlock(f.read('.codex/AGENTS.md') ?? ''), null);
});

test('OpenCode: a plain opencode.json gains mcp.brainai; one with comments, or broken, is never rewritten', async (t) => {
  const { f, env } = world(t);
  f.write('.config/opencode/opencode.json', JSON.stringify({ $schema: 'https://opencode.ai/config.json', model: 'x' }, null, 2));
  const r = await connect('opencode', env, {});
  assert.equal(r.ok, true);
  const cfg = JSON.parse(f.read('.config/opencode/opencode.json')!);
  assert.deepEqual(cfg.mcp.brainai, { type: 'remote', url: URL_, enabled: true });
  assert.equal(cfg.model, 'x');
  assert.equal(findBlock(f.read('.config/opencode/AGENTS.md')!)!.host, 'localhost:3100');
  assert.equal((await disconnect('opencode', env)).ok, true);
  assert.equal(JSON.parse(f.read('.config/opencode/opencode.json')!).mcp?.brainai, undefined);

  for (const [name, text] of [['opencode.jsonc', '{ // mine\n "model": "x" }\n'], ['opencode.json', '{ "model": ']] as const) {
    const w = world(t);
    w.f.write(`.config/opencode/${name}`, text);
    const res = await connect('opencode', w.env, {});
    assert.equal(res.ok, false, name);
    assert.match((res as { reason: string }).reason, /Set up an app › OpenCode/);
    assert.equal(w.f.read(`.config/opencode/${name}`), text);
  }
});

test('Cursor: connect writes only ~/.cursor/mcp.json, keeping the servers already there', async (t) => {
  const { f, env } = world(t, []);
  mkdirSync(join(f.apps, 'Cursor.app'));
  f.write('.cursor/mcp.json', JSON.stringify({ mcpServers: { other: { url: 'https://x.example/mcp' } } }));
  assert.equal((await stateOf(env, 'cursor')).installed, true);
  const r = await connect('cursor', env, {});
  assert.equal(r.ok, true);
  assert.match((r as { signIn: string }).signIn, /rules/i);
  const cfg = JSON.parse(f.read('.cursor/mcp.json')!);
  assert.deepEqual(cfg.mcpServers, { other: { url: 'https://x.example/mcp' }, brainai: { url: URL_ } });
  assert.equal((await stateOf(env, 'cursor')).state, 'connected');
  assert.equal((await disconnect('cursor', env)).ok, true);
  assert.deepEqual(JSON.parse(f.read('.cursor/mcp.json')!).mcpServers, { other: { url: 'https://x.example/mcp' } });
});

const OWNERS_LINE = 'I have a shared memory, the brain (MCP connector "memory", memory.example.net), used by all my AI assistants.';

test("the owner's own CLAUDE.md, whose brain line has no markers, counts as another BrainAI and is never changed without Replace", async (t) => {
  const { f, env } = world(t);
  const md = `# Global\n\n${OWNERS_LINE}\nMore of my rules.\n`;
  f.write('.claude/CLAUDE.md', md);
  const s = await stateOf(env, 'claude-code');
  assert.equal(s.state, 'other-brainai');
  assert.match(s.detail!, /memory\.example\.net/);
  assert.equal((await connect('claude-code', env, {})).ok, false);
  // Even Replace will not edit brain text outside BrainAI's markers: it cannot tell where that text ends.
  const replaced = await connect('claude-code', env, { replace: true });
  assert.equal(replaced.ok, false);
  assert.match((replaced as { reason: string }).reason, /edit .*CLAUDE\.md yourself/);
  assert.equal(f.read('.claude/CLAUDE.md'), md);
  assert.deepEqual(f.servers('claude'), {});
  // With markers but wording the host can't be read from, it is still another brain, not ours.
  const w = world(t);
  w.f.write('.claude/CLAUDE.md', '<!-- brain setup 1 -->\nmy own brain notes\n<!-- /brain setup -->\n');
  assert.equal((await stateOf(w.env, 'claude-code')).state, 'other-brainai');
});

test('a tool whose answer cannot be read, or whose brainai entry has no address, is never overwritten', async (t) => {
  const { f, env } = world(t);
  // Codex prints a warning on stderr and fails: unknown, not "no server".
  const r = await connect('codex', { ...env, extraEnv: { FAKE_FAIL: 'codex' } }, {});
  assert.equal(r.ok, false);
  assert.ok(!f.calls().some((c) => c.startsWith('codex mcp add')), 'nothing added while unsure');
  // Cursor and OpenCode entries named brainai without a url (a bridge to another BrainAI) count as another BrainAI.
  const c = world(t, []);
  mkdirSync(join(c.f.apps, 'Cursor.app'));
  c.f.write('.cursor/mcp.json', JSON.stringify({ mcpServers: { brainai: { command: 'npx', args: ['mcp-remote', 'https://memory.example.com/mcp'] } } }));
  assert.equal((await stateOf(c.env, 'cursor')).state, 'other-brainai');
  assert.equal((await connect('cursor', c.env, {})).ok, false);
});

test('Replace then Disconnect gives the owner back their original rules: the first backup is never overwritten', async (t) => {
  const { f, env } = world(t);
  const home = `# Mine\n\n${setupText('claude-code', 'personal', HOME_BRAINAI)}\n`;
  f.write('.claude/CLAUDE.md', home);
  assert.equal((await connect('claude-code', env, { replace: true })).ok, true);
  assert.equal((await disconnect('claude-code', env)).ok, true);
  assert.equal(f.read('.claude/CLAUDE.md.brainai-backup'), home, 'the original is kept');
});

test('a file BrainAI cannot write ends in a clear message, not a half-done tool', async (t) => {
  const { f, env } = world(t);
  f.write('.claude/CLAUDE.md', 'mine\n');
  chmodSync(join(f.home, '.claude', 'CLAUDE.md'), 0o444);
  chmodSync(join(f.home, '.claude'), 0o555);
  let r;
  try {
    r = await connect('claude-code', env, {});
  } finally {
    chmodSync(join(f.home, '.claude'), 0o755);
    chmodSync(join(f.home, '.claude', 'CLAUDE.md'), 0o644);
  }
  assert.equal(r.ok, false);
  assert.match((r as { reason: string }).reason, /CLAUDE\.md/);
  assert.deepEqual(f.servers('claude'), {}, 'the server entry was taken back');
});

// Windows (D6): how tools are found and started there, tested on any computer with the platform passed in.
const winEnv = (path: string, system: Record<string, string> = {}): ToolEnv => ({ platform: 'win32', path, home: 'C:\\Users\\Ana', mcpUrl: URL_, rules: () => '', system });

test('on Windows a tool is found through PATHEXT, in PATH order', (t) => {
  const a = mkdtempSync(join(tmpdir(), 'win-a-'));
  const b = mkdtempSync(join(tmpdir(), 'win-b-'));
  t.after(() => { rmSync(a, { recursive: true, force: true }); rmSync(b, { recursive: true, force: true }); });
  writeFileSync(join(b, 'claude.cmd'), '');
  writeFileSync(join(b, 'codex.exe'), '');
  writeFileSync(join(a, 'codex.cmd'), '');
  const env = winEnv(`${a};;${b}`, { PATHEXT: '.COM;.EXE;.BAT;.CMD' });
  assert.equal(findCommand('claude', env), join(b, 'claude.cmd'));
  assert.equal(findCommand('codex', env), join(a, 'codex.cmd'), 'the first folder on PATH wins');
  assert.equal(findCommand('opencode', env), null);
  assert.equal(findCommand('claude', winEnv(b)), join(b, 'claude.cmd'), 'the usual extensions when PATHEXT is not set');
  // The Mac: ':' between folders, and only an executable file counts.
  writeFileSync(join(a, 'claude'), '');
  assert.equal(findCommand('claude', { ...winEnv(a), platform: 'darwin' }), null, 'not executable');
  chmodSync(join(a, 'claude'), 0o755);
  assert.equal(findCommand('claude', { ...winEnv(`/nowhere:${a}`), platform: 'darwin' }), join(a, 'claude'));
});

test("npm's .cmd shims run through the command prompt only with safe arguments; an .exe runs directly", () => {
  const args = ['mcp', 'add', '--transport', 'http', '--scope', 'user', 'brainai', 'http://localhost:3100/mcp'];
  assert.deepEqual(commandLine('C:\\Users\\Ana María\\AppData\\Roaming\\npm\\claude.cmd', args, 'win32'),
    { file: '"C:\\Users\\Ana María\\AppData\\Roaming\\npm\\claude.cmd"', args, shell: true });
  assert.deepEqual(commandLine('C:\\Tools\\codex.exe', ['mcp', 'get', 'brainai', '--json'], 'win32'), { file: 'C:\\Tools\\codex.exe', args: ['mcp', 'get', 'brainai', '--json'], shell: false });
  for (const bad of ['a&calc', 'two words', '%PATH%', '"x', 'a^b', 'a|b', 'a>b', '!x']) assert.equal(commandLine('C:\\npm\\claude.cmd', ['mcp', bad], 'win32'), null, bad);
  assert.equal(commandLine('C:\\odd"dir\\claude.cmd', ['mcp'], 'win32'), null, 'a quote in the path');
  assert.equal(commandLine('C:\\100%\\claude.bat', ['mcp'], 'win32'), null, 'a percent sign in the path');
  assert.deepEqual(commandLine('/opt/homebrew/bin/claude', ['mcp', 'list'], 'darwin'), { file: '/opt/homebrew/bin/claude', args: ['mcp', 'list'], shell: false });
});

test("on Windows a tool's environment carries the system variables it needs and nothing else from the server", () => {
  const system = {
    USERPROFILE: 'C:\\Users\\Ana', HOMEDRIVE: 'C:', HOMEPATH: '\\Users\\Ana', APPDATA: 'C:\\Users\\Ana\\AppData\\Roaming',
    LOCALAPPDATA: 'C:\\Users\\Ana\\AppData\\Local', TEMP: 'C:\\Temp', TMP: 'C:\\Temp', SystemRoot: 'C:\\Windows',
    windir: 'C:\\Windows', COMSPEC: 'C:\\Windows\\System32\\cmd.exe', PATHEXT: '.EXE;.CMD', APP_SECRET: 'never', OTHER: 'no',
  };
  const { APP_SECRET: _s, OTHER: _o, ...needed } = system;
  assert.deepEqual(childEnv({ ...winEnv('C:\\a;C:\\b', system), extraEnv: { FAKE: '1' } }), { ...needed, Path: 'C:\\a;C:\\b', FAKE: '1' });
  assert.deepEqual(childEnv({ ...winEnv('/usr/bin', system), platform: 'darwin', home: '/Users/ana' }), { PATH: '/usr/bin', HOME: '/Users/ana' });
});

test("Codex's config.toml keeps its Windows line ends when BrainAI approves its tools", () => {
  const text = 'model = "x"\r\n\r\n[mcp_servers.brainai]\r\nurl = "http://localhost:3100/mcp"\r\n\r\n[other]\r\nk = 1\r\n';
  const out = withCodexApproval(text)!;
  assert.equal(out, 'model = "x"\r\n\r\n[mcp_servers.brainai]\r\nurl = "http://localhost:3100/mcp"\r\ndefault_tools_approval_mode = "approve"\r\n\r\n[other]\r\nk = 1\r\n');
  assert.equal(withCodexApproval(out), null, 'once only');
  assert.equal(withCodexApproval('model = "x"\n'), null, 'no brainai table: nothing to do');
});
