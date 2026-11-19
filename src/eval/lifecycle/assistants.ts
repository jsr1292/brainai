/**
 * Real assistants, run headless against a throwaway brain over MCP/HTTP with a bearer token.
 * Isolation (the owner's real brain must never be contacted):
 *  Claude Code: --strict-mcp-config (only our brainai server), --setting-sources project plus disableAllHooks (no user
 *    hooks), --tools "" (no shell, no files), CLAUDE_CODE_DISABLE_CLAUDE_MDS=1 (no user CLAUDE.md), a temp working folder.
 *  Codex: --ignore-user-config (no real MCP servers, no user hooks), --disable apps/plugins/hooks/multi_agent/memories,
 *    --ephemeral, a temp working folder. The global ~/.codex/AGENTS.md still loads: Codex has no switch for it.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export type Kind = 'claude' | 'codex';
export interface ToolCall { name: string; input: unknown; output?: string; isError?: boolean }
export interface TurnResult {
  text: string; toolCalls: ToolCall[]; sessionId: string | null; costUsd: number | null; ms: number; events: unknown[]; error?: string;
}
export interface TurnRecord { who: string; connection: string; prompt: string; readOnly: boolean; result: TurnResult }

/** brainai tools that change anything: the ones a "no saving possible" session loses. */
export const WRITE_TOOLS = [
  'remember', 'suggest_memories', 'update_memory', 'forget', 'flag_disagreement', 'set_project_info', 'note_observation', 'set_project_area',
  'record_lesson', 'propose_skill', 'propose_tidy', 'write_page', 'edit_page_section', 'begin_image_upload', 'add_page_image', 'resolve_note',
];

const MODEL: Record<Kind, string> = { claude: process.env.LIFECYCLE_CLAUDE_MODEL ?? 'sonnet', codex: process.env.LIFECYCLE_CODEX_MODEL ?? 'gpt-6-luna' };
export const NO_HOOKS = '{"disableAllHooks":true}';

export interface ClaudeArgsInput { prompt: string; mcpUrl: string; token: string; systemText: string; sessionId?: string | null; readOnly?: boolean; model?: string; includeHookEvents?: boolean }

export function claudeArgs(i: ClaudeArgsInput): string[] {
  const cfg = JSON.stringify({ mcpServers: { brainai: { type: 'http', url: i.mcpUrl, headers: { Authorization: `Bearer ${i.token}` } } } });
  return [
    '-p', i.prompt, '--mcp-config', cfg, '--strict-mcp-config', '--model', i.model ?? MODEL.claude,
    '--output-format', 'stream-json', '--verbose', ...(i.includeHookEvents ? ['--include-hook-events'] : []), '--settings', NO_HOOKS, '--setting-sources', 'project',
    '--tools', '', '--allowedTools', 'mcp__brainai__*', '--max-budget-usd', '2',
    ...(i.readOnly ? ['--disallowedTools', ...WRITE_TOOLS.map((t) => `mcp__brainai__${t}`)] : []),
    '--append-system-prompt', i.systemText,
    ...(i.sessionId ? ['--resume', i.sessionId] : []),
  ];
}

/** Codex features switched off: only the brainai MCP tools may remain (no shell, no web, no browser, no computer use). */
export const CODEX_DISABLED = ['apps', 'plugins', 'hooks', 'multi_agent', 'memories', 'shell_tool', 'unified_exec', 'unified_exec_tty', 'browser_use', 'browser_use_external', 'browser_use_full_cdp_access', 'computer_use', 'in_app_browser', 'image_generation'];

export interface CodexArgsInput { prompt: string; mcpUrl: string; readOnly?: boolean; model?: string }

export function codexArgs(i: CodexArgsInput): string[] {
  return [
    'exec', '--ignore-user-config', '--ephemeral', '--skip-git-repo-check', '--json', '-s', 'read-only', '-m', i.model ?? MODEL.codex,
    ...CODEX_DISABLED.flatMap((f) => ['--disable', f]),
    '-c', 'web_search="disabled"',
    '-c', 'model_reasoning_effort="low"',
    '-c', `mcp_servers.brainai.url=${JSON.stringify(i.mcpUrl)}`,
    '-c', 'mcp_servers.brainai.bearer_token_env_var="BRAINAI_EVAL_TOKEN"',
    // Headless exec cannot click "allow": without this, update_memory (not marked non-destructive) is refused. The owner would approve it.
    '-c', 'mcp_servers.brainai.default_tools_approval_mode="approve"',
    ...(i.readOnly ? ['-c', `mcp_servers.brainai.disabled_tools=${JSON.stringify(WRITE_TOOLS)}`] : []),
    i.prompt,
  ];
}

const textOf = (c: unknown): string => typeof c === 'string' ? c : Array.isArray(c) ? c.map((p) => (p && typeof p === 'object' && 'text' in p ? String((p as { text: unknown }).text) : '')).join('') : c == null ? '' : JSON.stringify(c);

