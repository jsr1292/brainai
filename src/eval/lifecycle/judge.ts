/** The answer judge: Claude Haiku with no MCP, no tools, no hooks, a strict rubric, JSON out. */
import { claudeEnv, runCommand, NO_HOOKS } from './assistants.js';

export interface Verdict { pass: boolean; reason: string }

export const judgePrompt = (question: string, answer: string, rubric: string): string => `You are a strict grader. Judge ONE assistant answer against a rubric. Be literal. If the rubric is not clearly met, fail it.

Question the owner asked:
${question}

Assistant answer:
"""
${answer}
"""

Rubric (all of it must hold to pass):
${rubric}

Reply with ONLY a JSON object on one line, reason first so it decides the verdict: {"reason": "one short sentence that checks each rubric point", "pass": true or false}`;

/** Takes the first JSON object with a boolean "pass" out of the judge's reply. */
export function parseVerdict(reply: string): Verdict {
  for (const m of reply.matchAll(/\{[^{}]*\}/g)) {
    try {
      const o = JSON.parse(m[0]) as { pass?: unknown; reason?: unknown };
      if (typeof o.pass === 'boolean') return { pass: o.pass, reason: typeof o.reason === 'string' ? o.reason : '' };
    } catch { /* next */ }
  }
  return { pass: false, reason: `judge reply not understood: ${reply.slice(0, 120)}` };
}

export async function judge(cwd: string, question: string, answer: string, rubric: string): Promise<Verdict> {
  if (!answer.trim()) return { pass: false, reason: 'empty answer' };
  const out = await runCommand('claude', ['-p', judgePrompt(question, answer, rubric), '--model', 'haiku', '--output-format', 'json', '--tools', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--settings', NO_HOOKS, '--setting-sources', 'project', '--no-session-persistence'], { cwd, env: claudeEnv(), timeoutMs: 180_000 });
  try { return parseVerdict((JSON.parse(out.stdout) as { result?: string }).result ?? ''); } catch { return parseVerdict(out.stdout); }
}
