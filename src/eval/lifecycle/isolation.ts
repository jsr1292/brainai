/**
 * The isolation self-check: before any scenario, each assistant must show that the only MCP server it can reach is the
 * throwaway "brainai", and (Claude) that no hook ran. Parsers are pure so a test can feed them canned output.
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NO_HOOKS, claudeEnv, executedForeignTools, removeClaudeProjectDir, runCommand, IsolationViolation, Session, type AssistantConn, type TurnRecord } from './assistants.js';

export interface ClaudeInit { tools: string[]; mcpServers: string[]; hookEvents: number }

/** From Claude's stream-json lines: its tools, its MCP servers, and how many hook events there were. */
export function parseClaudeInit(stdout: string): ClaudeInit | null {
  let init: ClaudeInit | null = null; let hooks = 0;
  for (const line of stdout.split('\n')) {
    let e: Record<string, any>;
    try { e = JSON.parse(line); } catch { continue; }
    if (e.type === 'system' && typeof e.subtype === 'string' && /hook/i.test(e.subtype)) hooks++;
    if (e.type === 'system' && e.subtype === 'init') init = { tools: e.tools ?? [], mcpServers: (e.mcp_servers ?? []).map((s: { name: string }) => s.name), hookEvents: 0 };
  }
  if (init) init.hookEvents = hooks;
  return init;
}

export function assertClaudeIsolated(init: ClaudeInit | null): string[] {
  if (!init) return ['no init event: cannot verify what Claude Code loaded'];
  const bad: string[] = [];
  if (init.mcpServers.length !== 1 || init.mcpServers[0] !== 'brainai') bad.push(`MCP servers are [${init.mcpServers.join(', ')}], expected only brainai`);
  const foreign = init.tools.filter((t) => t.startsWith('mcp__') && !t.startsWith('mcp__brainai__'));
  if (foreign.length) bad.push(`foreign MCP tools: ${foreign.slice(0, 5).join(', ')}`);
  const builtin = init.tools.filter((t) => !t.startsWith('mcp__'));
  if (builtin.length) bad.push(`built-in tools present: ${builtin.join(', ')}`);
  if (init.hookEvents > 0) bad.push(`${init.hookEvents} hook events seen`);
  return bad;
}

/** MCP server names an assistant lists in prose (mcp__name or mcp__name__tool). */
export function mcpNamespaces(text: string): string[] {
  const names = new Set<string>();
  for (const m of text.matchAll(/mcp__([a-z0-9]+(?:_[a-z0-9]+)*?)(?=__|[^a-z0-9_]|$)/gi)) names.add(m[1]!.toLowerCase());
  return [...names].sort();
}

export function assertCodexIsolated(text: string): string[] {
  const ns = mcpNamespaces(text);
  const bad: string[] = [];
  if (!ns.includes('brainai')) bad.push('brainai server not listed');
  const foreign = ns.filter((n) => n !== 'brainai');
  if (foreign.length) bad.push(`foreign MCP namespaces: ${foreign.join(', ')}`);
  return bad;
}

export interface IsolationReport { ok: boolean; lines: string[] }

const LIST_PROMPT = 'Self-check, no memory work: without calling any tool, list every MCP server and tool namespace you can see, using exact names such as mcp__server or mcp__server__tool. If you see none, say none.';
const CODEX_CAPS_PROMPT = "Self-check. Try these two things with your own tools, not the memory server: (1) run the shell command `echo lifecycle-shell-check`; (2) web-search for `restic documentation`. Say for each whether you could. Do not call any memory tool.";

/** Counts hook lifecycle events in Claude stream-json lines (they only appear with --include-hook-events). */
export const countHookEvents = (stdout: string): number => stdout.split('\n').filter((l) => /"subtype":"hook[a-z_]*"/.test(l)).length;

