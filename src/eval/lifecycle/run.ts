/**
 * End-to-end memory loop eval: npm run eval:lifecycle -- --runs 3 --only S1,S4 --assistants claude,codex --out bench-results
 * See docs/LIFECYCLE-EVAL.md.
 */
import { mkdirSync, writeFileSync, existsSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setupText } from '../../setup/texts.js';
import { Session, tempCwd, removeClaudeProjectDir, IsolationViolation, type AssistantConn, type Kind, type TurnRecord } from './assistants.js';
import { parseArgs, selectScenarios } from './args.js';
import { startBrain, type Brain } from './brain.js';
import { isolationCheck } from './isolation.js';
import { judge } from './judge.js';
import { aggregate, byTag, failureReasons, markdownTable, runPassed, type RunResult } from './report.js';
import { SetupFailed, type Check, type Ctx, type Who } from './scenario.js';
import { SCENARIOS } from './scenarios.js';
import { allFacts, claimedSavesWithoutWrite, s3StateChecks, suggestions, supersessions, toolCallsBy, type FactRow } from './scoring.js';

const NAME: Record<Kind, string> = { claude: 'Claude Code', codex: 'Codex' };
const SLUG: Record<Kind, string> = { claude: 'claude-code', codex: 'codex' };

function ownerActions(brain: Brain): Ctx['owner'] {
  const post = async (path: string): Promise<void> => {
    const r = await brain.owner(path, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: '' });
    if (r.status >= 400) throw new Error(`owner POST ${path} gave ${r.status}`);
  };
  return {
    deleteFact: (id) => post(`/memories/${id}/delete`),
    rejectSuggestion: (id) => post(`/suggestions/${id}/reject`),
    approveSuggestion: (id) => post(`/suggestions/${id}/approve`),
    approveHarvest: (batch) => post(`/harvest/${encodeURIComponent(batch)}/approve`),
    async addBuiltinSkill(name) {
      const row = brain.sql<{ id: string }>('SELECT id FROM skill_proposals WHERE name = ? ORDER BY rowid DESC', name)[0];
      if (!row) throw new Error(`no skill proposal for ${name}`);
      await post(`/skill-proposals/${row.id}/add`);
    },
  };
}

async function runOne(scenarioId: string, primaryKind: Kind, kinds: Kind[], runNo: number, o: ReturnType<typeof parseArgs>, outDir: string): Promise<RunResult> {
  const scenario = SCENARIOS.find((s) => s.id === scenarioId)!;
  const started = Date.now();
  const cwd = tempCwd();
  const turns: TurnRecord[] = [];
  const checks: Check[] = []; const notes: Record<string, unknown> = {};
  let brain: Brain | null = null; let status: RunResult['status'] = 'done'; let error: string | undefined;
  let snapshot: unknown = null; let fatal: Error | null = null;
  try {
    brain = await startBrain({ modelDir: o.modelDir, fakeEmbedder: o.fakeEmbedder });
    const b = brain;
    stopNow = async () => { await b.stop().catch(() => {}); removeClaudeProjectDir(cwd.path); cwd.remove(); };
    const other = kinds.find((k) => k !== primaryKind);
    const primary: Who = { kind: primaryKind, connection: NAME[primaryKind] };
    const peer: Who = other ? { kind: other, connection: NAME[other] } : { kind: primaryKind, connection: `${NAME[primaryKind]} 2` };
    const conns = new Map<string, AssistantConn>();
    const conn = async (w: Who): Promise<AssistantConn> => {
      let c = conns.get(w.connection);
      if (!c) {
        const token = await b.connect(w.connection);
        c = { kind: w.kind, connection: w.connection, token, mcpUrl: b.mcpUrl, systemText: setupText(SLUG[w.kind], b.mcpUrl) };
        conns.set(w.connection, c);
      }
      return c;
    };
    // Both connections exist from the start, like two apps the owner has already signed in.
    const pc = await conn(primary); const qc = await conn(peer);
    const ctx: Ctx = {
      brain: b, primary, peer,
      seeder: primaryKind === 'claude' ? primary : peer.kind === 'claude' ? peer : primary,
      session: (w, so) => new Session(w.connection === primary.connection ? pc : qc, cwd.path, turns, so),
      check: (c) => { checks.push(c); },
      async judge(tag, name, question, answer, rubric) {
        const v = await judge(cwd.path, question, answer, rubric);
        checks.push({ tag, name, pass: v.pass, reason: v.reason, kind: 'answer' });
        return v;
      },
      setup(name, pass, reason) { if (!pass) throw new SetupFailed(`${name}: ${reason}`); },
      note: (k, v) => { notes[k] = v; },
      owner: ownerActions(b),
    };
    await scenario.run(ctx);
    if (turns.some((t) => t.result.error && !t.result.text)) { status = 'error'; error = turns.find((t) => t.result.error && !t.result.text)!.result.error; }
  } catch (e) {
    if (e instanceof SetupFailed) { status = 'setup_failed'; error = e.message; } else { status = 'error'; error = e instanceof Error ? e.message : String(e); if (e instanceof IsolationViolation) fatal = e; }
  }
  if (brain) {
    try { snapshot = { facts: allFacts(brain), suggestions: suggestions(brain), supersessions: supersessions(brain), toolCalls: toolCallsBy(brain) }; } catch { /* brain already gone */ }
    await brain.stop().catch(() => {});
  }
  const costUsd = turns.reduce((s, t) => s + (t.result.costUsd ?? 0), 0);
  const result: RunResult = { scenario: scenarioId, assistant: primaryKind, run: runNo, status, checks, error, seconds: Math.round((Date.now() - started) / 1000), costUsd, claimedSaves: claimedSavesWithoutWrite(turns.map((t) => ({ who: t.connection, text: t.result.text, toolCalls: t.result.toolCalls, readOnly: t.readOnly }))) };
  writeFileSync(join(outDir, `${scenarioId}-${primaryKind}-${runNo}.json`), JSON.stringify({ ...result, notes, snapshot, turns }, null, 1));
  removeClaudeProjectDir(cwd.path);
  cwd.remove();
  if (fatal) throw fatal;
  return result;
}

