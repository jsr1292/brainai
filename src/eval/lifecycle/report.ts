import type { Check } from './scenario.js';

export interface RunResult {
  scenario: string; assistant: string; run: number;
  status: 'done' | 'setup_failed' | 'error';
  checks: Check[]; error?: string; seconds: number; costUsd: number;
  /** Turns where an assistant said it saved something but called no write tool that turn, per assistant. */
  claimedSaves?: Record<string, number>;
}

export interface Row { scenario: string; assistant: string; runs: number; passed: number; notTested: number; failures: string[] }

const failedChecks = (r: RunResult): Check[] => r.checks.filter((c) => !c.pass && !c.notTested);

/** pass: every check passed. not_tested: nothing failed but some check could not be tested (never a pass). fail: the rest. */
export function outcome(r: RunResult): 'pass' | 'fail' | 'not_tested' {
  if (r.status !== 'done' || r.checks.length === 0 || failedChecks(r).length > 0) return 'fail';
  return r.checks.some((c) => c.notTested) ? 'not_tested' : 'pass';
}
export const runPassed = (r: RunResult): boolean => outcome(r) === 'pass';

export function failureReasons(r: RunResult): string[] {
  if (r.status !== 'done') return [`${r.status === 'error' ? 'harness error' : 'setup failed'}: ${r.error ?? ''}`.trim()];
  const out = failedChecks(r).map((c) => `${c.name}: ${c.reason}`);
  if (out.length === 0) return r.checks.filter((c) => c.notTested).map((c) => `not tested, ${c.name}: ${c.reason}`);
  return out;
}

/** Pass rate per scenario and assistant: a run passes only when every check passes; runs with a not-tested check are counted apart. */
export function aggregate(results: RunResult[]): Row[] {
  const rows = new Map<string, Row>();
  for (const r of results) {
    const key = `${r.scenario}|${r.assistant}`;
    const row = rows.get(key) ?? { scenario: r.scenario, assistant: r.assistant, runs: 0, passed: 0, notTested: 0, failures: [] };
    row.runs++;
    const o = outcome(r);
    if (o === 'pass') row.passed++;
    else { if (o === 'not_tested') row.notTested++; row.failures.push(...failureReasons(r).map((f) => `run ${r.run}: ${f}`)); }
    rows.set(key, row);
  }
  return [...rows.values()].sort((a, b) => a.scenario.localeCompare(b.scenario) || a.assistant.localeCompare(b.assistant));
}

/** Pass rate per check tag (S1..S6, A1..A4) and assistant; not-tested checks are counted apart and are not in `passed`. */
export function byTag(results: RunResult[]): { tag: string; assistant: string; passed: number; total: number; notTested: number }[] {
  const m = new Map<string, { tag: string; assistant: string; passed: number; total: number; notTested: number }>();
  for (const r of results) {
    for (const c of r.checks) {
      const k = `${c.tag}|${r.assistant}`;
      const e = m.get(k) ?? { tag: c.tag, assistant: r.assistant, passed: 0, total: 0, notTested: 0 };
      e.total++; if (c.notTested) e.notTested++; else if (c.pass) e.passed++;
      m.set(k, e);
    }
  }
  return [...m.values()].sort((a, b) => a.tag.localeCompare(b.tag) || a.assistant.localeCompare(b.assistant));
}

export function markdownTable(rows: Row[]): string {
  const lines = ['| Scenario | Assistant | Passed | Not tested | Rate |', '|---|---|---|---|---|'];
  for (const r of rows) lines.push(`| ${r.scenario} | ${r.assistant} | ${r.passed}/${r.runs} | ${r.notTested} | ${Math.round((100 * r.passed) / r.runs)}% |`);
  return lines.join('\n');
}