/** Runs the check for the given connections (the sessions are thrown away). Never throws: the report says ok or not. */
export async function isolationCheck(conns: AssistantConn[], cwd: string): Promise<IsolationReport> {
  const lines: string[] = []; let ok = true;
  const log: TurnRecord[] = [];
  for (const c of conns) {
    if (c.kind === 'claude') {
      // Positive control: a sentinel hook given through --settings must fire (file written, hook events seen with
      // --include-hook-events) without disableAllHooks, and neither with it. This proves the switch and the event stream both work.
      const dir = mkdtempSync(join(tmpdir(), 'lifecycle-sentinel-'));
      const probe = async (flag: string, off: boolean): Promise<{ file: boolean; events: number }> => {
        const hook = { hooks: [{ type: 'command', command: `touch ${join(dir, flag)}` }] };
        const settings = JSON.stringify({ ...(off ? { disableAllHooks: true } : {}), hooks: { SessionStart: [hook], Stop: [hook] } });
        const r = await runCommand('claude', ['-p', 'Say OK.', '--tools', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--setting-sources', 'project', '--model', 'haiku', '--no-session-persistence', '--output-format', 'stream-json', '--verbose', '--include-hook-events', '--settings', settings], { cwd: dir, env: claudeEnv(), timeoutMs: 120_000 });
        return { file: existsSync(join(dir, flag)), events: countHookEvents(r.stdout) };
      };
      const control = await probe('on', false);
      const off = await probe('off', true);
      removeClaudeProjectDir(dir); rmSync(dir, { recursive: true, force: true });
      lines.push(`claude hook control: without disableAllHooks the sentinel hook ${control.file ? 'fired' : 'did NOT fire'} (${control.events} hook events seen); with ${NO_HOOKS} it ${off.file ? 'FIRED' : 'did not fire'} (${off.events} hook events)`);
      if (!control.file || control.events === 0 || off.file || off.events > 0) ok = false;
      let r;
      try {
        r = await new Session(c, cwd, log, { includeHookEvents: true }).say(LIST_PROMPT);
      } catch (e) { lines.push(`claude self-check aborted: ${(e as Error).message}`); ok = false; continue; }
      const init = parseClaudeInit(r.events.map((e) => JSON.stringify(e)).join('\n'));
      const bad = assertClaudeIsolated(init);
      lines.push(`claude init (with --include-hook-events): servers=[${init?.mcpServers.join(',')}] tools=${init?.tools.length} hookEvents=${init?.hookEvents} ${bad.length ? 'PROBLEMS: ' + bad.join('; ') : 'ok'}`);
      const said = mcpNamespaces(r.text).filter((n) => n !== 'brainai');
      if (said.length) { bad.push(`assistant also mentions ${said.join(', ')}`); lines.push(`claude answer mentions foreign namespaces: ${said.join(', ')}`); }
      if (bad.length) ok = false;
    } else {
      let r;
      try {
        r = await new Session(c, cwd, log).say(LIST_PROMPT);
      } catch (e) { lines.push(`codex self-check aborted: ${(e as Error).message}`); ok = false; continue; }
      const bad = assertCodexIsolated(r.text);
      lines.push(`codex namespaces: [${mcpNamespaces(r.text).join(', ')}] ${bad.length ? 'PROBLEMS: ' + bad.join('; ') : 'ok'}`);
      if (bad.length) ok = false;
      // Capabilities: it is asked to run a shell command and a web search; neither may run (Session.say aborts on any such item).
      try {
        const k = await new Session(c, cwd, log).say(CODEX_CAPS_PROMPT);
        const ran = executedForeignTools('codex', k);
        lines.push(`codex capabilities: shell and web search ${ran.length ? 'RAN: ' + ran.join(', ') : 'unavailable (no command or search item)'}; it said: ${k.text.slice(0, 120).replace(/\s+/g, ' ')}`);
        if (ran.length) ok = false;
      } catch (e) {
        lines.push(`codex capabilities: ${e instanceof IsolationViolation ? 'SHELL OR WEB RAN: ' : 'aborted: '}${(e as Error).message}`); ok = false;
      }
    }
  }
  return { ok, lines };
}
