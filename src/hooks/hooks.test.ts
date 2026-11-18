import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { projectNameFor, repoRoot, startContext } from './memoryStart.js';
import { readToolUses, saveNudge, WORK_THRESHOLD, NUDGE, compactNote, COMPACT_NOTE } from './memorySave.js';
import * as codexCursor from './memoryNudge.js';

test('the project name comes from the git repository folder, else the current folder', () => {
  assert.equal(projectNameFor('/Users/owner/Projects/brainai/src', '/Users/owner/Projects/brainai', '/Users/owner'), 'brainai');
  assert.equal(projectNameFor('/Users/owner/Projects/Casa Azul', null, '/Users/owner'), 'casa-azul');
  assert.equal(projectNameFor('/Users/owner/Projects/CsvMerge', null, '/Users/owner'), 'csvmerge');
  assert.equal(projectNameFor('/Users/owner', null, '/Users/owner'), null);
  assert.equal(projectNameFor('/', null, '/Users/owner'), null);
});

test('a session in a git worktree is named after the repository, not the branch', (t) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'memstart-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { stdio: 'ignore' });
  const repo = join(dir, 'wildlog');
  mkdirSync(repo);
  git(repo, 'init', '-q');
  git(repo, '-c', 'user.name=t', '-c', 'user.email=test@example.com', 'commit', '-q', '--allow-empty', '-m', 'init');
  git(repo, 'worktree', 'add', '-q', join(repo, '.worktrees', 'icloud-sync'), '-b', 'icloud-sync');
  git(repo, 'worktree', 'add', '-q', join(dir, 'feature-widgets'), '-b', 'feature-widgets');
  mkdirSync(join(repo, '.worktrees', 'icloud-sync', 'src'));
  assert.equal(projectNameFor(join(repo, '.worktrees', 'icloud-sync', 'src'), repoRoot(join(repo, '.worktrees', 'icloud-sync', 'src')), '/nowhere'), 'wildlog');
  assert.equal(projectNameFor(join(dir, 'feature-widgets'), repoRoot(join(dir, 'feature-widgets')), '/nowhere'), 'wildlog');
  assert.equal(repoRoot(repo), repo);
  assert.equal(repoRoot(dir), null);
});

test('a full clone kept in a .worktrees folder is named after the project folder above it', () => {
  assert.equal(projectNameFor('/Users/owner/Projects/inflow/.worktrees/feature-a/src', '/Users/owner/Projects/inflow/.worktrees/feature-a', '/Users/owner'), 'inflow');
  assert.equal(projectNameFor('/Users/owner/Projects/dossiers/.claude/worktrees/fix-a', '/Users/owner/Projects/dossiers/.claude/worktrees/fix-a', '/Users/owner'), 'dossiers');
});

test('accents are dropped from folder names, whichever way the system encodes them', () => {
  assert.equal(projectNameFor('/Users/owner/Projects/carpeta sin titulo'.replace('titulo', 'ti\u0301tulo'), null, '/Users/owner'), 'carpeta-sin-titulo');
  assert.equal(projectNameFor('/Users/owner/Projects/Programa Jardín', null, '/Users/owner'), 'programa-jardin');
});

