import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CODEX_DISABLED, claudeArgs, codexArgs, executedForeignTools, isOurProjectDir, parseClaude, parseCodex, shortTool, WRITE_TOOLS } from './assistants.js';
import { parseArgs, selectScenarios } from './args.js';
import { assertClaudeIsolated, assertCodexIsolated, mcpNamespaces, parseClaudeInit } from './isolation.js';
import { judgePrompt, parseVerdict } from './judge.js';
import { aggregate, byTag, markdownTable, outcome, type RunResult } from './report.js';
import { serverEnv } from './brain.js';
import { SCENARIOS } from './scenarios.js';
import { citesFacts, claimedSavesWithoutWrite, matchesAll, s3StateChecks, S3_OWNER_TURNS, quotesOwner, NUMBER_CLAIM, sourceAttribution, supersedeLink, type FactRow, type SupersessionRow } from './scoring.js';

const fact = (o: Partial<FactRow>): FactRow => ({ id: 'aaaaaaaa-1', kind: 'decision', content: '', project: 'harbor', created_by: 'Claude Code', created_at: '', deleted_at: null, valid_until: null, source: null, source_by: null, source_note: null, ...o });

test('scenario loader: ids are unique, every scenario has a run and covers tags', () => {
  const ids = SCENARIOS.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const s of SCENARIOS) { assert.equal(typeof s.run, 'function'); assert.ok(s.covers.length > 0); }
  for (const tag of ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'A1', 'A2', 'A3', 'A4']) assert.ok(SCENARIOS.some((s) => s.covers.includes(tag)), `no scenario covers ${tag}`);
});

test('options: defaults, flags and bad input', () => {
  assert.deepEqual(parseArgs([]).assistants, ['claude', 'codex']);
  assert.equal(parseArgs([]).runs, 3);
  const o = parseArgs(['--runs', '2', '--only', 's1, s4', '--assistants', 'claude', '--out', 'x']);
  assert.equal(o.runs, 2); assert.deepEqual(o.only, ['S1', 'S4']); assert.deepEqual(o.assistants, ['claude']); assert.equal(o.out, 'x');
  assert.throws(() => parseArgs(['--runs', '0']));
  assert.throws(() => parseArgs(['--assistants', 'grok']));
  assert.throws(() => parseArgs(['--nope']));
  assert.deepEqual(selectScenarios(SCENARIOS, ['S2']).map((s) => s.id), ['S2']);
  assert.throws(() => selectScenarios(SCENARIOS, ['S99']));
});

test('Claude command line: only our MCP server, no hooks, no built-in tools, no real settings', () => {
  const a = claudeArgs({ prompt: 'hi', mcpUrl: 'http://127.0.0.1:1/mcp', token: 'T', systemText: 'setup' });
  assert.ok(a.includes('--strict-mcp-config'));
  assert.ok(a.includes('{"disableAllHooks":true}'));
  assert.equal(a[a.indexOf('--setting-sources') + 1], 'project');
  assert.equal(a[a.indexOf('--tools') + 1], '');
  assert.ok(!a.includes('--bare'));
  assert.ok(!a.includes('--resume'));
  const cfg = JSON.parse(a[a.indexOf('--mcp-config') + 1]!);
  assert.deepEqual(Object.keys(cfg.mcpServers), ['brainai']);
  assert.equal(cfg.mcpServers.brainai.headers.Authorization, 'Bearer T');
  const ro = claudeArgs({ prompt: 'x', mcpUrl: 'u', token: 't', systemText: 's', readOnly: true, sessionId: 'sid' });
  assert.ok(ro.includes('mcp__brainai__remember') && ro.includes('mcp__brainai__suggest_memories'));
  assert.equal(ro[ro.indexOf('--resume') + 1], 'sid');
});

test('Codex command line: user config ignored, apps/plugins/hooks off, token by env var', () => {
  const a = codexArgs({ prompt: 'p', mcpUrl: 'http://127.0.0.1:1/mcp' });
  assert.ok(a.includes('--ignore-user-config') && a.includes('--ephemeral'));
  for (const f of ['apps', 'plugins', 'hooks']) assert.equal(a[a.indexOf(f) - 1], '--disable');
  assert.ok(a.includes('mcp_servers.brainai.bearer_token_env_var="BRAINAI_EVAL_TOKEN"'));
  assert.ok(a.includes('mcp_servers.brainai.default_tools_approval_mode="approve"'));
  assert.ok(!a.join(' ').includes('Bearer'));
  assert.ok(codexArgs({ prompt: 'p', mcpUrl: 'u', readOnly: true }).some((x) => x.startsWith('mcp_servers.brainai.disabled_tools=') && x.includes('remember')));
  assert.ok(WRITE_TOOLS.includes('suggest_memories'));
});

