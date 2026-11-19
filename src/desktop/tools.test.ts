import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, symlinkSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fakeHome, type FakeHome } from '../testing/fakeTools.js';
import { setupText } from '../setup/texts.js';
import { backupFiles, brainPluginInstalled, tracesOfThisBrain, childEnv, commandLine, connect, disconnect, findCommand, toolStates, withCodexApproval, type Tool, type ToolEnv } from './tools.js';
import { findBlock } from './rulesBlock.js';

const URL_ = 'http://localhost:3100/mcp';
const HOME_BRAINAI = 'https://memory.example.com/mcp';

function world(t: TestContext, tools?: Parameters<typeof fakeHome>[0]): { f: FakeHome; env: ToolEnv } {
  const f = fakeHome(tools);
  t.after(() => f.cleanup());
  const env: ToolEnv = {
    home: f.home, apps: f.apps, mcpUrl: URL_,
    path: `${f.bin}:${dirname(process.execPath)}:/usr/bin:/bin`,
    rules: (slug) => setupText(slug, URL_),
    // Never the real %APPDATA% or ~/Library/Application Support/Claude.
    system: {}, claudeConfig: join(f.home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'),
  };
  return { f, env };
}
const stateOf = async (env: ToolEnv, id: string) => (await toolStates(env)).find((s) => s.id === id)!;

test('tools that are not installed are listed as such, and nothing is called', async (t) => {
  const { f, env } = world(t, []);
  const states = await toolStates(env);
  assert.deepEqual(states.map((s) => [s.id, s.installed]), [['claude-code', false], ['codex', false], ['opencode', false], ['cursor', false], ['gemini', false], ['claude-desktop', false]]);
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

test('Claude Code: with the BrainAI plugin installed, Connect adds no server entry, rules or reminders of its own', async (t) => {
  const { f, env } = world(t);
  f.write('.claude/CLAUDE.md', '# Mine\n');
  f.write('.claude/plugins/installed_plugins.json', JSON.stringify({ version: 2, plugins: { 'brainai@brainai-plugins': [{ scope: 'user', version: '1.4.0' }] } }));
  assert.equal(brainPluginInstalled(env), true);
  const r = await connect('claude-code', env, {});
  assert.equal(r.ok, true);
  assert.match((r as { signIn: string }).signIn, /plugin is already installed/);
  assert.ok(!f.calls().some((c) => c.includes(' add ')));
  assert.deepEqual(f.servers('claude'), {});
  assert.equal(f.read('.claude/CLAUDE.md'), '# Mine\n');
  // Another plugin, or an unreadable record, does not count.
  f.write('.claude/plugins/installed_plugins.json', JSON.stringify({ plugins: { 'github@claude-plugins-official': [{}] } }));
  assert.equal(brainPluginInstalled(env), false);
  f.write('.claude/plugins/installed_plugins.json', 'not json');
  assert.equal(brainPluginInstalled(env), false);
});

test('a tool already on another BrainAI is left alone unless the owner presses Replace, and a memory server is never touched', async (t) => {
  const { f, env } = world(t);
  // The owner's own Mac: the home BrainAI as "memory", and its rules block.
  f.write('.fake-claude.json', JSON.stringify({ memory: HOME_BRAINAI }));
  const home = `# Mine\n\n${setupText('claude-code', HOME_BRAINAI)}\n`;
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

// ---- Gemini CLI (untested against a real one): ~/.gemini/settings.json, mcpServers.brainai.httpUrl, ~/.gemini/GEMINI.md ----
const gemWorld = (t: TestContext) => world(t, ['claude', 'codex', 'opencode', 'gemini']);

test('Gemini CLI: found on the PATH only; Connect adds mcpServers.brainai.httpUrl to an empty home, with the rules and the sign-in step', async (t) => {
  const none = world(t, []);
  assert.equal((await stateOf(none.env, 'gemini')).installed, false, 'no gemini command: not installed');
  none.f.write('.gemini/settings.json', '{}');
  assert.equal((await stateOf(none.env, 'gemini')).installed, false, 'a ~/.gemini folder alone is not enough');
  const { f, env } = gemWorld(t);
  assert.deepEqual(await stateOf(env, 'gemini'), { id: 'gemini', name: 'Gemini CLI', installed: true, state: 'not-connected', signIn: 'In Gemini CLI, type /mcp auth brainai; your browser asks you to Allow.', hooks: 'none' });
  const r = await connect('gemini', env, {});
  assert.deepEqual(r, { ok: true, signIn: 'In Gemini CLI, type /mcp auth brainai; your browser asks you to Allow.' });
  assert.deepEqual(JSON.parse(f.read('.gemini/settings.json')!), { mcpServers: { brainai: { httpUrl: URL_ } } });
  assert.equal(findBlock(f.read('.gemini/GEMINI.md')!)!.host, 'localhost:3100');
  assert.equal((await stateOf(env, 'gemini')).state, 'connected');
  assert.equal(f.read('.gemini/hooks.json'), null, 'no save reminders for Gemini CLI');
  assert.deepEqual(f.calls().filter((c) => c.startsWith('gemini')), [], 'the gemini command itself is never run');
});

test('Gemini CLI: other servers and keys stay, a backup of the original is written once, and Connect twice changes nothing', async (t) => {
  const { f, env } = gemWorld(t);
  const original = JSON.stringify({ theme: 'Default', mcpServers: { github: { command: 'gh-mcp', args: ['x'] }, memory: { httpUrl: 'https://other.example/mcp' } }, general: { vimMode: true } }, null, 2);
  f.write('.gemini/settings.json', original);
  f.write('.gemini/GEMINI.md', '# Mine\nBe brief.\n');
  assert.equal((await connect('gemini', env, {})).ok, true);
  const cfg = JSON.parse(f.read('.gemini/settings.json')!);
  assert.deepEqual(cfg.mcpServers, { github: { command: 'gh-mcp', args: ['x'] }, memory: { httpUrl: 'https://other.example/mcp' }, brainai: { httpUrl: URL_ } });
  assert.equal(cfg.theme, 'Default');
  assert.deepEqual(cfg.general, { vimMode: true });
  assert.equal(f.read('.gemini/settings.json.brainai-backup'), original, 'a backup first');
  assert.equal(f.read('.gemini/GEMINI.md.brainai-backup'), '# Mine\nBe brief.\n');
  assert.ok(f.read('.gemini/GEMINI.md')!.startsWith('# Mine\nBe brief.\n'));
  const after = f.read('.gemini/settings.json');
  assert.equal((await connect('gemini', env, {})).ok, true);
  assert.equal(f.read('.gemini/settings.json'), after, 'already present: unchanged');
  assert.equal(f.read('.gemini/settings.json.brainai-backup'), original, 'the first backup is kept');
});

test('Gemini CLI: Disconnect takes out only brainai and BrainAI\'s rules', async (t) => {
  const { f, env } = gemWorld(t);
  f.write('.gemini/settings.json', JSON.stringify({ theme: 'Default', mcpServers: { github: { command: 'gh-mcp' } } }));
  f.write('.gemini/GEMINI.md', '# Mine\n');
  await connect('gemini', env, {});
  const r = await disconnect('gemini', env);
  assert.equal(r.ok, true);
  assert.deepEqual(JSON.parse(f.read('.gemini/settings.json')!), { theme: 'Default', mcpServers: { github: { command: 'gh-mcp' } } });
  assert.equal(f.read('.gemini/GEMINI.md'), '# Mine\n');
  assert.equal((await stateOf(env, 'gemini')).state, 'not-connected');
  // a brainai entry of another BrainAI is left alone
  f.write('.gemini/settings.json', JSON.stringify({ mcpServers: { brainai: { httpUrl: HOME_BRAINAI } } }));
  const other = await disconnect('gemini', env);
  assert.equal(other.ok, false);
  assert.equal(JSON.parse(f.read('.gemini/settings.json')!).mcpServers.brainai.httpUrl, HOME_BRAINAI);
});

test('Gemini CLI: Disconnect with no settings file creates none', async (t) => {
  const { f, env } = gemWorld(t);
  await disconnect('gemini', env);
  assert.equal(f.read('.gemini/settings.json'), null);
});

test('Gemini CLI: another BrainAI asks for Replace; an SSE-style entry (url only) is not taken for ours', async (t) => {
  const { f, env } = gemWorld(t);
  f.write('.gemini/settings.json', JSON.stringify({ mcpServers: { brainai: { httpUrl: HOME_BRAINAI } } }));
  const s = await stateOf(env, 'gemini');
  assert.equal(s.state, 'other-brainai');
  assert.match(s.detail!, /memory\.example\.com/);
  assert.equal((await connect('gemini', env, {})).ok, false);
  assert.equal((await connect('gemini', env, { replace: true })).ok, true);
  assert.equal(JSON.parse(f.read('.gemini/settings.json')!).mcpServers.brainai.httpUrl, URL_);
  f.write('.gemini/settings.json', JSON.stringify({ mcpServers: { brainai: { url: URL_ } } }));
  assert.equal((await stateOf(env, 'gemini')).state, 'other-brainai', 'url is the SSE transport');
});

test('Gemini CLI: a settings.json that is not plain JSON is refused and left untouched', async (t) => {
  for (const text of ['{ // mine\n "theme": "x" }\n', '{ "theme": ', '[1]', '{ "mcpServers": [] }']) {
    const { f, env } = gemWorld(t);
    f.write('.gemini/settings.json', text);
    const r = await connect('gemini', env, {});
    assert.equal(r.ok, false, text);
    assert.match((r as { reason: string }).reason, /not plain JSON.*Set up an app › Gemini CLI/);
    assert.equal(f.read('.gemini/settings.json'), text);
    assert.equal(f.read('.gemini/settings.json.brainai-backup'), null);
    assert.equal(f.read('.gemini/GEMINI.md'), null, 'no rules either');
    assert.equal((await disconnect('gemini', env)).ok, false);
    assert.equal(await tracesOfThisBrain('gemini', env), 'unreadable');
  }
});

test('Gemini CLI: its files are among those Remove BrainAI keeps a backup of', async (t) => {
  const { f, env } = gemWorld(t);
  f.write('.gemini/settings.json', '{}');
  await connect('gemini', env, {});
  assert.ok(backupFiles(env).includes(join(f.home, '.gemini', 'settings.json.brainai-backup')));
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
  const home = `# Mine\n\n${setupText('claude-code', HOME_BRAINAI)}\n`;
  f.write('.claude/CLAUDE.md', home);
  assert.equal((await connect('claude-code', env, { replace: true })).ok, true);
  assert.equal((await disconnect('claude-code', env)).ok, true);
  assert.equal(f.read('.claude/CLAUDE.md.brainai-backup'), home, 'the original is kept');
});

const cannotChmod = process.platform === 'win32' || process.getuid?.() === 0;

test('a file BrainAI cannot write ends in a clear message, not a half-done tool', { skip: cannotChmod }, async (t) => {
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

// ---- Claude's desktop app: a stdio entry in claude_desktop_config.json that runs the bridge ----

const CLAUDE_CONFIG = 'Library/Application Support/Claude/claude_desktop_config.json';
const OTHER_CONFIG = { mcpServers: { other: { command: 'x' } }, globalShortcut: 'Alt+Space' };

/** A world with Claude's app "installed", a made-up bridge (real files, so its paths exist) and a fake key issuer. */
function claudeWorld(t: TestContext) {
  const w = world(t, []);
  mkdirSync(join(w.f.apps, 'Claude.app'), { recursive: true });
  const dir = mkdtempSync(join(tmpdir(), 'brainai-bridge-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cli = join(dir, 'dist-cli.js');
  const node = join(dir, 'node-bin');
  writeFileSync(cli, '');
  writeFileSync(node, '');
  const dataDir = join(dir, 'data');
  mkdirSync(dataDir);
  const log = { issued: 0, revoked: [] as string[] };
  w.env.bridge = { node, cli, dataDir, portFile: join(dir, 'brainai.json') };
  w.env.issueKey = () => { log.issued++; return { grantId: `grant-${log.issued}`, token: `tok-${log.issued}` }; };
  w.env.revokeKey = (id) => { log.revoked.push(id); };
  w.env.keyLive = (id) => !log.revoked.includes(id);
  const config = () => JSON.parse(w.f.read(CLAUDE_CONFIG)!) as { mcpServers: Record<string, unknown> } & Record<string, unknown>;
  return { ...w, dir, log, config, keyFile: join(dataDir, 'claude-desktop-key'), bridge: w.env.bridge };
}

test("Claude (desktop app): found by its app or its settings folder", async (t) => {
  const none = world(t, []);
  assert.equal((await stateOf(none.env, 'claude-desktop')).installed, false);
  none.f.write(CLAUDE_CONFIG, '{}');
  assert.equal((await stateOf(none.env, 'claude-desktop')).installed, true, 'the config folder');
  const app = claudeWorld(t);
  const s = await stateOf(app.env, 'claude-desktop');
  assert.deepEqual([s.installed, s.state, s.name], [true, 'not-connected', 'Claude (desktop app)']);
});

test("Claude (desktop app): connect adds the bridge entry beside the owner's own servers, with a key of its own", async (t) => {
  const c = claudeWorld(t);
  const original = JSON.stringify(OTHER_CONFIG);
  c.f.write(CLAUDE_CONFIG, original);
  const r = await connect('claude-desktop', c.env, {});
  assert.equal(r.ok, true);
  assert.match((r as { signIn: string }).signIn, /Quit Claude completely.*open it again/);
  const cfg = c.config();
  assert.deepEqual(cfg.mcpServers.brainai, { command: c.bridge.node, args: [c.bridge.cli, 'claude-bridge'], env: { BRAINAI_DATA_DIR: c.bridge.dataDir, BRAINAI_PORT_FILE: c.bridge.portFile } });
  assert.deepEqual(cfg.mcpServers.other, { command: 'x' });
  assert.equal(cfg.globalShortcut, 'Alt+Space');
  assert.equal(c.f.read(`${CLAUDE_CONFIG}.brainai-backup`), original, 'a backup of the original');
  assert.equal(c.log.issued, 1);
  assert.deepEqual(JSON.parse(readFileSync(c.keyFile, 'utf8')), { grant: 'grant-1', token: 'tok-1' });
  assert.equal(statSync(c.keyFile).mode & 0o777, 0o600);
  assert.equal((await stateOf(c.env, 'claude-desktop')).state, 'connected');
  // The token is in the key file only, never in Claude's config.
  assert.ok(!c.f.read(CLAUDE_CONFIG)!.includes('tok-1'));
});

test("Claude (desktop app): settings that are not plain JSON are refused, untouched, and no key is issued", async (t) => {
  const c = claudeWorld(t);
  c.f.write(CLAUDE_CONFIG, '{ // my notes\n "mcpServers": {} }');
  const r = await connect('claude-desktop', c.env, {});
  assert.equal(r.ok, false);
  assert.match((r as { reason: string }).reason, /not plain JSON/);
  assert.equal(c.f.read(CLAUDE_CONFIG), '{ // my notes\n "mcpServers": {} }');
  assert.equal(c.log.issued, 0);
  assert.equal(existsSync(c.keyFile), false);
});

test("Claude (desktop app): if the entry cannot be written the key is taken back", { skip: cannotChmod }, async (t) => {
  const c = claudeWorld(t);
  c.f.write(CLAUDE_CONFIG, JSON.stringify(OTHER_CONFIG));
  chmodSync(join(c.f.home, CLAUDE_CONFIG, '..'), 0o500);
  chmodSync(join(c.f.home, CLAUDE_CONFIG), 0o400);
  let r;
  try { r = await connect('claude-desktop', c.env, {}); } finally { chmodSync(join(c.f.home, CLAUDE_CONFIG, '..'), 0o700); }
  assert.equal(r.ok, false);
  assert.deepEqual(c.log.revoked, ['grant-1']);
  assert.equal(existsSync(c.keyFile), false);
});

test("Claude (desktop app): an entry whose program is gone needs connecting again; another BrainAI's entry is left unless Replace", async (t) => {
  const c = claudeWorld(t);
  const entry = (node: string, cli: string) => JSON.stringify({ mcpServers: { brainai: { command: node, args: [cli, 'claude-bridge'] } } });
  // The app was moved: the paths in the entry no longer exist.
  c.f.write(CLAUDE_CONFIG, entry('/gone/node', '/gone/dist/cli.js'));
  let s = await stateOf(c.env, 'claude-desktop');
  assert.deepEqual([s.state, s.detail], ['other-brainai', 'needs connecting again']);
  assert.equal((await connect('claude-desktop', c.env, {})).ok, false);
  assert.equal((await connect('claude-desktop', c.env, { replace: true })).ok, true);
  assert.equal((await stateOf(c.env, 'claude-desktop')).state, 'connected');
  // Another BrainAI's bridge that exists.
  const other = join(c.dir, 'other-cli.js');
  writeFileSync(other, '');
  c.f.write(CLAUDE_CONFIG, entry(c.bridge.node, other));
  s = await stateOf(c.env, 'claude-desktop');
  assert.equal(s.state, 'other-brainai');
  assert.equal((await disconnect('claude-desktop', c.env)).ok, false, 'left as it is');
  assert.equal(c.config().mcpServers.brainai !== undefined, true);
  assert.equal((await connect('claude-desktop', c.env, { replace: true })).ok, true);
  assert.equal((c.config().mcpServers.brainai as { args: string[] }).args[0], c.bridge.cli);
});

test("Claude (desktop app): disconnect removes only brainai, revokes the stored key and deletes its file", async (t) => {
  const c = claudeWorld(t);
  c.f.write(CLAUDE_CONFIG, JSON.stringify(OTHER_CONFIG));
  await connect('claude-desktop', c.env, {});
  const r = await disconnect('claude-desktop', c.env);
  assert.equal(r.ok, true);
  const cfg = c.config();
  assert.deepEqual(cfg.mcpServers, { other: { command: 'x' } });
  assert.equal(cfg.globalShortcut, 'Alt+Space');
  assert.deepEqual(c.log.revoked, ['grant-1']);
  assert.equal(existsSync(c.keyFile), false);
  assert.equal((await stateOf(c.env, 'claude-desktop')).state, 'not-connected');
  assert.ok(backupFiles(c.env).includes(join(c.f.home, `${CLAUDE_CONFIG}.brainai-backup`)));
});

test("disconnect asks to end a tool's sign-in by its name, except for Claude's desktop app, whose key is revoked already", async (t) => {
  const asked: string[] = [];
  const c = claudeWorld(t);
  c.env.endSignIns = (name) => { asked.push(name); return 2; };
  await connect('claude-desktop', c.env, {});
  assert.deepEqual(await disconnect('claude-desktop', c.env), { ok: true, signIn: '', ended: 0 });
  const { f, env } = world(t);
  env.endSignIns = c.env.endSignIns;
  await connect('claude-code', env, {});
  assert.deepEqual(await disconnect('claude-code', env), { ok: true, signIn: '', ended: 2 });
  assert.deepEqual(asked, ['Claude Code']);
  assert.deepEqual(f.servers('claude'), {});
});

test("Claude (desktop app): connected means the key works: a revoked or deleted key needs connecting again, and Connect fixes it without Replace", async (t) => {
  const c = claudeWorld(t);
  await connect('claude-desktop', c.env, {});
  c.env.revokeKey!('grant-1'); // revoked from the Connections page
  let s = await stateOf(c.env, 'claude-desktop');
  assert.deepEqual([s.state, s.detail], ['not-connected', 'needs connecting again']);
  assert.equal((await connect('claude-desktop', c.env, {})).ok, true);
  assert.equal((await stateOf(c.env, 'claude-desktop')).state, 'connected');
  assert.equal(JSON.parse(readFileSync(c.keyFile, 'utf8')).grant, 'grant-2');
  // The key file deleted by hand.
  rmSync(c.keyFile);
  s = await stateOf(c.env, 'claude-desktop');
  assert.deepEqual([s.state, s.detail], ['not-connected', 'needs connecting again']);
  assert.equal((await connect('claude-desktop', c.env, {})).ok, true);
  assert.equal((await stateOf(c.env, 'claude-desktop')).state, 'connected');
  // An unreadable key file.
  writeFileSync(c.keyFile, 'not json');
  assert.equal((await stateOf(c.env, 'claude-desktop')).state, 'not-connected');
});

test("Claude (desktop app): this brain's own entry whose program moved is its own: Connect, Disconnect replace or remove it, another brain's is not", async (t) => {
  const c = claudeWorld(t);
  const own = { mcpServers: { brainai: { command: '/gone/node', args: ['/gone/cli.js', 'claude-bridge'], env: { BRAINAI_DATA_DIR: c.bridge.dataDir } } } };
  c.f.write(CLAUDE_CONFIG, JSON.stringify(own));
  let s = await stateOf(c.env, 'claude-desktop');
  assert.deepEqual([s.state, s.detail], ['not-connected', 'needs connecting again']);
  assert.equal((await disconnect('claude-desktop', c.env)).ok, true);
  assert.deepEqual(c.config().mcpServers, {});
  c.f.write(CLAUDE_CONFIG, JSON.stringify(own));
  assert.equal((await connect('claude-desktop', c.env, {})).ok, true, 'no Replace needed');
  assert.equal((await stateOf(c.env, 'claude-desktop')).state, 'connected');
  const theirs = { mcpServers: { brainai: { command: '/gone/node', args: ['/gone/cli.js', 'claude-bridge'], env: { BRAINAI_DATA_DIR: '/elsewhere/data' } } } };
  c.f.write(CLAUDE_CONFIG, JSON.stringify(theirs));
  s = await stateOf(c.env, 'claude-desktop');
  assert.equal(s.state, 'other-brainai');
  assert.equal((await connect('claude-desktop', c.env, {})).ok, false);
});

test("Claude (desktop app): this brain's own entry is its own whatever the spelling of its paths: case on Windows, a symlink on the Mac", async (t) => {
  // Windows: the same folders spelled in another case.
  const w = claudeWorld(t);
  w.env.platform = 'win32';
  await connect('claude-desktop', w.env, {});
  const entry = w.config().mcpServers.brainai as { command: string; args: string[]; env: Record<string, string> };
  w.f.write(CLAUDE_CONFIG, JSON.stringify({ mcpServers: { brainai: { ...entry, args: [entry.args[0].toUpperCase(), 'claude-bridge'], env: { ...entry.env, BRAINAI_DATA_DIR: w.bridge.dataDir.toUpperCase() } }, other: { command: 'x' } } }));
  assert.notEqual((await stateOf(w.env, 'claude-desktop')).state, 'other-brainai');
  assert.equal(await tracesOfThisBrain('claude-desktop', w.env), 'yes');
  assert.equal((await disconnect('claude-desktop', w.env)).ok, true);
  assert.deepEqual(w.config().mcpServers, { other: { command: 'x' } });
  assert.equal(existsSync(w.keyFile), false);
  // The Mac: a symlink to the bridge program, and to the data folder, are the same place.
  const c = claudeWorld(t);
  c.env.platform = 'darwin';
  await connect('claude-desktop', c.env, {});
  const link = join(c.dir, 'link-cli.js');
  symlinkSync(c.bridge.cli, link);
  const dataLink = join(c.dir, 'data-link');
  symlinkSync(c.bridge.dataDir, dataLink);
  const own = c.config().mcpServers.brainai as { command: string; env: Record<string, string> };
  c.f.write(CLAUDE_CONFIG, JSON.stringify({ mcpServers: { brainai: { ...own, args: [link, 'claude-bridge'], env: { ...own.env, BRAINAI_DATA_DIR: dataLink } } } }));
  assert.equal((await stateOf(c.env, 'claude-desktop')).state, 'connected');
  // Another data folder is another BrainAI, even with a program of its own.
  const other = join(c.dir, 'other-cli.js');
  writeFileSync(other, '');
  const elsewhere = join(c.dir, 'elsewhere');
  mkdirSync(elsewhere);
  c.f.write(CLAUDE_CONFIG, JSON.stringify({ mcpServers: { brainai: { ...own, args: [other, 'claude-bridge'], env: { ...own.env, BRAINAI_DATA_DIR: elsewhere } } } }));
  assert.equal((await stateOf(c.env, 'claude-desktop')).state, 'other-brainai');
});

test("Claude (desktop app): another BrainAI's entry is left alone, but our own leftover key is revoked and deleted", async (t) => {
  const c = claudeWorld(t);
  await connect('claude-desktop', c.env, {});
  const other = join(c.dir, 'other-cli.js');
  writeFileSync(other, '');
  const theirs = JSON.stringify({ mcpServers: { brainai: { command: c.bridge.node, args: [other, 'claude-bridge'], env: { BRAINAI_DATA_DIR: join(c.dir, 'elsewhere') } } } });
  c.f.write(CLAUDE_CONFIG, theirs);
  assert.equal((await stateOf(c.env, 'claude-desktop')).state, 'other-brainai');
  assert.equal((await disconnect('claude-desktop', c.env)).ok, false);
  assert.equal(c.f.read(CLAUDE_CONFIG), theirs);
  assert.equal(existsSync(c.keyFile), false);
  assert.deepEqual(c.log.revoked, ['grant-1']);
});

test("Claude (desktop app): a key file whose entry was removed by hand is still revoked and deleted by Disconnect", async (t) => {
  const c = claudeWorld(t);
  await connect('claude-desktop', c.env, {});
  c.f.write(CLAUDE_CONFIG, JSON.stringify({ mcpServers: {} }));
  assert.equal(await tracesOfThisBrain('claude-desktop', c.env), 'yes');
  assert.equal((await disconnect('claude-desktop', c.env)).ok, true);
  assert.deepEqual(c.log.revoked, ['grant-1']);
  assert.equal(existsSync(c.keyFile), false);
  assert.equal(await tracesOfThisBrain('claude-desktop', c.env), 'no');
});

test("Claude (desktop app): Connect is refused from a disk image or a translocated app, and nothing is issued", async (t) => {
  for (const where of ['/Volumes/BrainAI/BrainAI.app/Contents/node', '/private/var/folders/x/AppTranslocation/ABC/d/BrainAI.app/Contents/node']) {
    const c = claudeWorld(t);
    c.env.bridge = { ...c.bridge, node: where };
    const r = await connect('claude-desktop', c.env, {});
    assert.deepEqual(r, { ok: false, reason: 'Move BrainAI to Applications first, then connect Claude.' });
    assert.equal(c.log.issued, 0);
    assert.equal(c.f.read(CLAUDE_CONFIG), null);
  }
});

test('toolStates looks at the tools at the same time and keeps the order of the list', async (t) => {
  const { env } = world(t, []);
  let running = 0; let peak = 0;
  const fake = (id: string, delay: number, installed = true) => ({
    id, name: id, slug: id, signIn: '', installed: () => installed,
    server: async () => { running++; peak = Math.max(peak, running); await new Promise((r) => setTimeout(r, delay)); running--; return URL_; },
    rulesFile: () => null,
  }) as unknown as Tool;
  // The slowest comes first: with a sequential loop the order would still hold, but the peak would be 1.
  const tools = [fake('claude-code', 60), fake('codex', 10), fake('opencode', 0, false), fake('cursor', 30)];
  const states = await toolStates(env, tools);
  assert.deepEqual(states.map((s) => s.id), ['claude-code', 'codex', 'opencode', 'cursor']);
  assert.deepEqual(states.map((s) => s.installed), [true, true, false, true]);
  assert.equal(peak, 3, 'the three installed tools were looked at together');
});