let stopNow: (() => Promise<void>) | null = null;
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => { void (stopNow ? stopNow() : Promise.resolve()).finally(() => process.exit(130)); });

async function main(): Promise<void> {
  const o = parseArgs(process.argv.slice(2), process.env);
  const scenarios = selectScenarios(SCENARIOS, o.only);
  const date = new Date().toISOString().slice(0, 10);
  if (o.report) { reportFrom(o.report, o.out, date); return; }
  const outDir = join(o.out, `lifecycle-${date}`);
  mkdirSync(outDir, { recursive: true });

  if (!o.skipIsolation) {
    console.log('Isolation self-check ...');
    const brain = await startBrain({ modelDir: o.modelDir, fakeEmbedder: o.fakeEmbedder });
    const cwd = tempCwd();
    stopNow = async () => { await brain.stop().catch(() => {}); removeClaudeProjectDir(cwd.path); cwd.remove(); };
    try {
      const conns: AssistantConn[] = [];
      for (const k of o.assistants) conns.push({ kind: k, connection: NAME[k], token: await brain.connect(NAME[k]), mcpUrl: brain.mcpUrl, systemText: setupText(SLUG[k], brain.mcpUrl) });
      const rep = await isolationCheck(conns, cwd.path);
      for (const l of rep.lines) console.log('  ' + l);
      writeFileSync(join(outDir, 'isolation-check.json'), JSON.stringify(rep, null, 1));
      if (!rep.ok) { console.error('ISOLATION CHECK FAILED: aborting, no scenario was run.'); process.exitCode = 2; return; }
      console.log('Isolation check passed.');
    } finally {
      removeClaudeProjectDir(cwd.path);
      cwd.remove(); await brain.stop();
    }
  }

  const results: RunResult[] = [];
  for (const sc of scenarios) {
    for (const a of o.assistants) {
      for (let n = 1; n <= o.runs; n++) {
        const r = await runOne(sc.id, a, o.assistants, n, o, outDir);
        results.push(r);
        console.log(`${sc.id} ${a} run ${n}: ${runPassed(r) ? 'PASS' : 'FAIL'} (${r.seconds}s)${runPassed(r) ? '' : ' - ' + failureReasons(r).join(' | ').slice(0, 300)}`);
      }
    }
  }
  publish(results, o.out, date, { ...o });
}

function publish(results: RunResult[], out: string, date: string, options: unknown): void {
  const rows = aggregate(results);
  console.log('\n' + markdownTable(rows));
  console.log('\nBy check:');
  for (const t of byTag(results)) console.log(`  ${t.tag} ${t.assistant}: ${t.passed}/${t.total}`);
  console.log('\nFailures:');
  for (const r of rows) for (const f of r.failures) console.log(`  ${r.scenario} ${r.assistant} ${f}`);
  const claims: Record<string, number> = {};
  for (const r of results) for (const [who, n] of Object.entries(r.claimedSaves ?? {})) claims[who] = (claims[who] ?? 0) + n;
  const summary = { date, options, rows, byTag: byTag(results), claimedSavesWithoutWrite: claims, results, totalSeconds: results.reduce((s, r) => s + r.seconds, 0), totalCostUsd: results.reduce((s, r) => s + r.costUsd, 0) };
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, `lifecycle-${date}.json`), JSON.stringify(summary, null, 1));
  console.log(`\nTurns where an assistant claimed a save with no write call, by assistant: ${JSON.stringify(claims)}`);
  console.log(`Wrote ${join(out, `lifecycle-${date}.json`)}`);
}

/** Rebuilds the table and summary from the per-run transcript files in a folder (so a re-run of a few scenarios can be merged in). */
function reportFrom(dir: string, out: string, date: string): void {
  const results: RunResult[] = [];
  for (const f of readdirSync(dir).sort()) {
    if (!/^[A-Z0-9]+-(claude|codex)-\d+\.json$/.test(f)) continue;
    const r = JSON.parse(readFileSync(join(dir, f), 'utf8')) as RunResult & { turns?: TurnRecord[]; snapshot?: { facts?: FactRow[] } };
    if (r.turns) r.claimedSaves = claimedSavesWithoutWrite(r.turns.map((t) => ({ who: t.connection, text: t.result.text, toolCalls: t.result.toolCalls, readOnly: t.readOnly })));
    // Re-score what the saved brain snapshot allows: S3's state checks. The judge's answer check is kept as it was.
    if (r.scenario === 'S3' && r.status === 'done' && r.snapshot?.facts) {
      const app = r.assistant === 'claude' ? 'Claude Code' : 'Codex';
      r.checks = [...s3StateChecks(r.snapshot.facts, app), ...r.checks.filter((c) => c.kind !== 'state')];
    }
    delete r.turns; delete r.snapshot;
    results.push(r);
  }
  publish(results, out, date, { report: dir });
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