test('Claude output parser: answer, tool calls with results, session and cost', () => {
  const lines = [
    { type: 'system', subtype: 'init', session_id: 's1', tools: ['mcp__brainai__remember'], mcp_servers: [{ name: 'brainai' }] },
    { type: 'assistant', session_id: 's1', message: { content: [{ type: 'tool_use', id: 't1', name: 'mcp__brainai__remember', input: { content: 'x' } }] } },
    { type: 'user', session_id: 's1', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'Saved.' }] }] } },
    { type: 'result', session_id: 's1', result: 'Done.', total_cost_usd: 0.02, is_error: false },
  ].map((l) => JSON.stringify(l)).join('\n');
  const r = parseClaude(lines);
  assert.equal(r.text, 'Done.'); assert.equal(r.sessionId, 's1'); assert.equal(r.costUsd, 0.02);
  assert.equal(r.toolCalls.length, 1); assert.equal(r.toolCalls[0]!.output, 'Saved.');
  assert.equal(shortTool(r.toolCalls[0]!.name), 'remember');
  assert.equal(parseClaude('not json\n').text, '');
});

test('Codex output parser: last agent message and MCP calls', () => {
  const lines = [
    { type: 'thread.started', thread_id: 'th' },
    { type: 'item.completed', item: { type: 'mcp_tool_call', server: 'brainai', tool: 'recall', arguments: { query: 'x' }, status: 'completed', result: { content: [{ type: 'text', text: 'rows' }] } } },
    { type: 'item.completed', item: { type: 'agent_message', text: 'Answer.' } },
  ].map((l) => JSON.stringify(l)).join('\n');
  const r = parseCodex(lines);
  assert.equal(r.text, 'Answer.'); assert.equal(r.sessionId, 'th');
  assert.equal(shortTool(r.toolCalls[0]!.name), 'recall'); assert.equal(r.toolCalls[0]!.output, 'rows');
});

test('isolation parser: passes only brainai, fails on foreign servers, built-in tools or hook events', () => {
  const init = (o: object) => JSON.stringify({ type: 'system', subtype: 'init', tools: ['mcp__brainai__recall'], mcp_servers: [{ name: 'brainai' }], ...o });
  assert.deepEqual(assertClaudeIsolated(parseClaudeInit(init({}))), []);
  assert.ok(assertClaudeIsolated(parseClaudeInit(init({ mcp_servers: [{ name: 'brainai' }, { name: 'memory' }] }))).length > 0);
  assert.ok(assertClaudeIsolated(parseClaudeInit(init({ tools: ['mcp__brainai__recall', 'mcp__memory__recall'] }))).length > 0);
  assert.ok(assertClaudeIsolated(parseClaudeInit(init({ tools: ['Bash', 'mcp__brainai__recall'] }))).length > 0);
  assert.ok(assertClaudeIsolated(parseClaudeInit(`${init({})}\n${JSON.stringify({ type: 'system', subtype: 'hook_started' })}`)).length > 0);
  assert.ok(assertClaudeIsolated(null).length > 0);
  assert.deepEqual(mcpNamespaces('- `mcp__brainai`\n- `mcp__codex_apps__memoryai`\n- mcp__memory__recall'), ['brainai', 'codex_apps', 'memory']);
  assert.deepEqual(assertCodexIsolated('Deferred MCP server: `mcp__brainai`'), []);
  assert.ok(assertCodexIsolated('`mcp__brainai` and `mcp__codex_apps__hotline`').length > 0);
  assert.ok(assertCodexIsolated('none').length > 0);
});

test('judge: verdict parsing is strict and prompt carries the rubric', () => {
  assert.deepEqual(parseVerdict('Sure.\n{"pass": true, "reason": "ok"}'), { pass: true, reason: 'ok' });
  assert.equal(parseVerdict('{"pass": "yes"}').pass, false);
  assert.equal(parseVerdict('garbage').pass, false);
  const p = judgePrompt('Q?', 'A.', 'must say X');
  assert.ok(p.includes('must say X') && p.includes('Q?') && p.includes('A.'));
});