/** Reads Claude's stream-json lines: the answer, the tool calls with their results, the session id and cost. */
export function parseClaude(stdout: string): Omit<TurnResult, 'ms'> {
  const events: unknown[] = [];
  for (const line of stdout.split('\n')) { if (!line.trim()) continue; try { events.push(JSON.parse(line)); } catch { /* not json */ } }
  const calls = new Map<string, ToolCall>();
  const order: ToolCall[] = [];
  let text = ''; let sessionId: string | null = null; let costUsd: number | null = null; let error: string | undefined;
  for (const e of events as Record<string, any>[]) {
    if (e.session_id) sessionId = e.session_id;
    if (e.type === 'assistant') {
      for (const p of e.message?.content ?? []) if (p.type === 'tool_use') { const c: ToolCall = { name: p.name, input: p.input }; calls.set(p.id, c); order.push(c); }
    } else if (e.type === 'user') {
      for (const p of e.message?.content ?? []) if (p.type === 'tool_result') { const c = calls.get(p.tool_use_id); if (c) { c.output = textOf(p.content); c.isError = !!p.is_error; } }
    } else if (e.type === 'result') {
      text = typeof e.result === 'string' ? e.result : '';
      costUsd = typeof e.total_cost_usd === 'number' ? e.total_cost_usd : null;
      if (e.is_error) error = text || String(e.subtype);
    }
  }
  return { text, toolCalls: order, sessionId, costUsd, events, error };
}

/** Reads Codex's --json lines: the last agent message and the MCP tool calls. */
export function parseCodex(stdout: string): Omit<TurnResult, 'ms'> {
  const events: unknown[] = [];
  for (const line of stdout.split('\n')) { if (!line.trim()) continue; try { events.push(JSON.parse(line)); } catch { /* not json */ } }
  const order: ToolCall[] = [];
  let text = ''; let sessionId: string | null = null; let error: string | undefined;
  for (const e of events as Record<string, any>[]) {
    if (e.type === 'thread.started') sessionId = e.thread_id ?? null;
    if (e.type === 'error' || e.type === 'turn.failed') error = e.message ?? e.error?.message ?? JSON.stringify(e);
    if (e.type === 'item.completed' && e.item) {
      const it = e.item;
      if (it.type === 'agent_message') text = it.text ?? text;
      else if (typeof it.type === 'string' && /tool_call/.test(it.type)) {
        const out = it.result ?? it.output ?? it.error;
        order.push({ name: `${it.server ?? 'mcp'}.${it.tool ?? it.name ?? it.type}`, input: it.arguments ?? it.input, output: out == null ? undefined : textOf(out.content ?? out), isError: it.status === 'failed' || !!it.error });
      }
    }
  }
  return { text, toolCalls: order, sessionId, costUsd: null, events, error };
}

export class IsolationViolation extends Error {}

/**
 * Anything an assistant actually did that is not a brainai MCP call. Claude: a tool_use outside mcp__brainai__ whose result is
 * not an error (a refused call, such as a bare "remember" that does not exist, is fine to record). Codex: any item that is not
 * an agent message, reasoning, or an MCP call to the brainai server.
 */
const CODEX_LISTING = new Set(['list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource']);

export function executedForeignTools(kind: Kind, result: Pick<TurnResult, 'toolCalls' | 'events'>): string[] {
  if (kind === 'claude') return result.toolCalls.filter((c) => !c.name.startsWith('mcp__brainai__') && !c.isError).map((c) => c.name);
  const bad: string[] = [];
  for (const e of result.events as Record<string, any>[]) {
    if ((e.type !== 'item.started' && e.type !== 'item.completed') || !e.item) continue;
    const t = String(e.item.type);
    if (t === 'agent_message' || t === 'reasoning') continue;
    if (t === 'mcp_tool_call' && e.item.server === 'brainai') continue;
    // Codex's own resource listing only reads what the configured MCP servers (brainai alone) offer: harmless.
    if (t === 'mcp_tool_call' && e.item.server === 'codex' && CODEX_LISTING.has(String(e.item.tool))) continue;
    bad.push(t === 'mcp_tool_call' ? `mcp:${e.item.server}.${e.item.tool}` : `${t}${e.item.command ? `: ${String(e.item.command).slice(0, 60)}` : ''}`);
  }
  return [...new Set(bad)];
}

/** Short tool name: "mcp__brainai__remember" or "brainai.remember" both give "remember". */
export const shortTool = (n: string): string => n.replace(/^mcp__[^_]+(?:_[^_]+)*?__/, '').replace(/^[a-z_]+\./, '');

function run(cmd: string, args: string[], opts: { cwd: string; env?: NodeJS.ProcessEnv; timeoutMs: number }): Promise<{ stdout: string; stderr: string; code: number | null; timedOut: boolean }> {
  return new Promise((ok) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env ?? process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = ''; let timedOut = false;
    child.stdout.on('data', (d) => { stdout += d; }); child.stderr.on('data', (d) => { stderr += d; });
    const t = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, opts.timeoutMs);
    child.on('close', (code) => { clearTimeout(t); ok({ stdout, stderr, code, timedOut }); });
    child.on('error', (e) => { clearTimeout(t); ok({ stdout, stderr: String(e), code: -1, timedOut }); });
  });
}

