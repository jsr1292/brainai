import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { looksLikeSecret } from '../memory/secrets.js';
import { appOfGrant, currentSetupVersion, loadSetupOverlay, SETUP_HASH, SETUP_VERSION, setupApps, setupText } from './texts.js';

const all = (lang: 'en' | 'es' = 'en') => setupApps().map((a) => ({ app: a, text: setupText(a.slug, 'https://HOST/mcp', undefined, lang) }));
const hashOf = (rows: { app: { slug: string }; text: string }[]) => createHash('sha256').update(JSON.stringify(rows.map((x) => [x.app.slug, x.text]))).digest('hex');

test("the texts' hash (English then Spanish) is pinned to the version", () => {
  const hash = hashOf([...all('en'), ...all('es')]);
  assert.equal(hash, SETUP_HASH, `A setup text changed: raise SETUP_VERSION and set SETUP_HASH to ${hash}`);
});

test('the English texts are byte for byte what version 2 had (only the number moved)', () => {
  const v2 = setupApps().map((a) => ({ app: a, text: setupText(a.slug, 'https://HOST/mcp', { version: 2, extra: {} }) }));
  assert.equal(hashOf(v2), '00f4311ac905e1625bdee2035015c3b8d62e664c9a09505f7d4a10eb2319bd1c');
});

test('every app has a Spanish text, with the same address, tool names, setup number and shape as the English one', () => {
  const en = all('en'), es = all('es');
  const tools = (s: string) => [...new Set(s.match(/\b(?:load_profile|project_brief|recall|read_page|write_page|edit_page_section|remember)\b/g) ?? [])].sort();
  for (const [i, { app, text }] of es.entries()) {
    const e = en[i]!.text;
    assert.notEqual(text, e, app.slug);
    assert.match(text, /\(host\)/, app.slug);
    assert.deepEqual(tools(text), tools(e), app.slug);
    assert.equal(text.includes('How this brain is organised'), e.includes('How this brain is organised'), app.slug);
    assert.equal(/^<!-- brain setup \d+ -->\n[\s\S]*\n<!-- \/brain setup -->$/.test(text), app.file, app.slug);
    assert.equal(text.split('\n').length, e.split('\n').length, app.slug);
    assert.equal(looksLikeSecret(text), null, app.slug);
    assert.doesNotMatch(text, /Acme|owner|\bthe brain\b/, app.slug);
    if (app.reports === false) assert.doesNotMatch(text, /load_profile/, app.slug);
    else assert.ok(text.replace(/\n<!-- \/brain setup -->$/, '').trimEnd().endsWith(`Cuando llames a load_profile, pasa setup: ${SETUP_VERSION}.`), app.slug);
  }
  for (const slug of ['claude', 'chatgpt', 'grok']) assert.ok(setupText(slug, 'https://memory.example.com/mcp', undefined, 'es').length <= 1500, slug);
});

test('an overlay lines and number apply in Spanish too; an unknown language is English', () => {
  const o = { version: 7, extra: { codex: ['- Mi línea.'] } };
  const es = setupText('codex', 'https://HOST/mcp', o, 'es');
  assert.match(es, /^<!-- brain setup 7 -->\n/);
  assert.match(es, /- Mi línea\.\n\nCuando llames a load_profile, pasa setup: 7\./);
  assert.equal(setupText('codex', 'https://HOST/mcp', o, 'xx' as never), setupText('codex', 'https://HOST/mcp', o));
});

test('every text ends by asking for its setup number, and file texts are wrapped', () => {
  for (const { app, text } of all()) {
    const body = app.file ? text.replace(/^<!-- brain setup \d+ -->\n/, '').replace(/\n<!-- \/brain setup -->$/, '') : text;
    if (app.reports === false) assert.doesNotMatch(body, /load_profile/, app.slug);
    else assert.ok(body.trimEnd().endsWith(`When you call load_profile, pass setup: ${SETUP_VERSION}.`), app.slug);
    if (app.file) assert.match(text, new RegExp(`^<!-- brain setup ${SETUP_VERSION} -->\\n[\\s\\S]*\\n<!-- /brain setup -->$`), app.slug);
  }
});

test('no text holds a secret-looking string, the owner\'s name, or Acme', () => {
  for (const { app, text } of all()) {
    assert.equal(looksLikeSecret(text), null, app.slug);
    assert.doesNotMatch(text, /Acme|owner/, app.slug);
  }
});

test("the chat apps' texts fit ChatGPT's 1500-character field", () => {
  for (const slug of ['claude', 'chatgpt', 'grok']) assert.ok(setupText(slug, 'https://memory.example.com/mcp').length <= 1500, slug);
});

test('the apps, in order', () => {
  assert.deepEqual(setupApps().map((a) => a.slug), ['claude', 'chatgpt', 'grok', 'grok-build', 'claude-code', 'codex', 'opencode', 'gemini-cli']);
  assert.throws(() => setupText('nope', 'https://x/mcp'));
});

test('appOfGrant guesses the app from the connection name', () => {
  const cases: [string, string | null][] = [['Claude Code', 'claude-code'], ['WorkCodex', 'codex'], ['Grok Build', 'grok-build'], ['Grok', 'grok'],
    ['ChatGPT', 'chatgpt'], ['Claude', 'claude'], ['OpenCode', 'opencode'], ['My laptop', null]];
  for (const [name, slug] of cases) assert.equal(appOfGrant(name), slug, name);
});

// ---- The owner's overlay (open source O1) ----

test('the generic texts carry no owner workflow lines', () => {
  for (const { text } of all()) assert.doesNotMatch(text, /minipc|Claude Code hands you a task/);
});

test('an overlay adds its lines before the closing ask, per app and for every coding app, and sets the setup number', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'overlay-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.equal(loadSetupOverlay(dir), undefined, 'no file: no overlay');
  writeFileSync(join(dir, 'setup.json'), JSON.stringify({ version: 7, extra: { coding: ['- Push to the backup remote.'], codex: ['- Skip memory for plan tasks.'] } }));
  const o = loadSetupOverlay(dir)!;
  assert.equal(currentSetupVersion(o), 7);
  assert.equal(currentSetupVersion(undefined), SETUP_VERSION);
  const codex = setupText('codex', 'https://HOST/mcp', o);
  assert.match(codex, /- Skip memory for plan tasks\.\n- Push to the backup remote\.\n\nWhen you call load_profile, pass setup: 7\.|- Push to the backup remote\.\n- Skip memory for plan tasks\.\n\nWhen you call load_profile, pass setup: 7\./);
  assert.doesNotMatch(setupText('chatgpt', 'https://HOST/mcp', o), /backup remote/);
  assert.match(setupText('chatgpt', 'https://HOST/mcp', o), /pass setup: 7\./);
  writeFileSync(join(dir, 'setup.json'), '{ not json');
  assert.throws(() => loadSetupOverlay(dir), /setup\.json/);
});

test('the brain-setup marker carries the overlay number for every file app, even when a line mentions another (O1 review)', () => {
  const o = { version: 9, extra: { coding: ['- An example: pass setup: 4. is not ours.'] } };
  for (const slug of ['grok-build', 'claude-code', 'codex', 'opencode', 'gemini-cli']) assert.match(setupText(slug, 'https://HOST/mcp', o), /^<!-- brain setup 9 -->/, slug);
});