test('scoring: supersede link, answer matching, number claims, citations, source attribution', () => {
  const old = fact({ id: 'old-1', content: 'database is Postgres' }); const neu = fact({ id: 'new-1', content: 'back to SQLite' });
  const link: SupersessionRow = { id: 1, old_id: 'old-1', new_id: 'new-1', undone_at: null };
  assert.equal(supersedeLink([old, neu], [link], /postgres/i, /sqlite/i).ok, true);
  assert.equal(supersedeLink([old, neu], [], /postgres/i, /sqlite/i).ok, false);
  assert.equal(supersedeLink([old, neu], [{ ...link, undone_at: 'x' }], /postgres/i, /sqlite/i).ok, false);
  assert.equal(supersedeLink([neu], [], /postgres/i, /sqlite/i).why, 'the old decision is not in the brain at all');
  assert.deepEqual(matchesAll('Go on Hetzner', [/go/i, /2027/]), { ok: false, missing: ['/2027/'] });
  assert.ok(NUMBER_CLAIM.test('about €40 a month')); assert.ok(NUMBER_CLAIM.test('50 USD')); assert.ok(!NUMBER_CLAIM.test('I have no budget on record for harbor'));
  const f = fact({ id: '12345678-aaaa', content: 'harbor domain is registered at Gandi and renews on 2027-03-14' });
  assert.equal(citesFacts('see note 12345678', [f]).cited.length, 1);
  assert.equal(citesFacts('It says the harbor domain is registered at Gandi.', [f]).how[0], 'quote');
  assert.equal(citesFacts('nothing here', [f]).cited.length, 0);
  assert.equal(sourceAttribution([fact({ source: 'owner_said', source_by: 'owner' })]).length, 1);
  assert.equal(sourceAttribution([fact({ source: 'owner_said', source_by: 'Codex' })]).length, 0);
});

test('report: a run passes only when all checks pass; rates and failure lines', () => {
  const run = (o: Partial<RunResult>): RunResult => ({ scenario: 'S1', assistant: 'claude', run: 1, status: 'done', checks: [{ tag: 'S1', name: 'a', pass: true, reason: '', kind: 'state' }], seconds: 1, costUsd: 0, ...o });
  const rows = aggregate([run({}), run({ run: 2, checks: [{ tag: 'S1', name: 'b', pass: false, reason: 'why', kind: 'answer' }] }), run({ run: 3, status: 'setup_failed', error: 'nope', checks: [] })]);
  assert.equal(rows[0]!.passed, 1); assert.equal(rows[0]!.runs, 3);
  assert.ok(rows[0]!.failures.some((f) => f.includes('b: why')) && rows[0]!.failures.some((f) => f.includes('setup failed: nope')));
  assert.ok(markdownTable(rows).includes('| S1 | claude | 1/3 | 0 | 33% |'));
  assert.equal(byTag([run({})])[0]!.total, 1);
});

test('claimed saves: counted per assistant; negated, conditional and read-only turns and real writes do not count', () => {
  const t = (who: string, text: string, toolCalls: { name: string; isError?: boolean }[] = [], readOnly = false) => ({ who, text, toolCalls, readOnly });
  assert.deepEqual(claimedSavesWithoutWrite([t('Codex', "I've recorded that setup in the brain.", [{ name: 'brainai.recall' }]), t('Claude Code', "I've saved it.", [{ name: 'mcp__brainai__remember' }])]), { Codex: 1 });
  assert.deepEqual(claimedSavesWithoutWrite([t('Codex', 'I saved it.', [{ name: 'brainai.remember', isError: true }])]), { Codex: 1 });
  assert.deepEqual(claimedSavesWithoutWrite([t('Codex', "I've saved it.", [], true)]), {});
  assert.deepEqual(claimedSavesWithoutWrite([t('Claude Code', "The save failed, so I won't say I've saved it. I can't tell you it is saved until it's saved."), t('Claude Code', 'It is saved as an unverified claim.'), t('Claude Code', "I couldn't have saved that without the tool.")]), {});
  assert.equal(parseArgs(['--report', 'dir']).report, 'dir');
});

const row = (o: Partial<FactRow>): FactRow => fact({ id: 'x', kind: 'decision', source: 'owner_said', source_by: 'Claude Code', ...o });

