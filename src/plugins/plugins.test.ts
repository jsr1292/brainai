import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, realpathSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MARKETPLACE_NAME, PLUGIN_DIR, PLUGIN_NAME, URL_KEY, buildPlugins, compileHook } from './buildPlugins.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (...p: string[]) => readFileSync(join(repoRoot, ...p), 'utf8');
const version = (JSON.parse(read('package.json')) as { version: string }).version;

// Real path: a hook only runs its main when started by its resolved path (macOS temp folders are symlinks).
const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'plugins-test-')));
buildPlugins(tmp);
test.after(() => rmSync(tmp, { recursive: true, force: true }));
const plugin = join(tmp, PLUGIN_DIR);
const readJson = (file: string) => JSON.parse(readFileSync(file, 'utf8')) as Record<string, any>;

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? filesUnder(join(dir, f)) : [join(dir, f)]));
}

test('the plugin manifest is valid JSON with the required fields, the package version and a user-set address', () => {
  const m = readJson(join(plugin, '.claude-plugin', 'plugin.json'));
  assert.equal(m.name, PLUGIN_NAME);
  assert.match(m.name, /^[a-z0-9-]+$/);
  assert.equal(m.version, version);
  assert.ok(m.description && m.author?.name && m.license === 'MIT');
  const opt = m.userConfig[URL_KEY];
  assert.deepEqual([opt.type, opt.required], ['string', true]);
  assert.ok(opt.title && opt.description);
  assert.deepEqual(Object.keys(opt).sort(), ['description', 'required', 'title', 'type']);
});

test('the MCP entry takes the address from the user setting, never a fixed one', () => {
  const mcp = readJson(join(plugin, '.mcp.json'));
  assert.deepEqual(mcp, { mcpServers: { brainai: { type: 'http', url: '${user_config.' + URL_KEY + '}' } } });
});

test('the marketplace file lists the plugin at its folder with the same name and version', () => {
  const mk = readJson(join(tmp, '.claude-plugin', 'marketplace.json'));
  assert.equal(mk.name, MARKETPLACE_NAME);
  assert.ok(mk.owner?.name);
  assert.equal(mk.plugins.length, 1);
  const [entry] = mk.plugins;
  assert.equal(entry.name, PLUGIN_NAME);
  assert.equal(entry.version, version);
  assert.equal(entry.source, `./${PLUGIN_DIR}`);
  assert.ok(existsSync(join(tmp, entry.source, '.claude-plugin', 'plugin.json')));
});

test('the hooks file wires the built scripts in exec form, and the scripts are the built sources', () => {
  const h = readJson(join(plugin, 'hooks', 'hooks.json')).hooks as Record<string, any[]>;
  assert.deepEqual(Object.keys(h).sort(), ['PreCompact', 'SessionStart', 'Stop']);
  const scripts = Object.values(h).flatMap((groups) => groups.flatMap((g) => g.hooks.map((x: any) => x)));
  for (const s of scripts) {
    assert.equal(s.type, 'command');
    assert.equal(s.command, 'node');
    assert.match(s.args[0], /^\$\{CLAUDE_PLUGIN_ROOT\}\/hooks\/memory-(start|save)\.mjs$/);
    assert.ok(existsSync(join(plugin, s.args[0].replace('${CLAUDE_PLUGIN_ROOT}/', ''))), `${s.args[0]} is missing`);
  }
  assert.equal(readFileSync(join(plugin, 'hooks', 'memory-start.mjs'), 'utf8'), compileHook(read('src', 'hooks', 'memoryStart.ts')));
  assert.equal(readFileSync(join(plugin, 'hooks', 'memory-save.mjs'), 'utf8'), compileHook(read('src', 'hooks', 'memorySave.ts')));
});

test('the built hooks run on their own, make no network calls and print what the tool expects', () => {
  for (const f of ['memory-start.mjs', 'memory-save.mjs']) {
    const code = readFileSync(join(plugin, 'hooks', f), 'utf8');
    assert.doesNotMatch(code, /\bfetch\s*\(|node:https?|node:net|node:dgram|node:tls|XMLHttpRequest|WebSocket/, `${f} touches the network`);
    for (const m of code.matchAll(/from\s+["']([^"']+)["']/g)) assert.match(m[1]!, /^node:/, `${f} imports ${m[1]}`);
  }
  const r = spawnSync(process.execPath, [join(plugin, 'hooks', 'memory-start.mjs')], {
    input: JSON.stringify({ cwd: join(tmp, 'wildlog'), source: 'startup' }), encoding: 'utf8',
  });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
  assert.equal(out.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.match(out.hookSpecificOutput.additionalContext, /load_profile/);
});

test('the harvest skill is the built-in one, and the memory skill carries the setup text with the address placeholder', () => {
  assert.equal(readFileSync(join(plugin, 'skills', 'harvest-session', 'SKILL.md'), 'utf8'), read('src', 'skills', 'builtin', 'harvest-session.md'));
  const skill = readFileSync(join(plugin, 'skills', 'brainai-memory', 'SKILL.md'), 'utf8');
  assert.match(skill, /^---\nname: brainai-memory\ndescription: .+\n---\n/);
  assert.ok(skill.includes('${user_config.' + URL_KEY + '}'));
  assert.match(skill, /load my profile from it/);
  assert.match(skill, /pass setup: \d+/);
  assert.doesNotMatch(skill, /brain\.example\.test/);
});

test('the plugin README names the install commands', () => {
  const readme = readFileSync(join(plugin, 'README.md'), 'utf8');
  assert.ok(readme.includes(`claude plugin install ${PLUGIN_NAME}@${MARKETPLACE_NAME}`));
  assert.ok(readme.includes(version));
});

test('nothing the build writes names the owner: no domain, personal name, e-mail or home folder', () => {
  const files = [...filesUnder(join(tmp, 'plugins')), join(tmp, '.claude-plugin', 'marketplace.json')];
  assert.ok(files.length >= 9);
  // Generic leaks only; the owner's own words are checked by the publish gate's private denylist.
  const owner = /\/Users\/|\/home\/[a-z]|memory\.(?!example\.com)[a-z0-9-]+\.[a-z]{2,}/i;
  for (const f of files) {
    const text = readFileSync(f, 'utf8');
    // The public repository's own address is the one name that belongs in a manifest (homepage) and in the install command.
    const m = owner.exec(text.replaceAll('jsr1292/brainai', '').replaceAll('github.com/jsr1292', ''));
    assert.equal(m, null, `${relative(tmp, f)} holds "${m?.[0]}"`);
  }
});

test('the committed plugins are what the build makes now (run npm run build:plugins after changing a source)', () => {
  const committed = [...filesUnder(join(repoRoot, 'plugins')), join(repoRoot, '.claude-plugin', 'marketplace.json')].map((f) => relative(repoRoot, f)).sort();
  const built = [...filesUnder(join(tmp, 'plugins')), join(tmp, '.claude-plugin', 'marketplace.json')].map((f) => relative(tmp, f)).sort();
  assert.deepEqual(committed, built);
  for (const f of built) assert.equal(read(f), readFileSync(join(tmp, f), 'utf8'), `${f} is out of date: run npm run build:plugins`);
});

test('claude plugin validate accepts the built plugin and marketplace when the claude CLI is installed', { skip: spawnSync('claude', ['--version']).status !== 0 }, () => {
  for (const dir of [plugin, tmp]) {
    const r = spawnSync('claude', ['plugin', 'validate', dir], { encoding: 'utf8', env: { ...process.env, CLAUDE_CONFIG_DIR: join(tmp, 'claude-config') } });
    assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  }
});