test('a new session is told to load the profile and the briefing for its folder', () => {
  const text = startContext('startup', 'wildlog');
  assert.match(text, /load_profile/);
  assert.match(text, /project_brief with project "wildlog"/);
  assert.match(text, /closest name/);
  assert.match(text, /save this session's memories under project "wildlog"/i);
  assert.match(text, /tell the owner/);
  assert.doesNotMatch(startContext('startup', null), /project_brief with/);
  assert.match(startContext('compact', 'wildlog'), /compacted/);
});

const entry = (...names: string[]) => JSON.stringify({ type: 'assistant', message: { content: names.map((name) => ({ type: 'tool_use', name, input: {} })) } });

test('tool uses are read from the transcript in order, skipping lines it does not understand', () => {
  const transcript = [entry('Read', 'Edit'), 'not json', JSON.stringify({ type: 'user', message: { content: 'hi' } }), entry('mcp__memory__remember')].join('\n');
  assert.deepEqual(readToolUses(transcript), ['Read', 'Edit', 'mcp__memory__remember']);
});

test('after a stretch of work with no save, the stop is blocked once with a reminder', () => {
  const work = Array<string>(WORK_THRESHOLD).fill('Edit');
  const r = saveNudge({ tools: ['mcp__memory__load_profile', ...work], stopHookActive: false, nudgedAt: 0 });
  assert.equal(r.block, true);
  assert.equal(r.reason, NUDGE);
  assert.match(r.reason!, /remember/);
  assert.match(r.reason!, /harvest-session/);
  assert.equal(r.nudgedAt, WORK_THRESHOLD + 1);

  assert.equal(saveNudge({ tools: ['mcp__memory__load_profile', ...work], stopHookActive: false, nudgedAt: r.nudgedAt }).block, false);
  assert.equal(saveNudge({ tools: [...work], stopHookActive: true, nudgedAt: 0 }).block, false);
});

test('no reminder when the work is small or was followed by a save', () => {
  assert.equal(saveNudge({ tools: Array<string>(WORK_THRESHOLD - 1).fill('Bash'), stopHookActive: false, nudgedAt: 0 }).block, false);
  const saved = [...Array<string>(WORK_THRESHOLD).fill('Write'), 'mcp__memory__update_memory', 'Edit'];
  assert.equal(saveNudge({ tools: saved, stopHookActive: false, nudgedAt: 0 }).block, false);
  const reads = Array<string>(WORK_THRESHOLD * 2).fill('Read');
  assert.equal(saveNudge({ tools: reads, stopHookActive: false, nudgedAt: 0 }).block, false);
});

test('PreCompact: a note for the summary only after some unsaved work, and a save resets it', () => {
  assert.equal(compactNote(['Edit', 'Edit', 'Bash']), COMPACT_NOTE);
  assert.match(COMPACT_NOTE, new RegExp(NUDGE.slice(0, 40)));
  assert.equal(compactNote(['Edit', 'Edit']), '');
  assert.equal(compactNote(['Edit', 'Edit', 'Bash', 'mcp__brainai__suggest_memories']), '');
  assert.equal(compactNote(['Read', 'Read', 'Read', 'Read']), '');
});

test('the PreCompact hook script prints the note for the summary and nothing when little was done', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'memhook-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const run = (tools: string[]) => {
    const transcript = join(dir, 't.jsonl');
    writeFileSync(transcript, tools.map((n) => entry(n)).join('\n'));
    return execFileSync('node', ['--import', 'tsx', join(import.meta.dirname, 'memorySave.ts')], {
      input: JSON.stringify({ hook_event_name: 'PreCompact', transcript_path: transcript, trigger: 'auto' }), encoding: 'utf8', env: { ...process.env, HOME: dir },
    });
  };
  assert.equal(run(['Edit', 'Write', 'Bash']), COMPACT_NOTE);
  assert.equal(run(['Read']), '');
});

test('the same reminder text is used by every tool\'s hook', () => {
  assert.equal(codexCursor.NUDGE, NUDGE);
});

test('Codex and Cursor: work is counted from tool events, a save resets it, and the stop asks once in the tool\'s own format', () => {
  const post = (tool_name: string) => ({ hook_event_name: 'PostToolUse', tool_name });
  let work = 0;
  for (let i = 0; i < codexCursor.WORK_THRESHOLD; i++) work = codexCursor.handle('codex', post(i % 2 ? 'Bash' : 'apply_patch'), work).work;
  assert.equal(codexCursor.handle('codex', post('Read'), work).work, work);
  assert.equal(codexCursor.handle('codex', post('mcp__brainai__remember'), work).work, 0);
  const codex = codexCursor.handle('codex', { hook_event_name: 'Stop' }, work);
  assert.deepEqual(JSON.parse(codex.out!), { decision: 'block', reason: NUDGE });
  assert.equal(codex.work, 0);
  const cursor = codexCursor.handle('cursor', { hook_event_name: 'postToolUse', tool_name: 'Shell' }, work);
  assert.equal(cursor.work, work + 1);
  assert.deepEqual(JSON.parse(codexCursor.handle('cursor', { hook_event_name: 'stop' }, work).out!), { followup_message: NUDGE });
  assert.equal(codexCursor.handle('codex', { hook_event_name: 'Stop' }, 3).out, null);
  assert.equal(codexCursor.handle('codex', { hook_event_name: 'Stop', stop_hook_active: true }, work).out, null);
});

test('the Codex/Cursor script keeps its count between events', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'memnudge-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const send = (payload: object) => execFileSync('node', ['--import', 'tsx', join(import.meta.dirname, 'memoryNudge.ts'), 'cursor'], { input: JSON.stringify(payload), encoding: 'utf8', env: { ...process.env, HOME: home } });
  for (let i = 0; i < codexCursor.WORK_THRESHOLD; i++) send({ hook_event_name: 'postToolUse', conversation_id: 'c1', tool_name: 'Shell' });
  assert.deepEqual(JSON.parse(send({ hook_event_name: 'stop', conversation_id: 'c1', status: 'completed' })), { followup_message: NUDGE });
  assert.equal(send({ hook_event_name: 'stop', conversation_id: 'c1' }), '');
});