test('S3 state checks: a pure suggestion marked owner_said fails, a mixed fact fails on its own, nothing saved is not tested', () => {
  const byName = (rows: FactRow[]) => Object.fromEntries(s3StateChecks(rows, 'Claude Code').map((c) => [c.name, c]));
  const pure = byName([row({ content: 'harbor backups use restic with a systemd timer' })]);
  assert.equal(pure["assistant's backup suggestion not recorded as a separate owner_said fact"]!.pass, false);
  const mixed = byName([row({ id: 'm', content: 'harbor backs up nightly to Backblaze B2 using restic' })]);
  assert.equal(mixed['no owner_said fact mixes the owner decision with the assistant suggestion']!.pass, false);
  assert.equal(mixed["assistant's backup suggestion not recorded as a separate owner_said fact"]!.pass, true);
  const none = byName([]);
  for (const k of ["assistant's backup suggestion not recorded as a separate owner_said fact", 'a saved suggestion carries a source label']) { assert.equal(none[k]!.pass, false); assert.equal(none[k]!.notTested, true); }
  const clean = byName([row({ content: 'harbor backups go to Backblaze B2', source_note: 'B2 it is then' }), row({ id: 'y', content: 'suggested: restic nightly', source: 'inferred' })]);
  assert.equal(Object.values(clean).every((c) => c.pass), true);
});

test('not tested is never a pass and is counted apart', () => {
  const base: RunResult = { scenario: 'S3', assistant: 'codex', run: 1, status: 'done', seconds: 1, costUsd: 0, checks: [{ tag: 'S3', name: 'a', pass: true, reason: '', kind: 'state' }, { tag: 'S3', name: 'b', pass: false, notTested: true, reason: 'nothing saved', kind: 'state' }] };
  assert.equal(outcome(base), 'not_tested');
  assert.equal(outcome({ ...base, checks: [...base.checks, { tag: 'S3', name: 'c', pass: false, reason: 'x', kind: 'answer' }] }), 'fail');
  const rows = aggregate([base]);
  assert.equal(rows[0]!.passed, 0); assert.equal(rows[0]!.notTested, 1);
  assert.equal(byTag([base])[0]!.passed, 1); assert.equal(byTag([base])[0]!.notTested, 1);
});

test('foreign tools: an executed shell or web item aborts; a refused Claude call and brainai calls do not', () => {
  const ev = (item: object) => ({ type: 'item.completed', item });
  assert.deepEqual(executedForeignTools('codex', { toolCalls: [], events: [ev({ type: 'mcp_tool_call', server: 'brainai', tool: 'recall' }), ev({ type: 'agent_message' }), ev({ type: 'reasoning' })] }), []);
  assert.deepEqual(executedForeignTools('codex', { toolCalls: [], events: [ev({ type: 'mcp_tool_call', server: 'codex', tool: 'list_mcp_resources' }), ev({ type: 'mcp_tool_call', server: 'codex', tool: 'list_mcp_resource_templates' })] }), []);
  assert.deepEqual(executedForeignTools('codex', { toolCalls: [], events: [ev({ type: 'mcp_tool_call', server: 'codex', tool: 'spawn_agent' })] }), ['mcp:codex.spawn_agent']);
  assert.deepEqual(executedForeignTools('codex', { toolCalls: [], events: [ev({ type: 'command_execution', command: 'rg foo' }), ev({ type: 'web_search' }), ev({ type: 'mcp_tool_call', server: 'memory', tool: 'x' })] }), ['command_execution: rg foo', 'web_search', 'mcp:memory.x']);
  assert.deepEqual(executedForeignTools('claude', { toolCalls: [{ name: 'remember', isError: true, input: {} }, { name: 'mcp__brainai__recall', input: {} }], events: [] }), []);
  assert.deepEqual(executedForeignTools('claude', { toolCalls: [{ name: 'Bash', input: {}, output: 'ok' }], events: [] }), ['Bash']);
});

test('Codex command line turns off shell, web search, browser and computer use', () => {
  const a = codexArgs({ prompt: 'p', mcpUrl: 'u' });
  for (const f of ['shell_tool', 'unified_exec', 'browser_use', 'computer_use', 'in_app_browser', 'image_generation']) { assert.ok(CODEX_DISABLED.includes(f)); assert.equal(a[a.indexOf(f) - 1], '--disable'); }
  assert.ok(a.includes('web_search="disabled"'));
  assert.ok(claudeArgs({ prompt: 'p', mcpUrl: 'u', token: 't', systemText: 's', includeHookEvents: true }).includes('--include-hook-events'));
});

test('cleanup only touches Claude project folders that are clearly ours', () => {
  const home = '/Users/x';
  assert.equal(isOurProjectDir('/Users/x/.claude/projects/-private-var-T-lifecycle-cwd-abc', home), true);
  assert.equal(isOurProjectDir('/Users/x/.claude/projects/-private-var-T-lifecycle-sentinel-abc', home), true);
  assert.equal(isOurProjectDir('/Users/x/.claude/projects/-Users-x-Projects-app', home), false);
  assert.equal(isOurProjectDir('/Users/x/.claude/projects/lifecycle-cwd', home), false);
  assert.equal(isOurProjectDir('/Users/x/.claude/projects/-a/lifecycle-b', home), false);
  assert.equal(isOurProjectDir('/Users/x/.claude/projects', home), false);
});