export const claudeEnv = (): NodeJS.ProcessEnv => ({ ...process.env, CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1' });

export interface AssistantConn { kind: Kind; connection: string; token: string; mcpUrl: string; systemText: string }

/** One conversation with an assistant: Claude resumes its session; Codex (ephemeral) gets the earlier turns replayed. */
export class Session {
  private sessionId: string | null = null;
  private history: { owner: string; assistant: string }[] = [];
  constructor(private a: AssistantConn, private cwd: string, private log: TurnRecord[], opts: { today?: string; timeoutMs?: number; includeHookEvents?: boolean } = {}) {
    this.includeHookEvents = !!opts.includeHookEvents;
    this.timeoutMs = opts.timeoutMs ?? 360_000;
    // The eval clock for this conversation: a date the assistant is told to treat as today, whatever its own clock says.
    if (opts.today) this.a = { ...a, systemText: `${a.systemText}\n\nToday's date for this conversation is ${opts.today}. Treat it as the current date even if another date appears elsewhere.` };
  }
  private timeoutMs: number;
  private includeHookEvents: boolean;

  async say(prompt: string, opts: { readOnly?: boolean } = {}): Promise<TurnResult> {
    const started = Date.now();
    let r: Omit<TurnResult, 'ms'>; let extra = '';
    if (this.a.kind === 'claude') {
      const out = await run('claude', claudeArgs({ prompt, mcpUrl: this.a.mcpUrl, token: this.a.token, systemText: this.a.systemText, sessionId: this.sessionId, readOnly: opts.readOnly, includeHookEvents: this.includeHookEvents }), { cwd: this.cwd, env: claudeEnv(), timeoutMs: this.timeoutMs });
      r = parseClaude(out.stdout); extra = out.timedOut ? 'timed out' : out.code ? out.stderr.slice(0, 500) : '';
      if (r.sessionId) this.sessionId = r.sessionId;
    } else {
      const past = this.history.map((h) => `Owner: ${h.owner}\nYou: ${h.assistant}`).join('\n\n');
      const full = `${this.history.length === 0 ? `Owner's standing instructions for you:\n${this.a.systemText}\n\n` : `Owner's standing instructions for you:\n${this.a.systemText}\n\nThe conversation so far:\n${past}\n\n`}${this.history.length === 0 ? 'Owner:' : 'Owner (new message):'} ${prompt}`;
      const out = await run('codex', codexArgs({ prompt: full, mcpUrl: this.a.mcpUrl, readOnly: opts.readOnly }), { cwd: this.cwd, env: { ...process.env, BRAINAI_EVAL_TOKEN: this.a.token }, timeoutMs: this.timeoutMs });
      r = parseCodex(out.stdout); extra = out.timedOut ? 'timed out' : out.code && !r.text ? out.stderr.slice(0, 500) : '';
      this.history.push({ owner: prompt, assistant: r.text });
    }
    const result: TurnResult = { ...r, ms: Date.now() - started, error: r.error ?? (extra || undefined) };
    this.log.push({ who: this.a.kind, connection: this.a.connection, prompt, readOnly: !!opts.readOnly, result });
    const foreign = executedForeignTools(this.a.kind, result);
    if (foreign.length) throw new IsolationViolation(`${this.a.kind} used something other than brainai: ${foreign.join(', ')}. Run aborted.`);
    return result;
  }
}

export function tempCwd(): { path: string; remove(): void } {
  const path = mkdtempSync(join(tmpdir(), 'lifecycle-cwd-'));
  return { path, remove: () => rmSync(path, { recursive: true, force: true }) };
}

/** Claude Code keeps a transcript per working folder under ~/.claude/projects; ours are removed after the run. */
export function claudeProjectDirFor(cwd: string): string {
  let real = cwd;
  try { real = realpathSync(cwd); } catch { /* already gone */ }
  return join(process.env.HOME ?? '', '.claude', 'projects', real.replace(/[^A-Za-z0-9]/g, '-'));
}

/** Removes Claude Code's transcript folder for one of our temp working folders; refuses anything that is not clearly ours. */
export function removeClaudeProjectDir(cwd: string): void {
  const home = process.env.HOME;
  const dir = claudeProjectDirFor(cwd);
  if (!home || !isOurProjectDir(dir, home)) return;
  rmSync(dir, { recursive: true, force: true });
}

/** A folder directly under ~/.claude/projects whose name starts with "-" and holds "lifecycle-". */
export function isOurProjectDir(dir: string, home: string): boolean {
  const parent = join(home, '.claude', 'projects');
  const base = dir.slice(parent.length + 1);
  return dir.startsWith(parent + '/') && !base.includes('/') && base.startsWith('-') && base.includes('lifecycle-');
}

export { run as runCommand };