test('server environment is a whitelist', () => {
  const env = serverEnv({ home: '/h', dataDir: '/d', port: 1, baseUrl: 'http://localhost:1', modelDir: '/m' }, { PATH: '/bin', ASK_COMMANDS: 'x', OVERLAY_DIR: '/real', RERANK: 'off', MEMORY_MODE: 'personal', DUPLICATE_THRESHOLD: '0.1', HOME: '/real' });
  assert.equal(env.HOME, '/h'); assert.equal(env.PATH, '/bin'); assert.equal(env.OVERLAY_DIR, '/d/overlay');
  for (const k of ['ASK_COMMANDS', 'RERANK', 'MEMORY_MODE', 'DUPLICATE_THRESHOLD']) assert.equal(env[k], undefined);
});

test('S3 suggestion words are tool names only: generic words do not make a fact mixed', () => {
  const mixedCheck = (content: string) => s3StateChecks([row({ id: 'q', content })], 'Claude Code').find((c) => c.name.startsWith('no owner_said fact mixes'))!;
  const deferred = mixedCheck("harbor backups go to Backblaze B2 on the Hetzner box. Implementation, including backup contents, schedule, retention, and restore procedure, is deferred to the owner.");
  assert.equal(deferred.pass, true);
  const mixed = mixedCheck('harbor backups go to Backblaze B2 on the Hetzner box. Tool, schedule and retention not yet decided (assistant suggested restic + systemd timer, not confirmed).');
  assert.equal(mixed.pass, false);
});

const QUOTE_CHECK = 'every owner_said fact the assistant set quotes words the owner actually said';
const CARRY_CHECK = "no quoted owner words carry the assistant's suggestion";
const quoteChecks = (rows: FactRow[]) => Object.fromEntries(s3StateChecks(rows, 'Claude Code').map((c) => [c.name, c]));

test('S3 quote check: a note that is the owner\'s words passes; invented words, no note, and a restic quote fail; no assistant owner_said is not tested', () => {
  const pass = quoteChecks([row({ content: 'harbor backups go to B2', source_note: '\u201cGood, B2 it is then\u201d' })]);
  assert.equal(pass[QUOTE_CHECK]!.pass, true);
  assert.equal(pass[CARRY_CHECK]!.pass, true);
  // 80% of the words in one owner turn, in another order, still counts.
  assert.equal(quoteChecks([row({ content: 'x', source_note: 'B2 it is, everything stays on the Hetzner box' })])[QUOTE_CHECK]!.pass, true);
  const invented = quoteChecks([row({ content: 'harbor backups go to B2', source_note: 'owner wants nightly restic backups with long retention' })]);
  assert.equal(invented[QUOTE_CHECK]!.pass, false);
  assert.equal(invented[CARRY_CHECK]!.pass, false);
  assert.equal(quoteChecks([row({ content: 'harbor backups go to B2', source_note: null })])[QUOTE_CHECK]!.pass, false);
  // A real owner sentence is a quote, but "use restic" is the assistant's side.
  const carries = quoteChecks([row({ content: 'harbor backups', source_note: 'What would you suggest for nightly backups? restic' })]);
  assert.equal(carries[CARRY_CHECK]!.pass, false);
  for (const rows of [[], [row({ content: 'x', source: 'inferred' })], [row({ content: 'x', source_by: 'owner' })]]) {
    for (const k of [QUOTE_CHECK, CARRY_CHECK]) { assert.equal(quoteChecks(rows)[k]!.pass, false); assert.equal(quoteChecks(rows)[k]!.notTested, true); }
  }
});

test('quotesOwner normalises case, curly quotes, surrounding punctuation and spaces; a custom owner text can be passed', () => {
  assert.equal(quotesOwner("\u2018GOOD,   B2 it is then.\u2019", S3_OWNER_TURNS), true);
  assert.equal(quotesOwner('Zo is het dan', S3_OWNER_TURNS), false);
  assert.equal(s3StateChecks([row({ content: 'x', source_note: 'ship it friday' })], 'Claude Code', ['Please ship it friday, thanks']).find((c) => c.name === QUOTE_CHECK)!.pass, true);
});
