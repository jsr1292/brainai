import type { Kind } from './assistants.js';
import type { Scenario } from './scenario.js';

export interface Options { runs: number; only: string[] | null; assistants: Kind[]; out: string; fakeEmbedder: boolean; modelDir: string; skipIsolation: boolean; report: string | null }

export function parseArgs(argv: string[], env: NodeJS.ProcessEnv = {}): Options {
  const o: Options = { runs: 3, only: null, assistants: ['claude', 'codex'], out: 'bench-results', fakeEmbedder: false, modelDir: env.MODEL_DIR ?? './models', skipIsolation: false, report: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const val = (): string => { const v = argv[++i]; if (v === undefined) throw new Error(`${a} needs a value`); return v; };
    if (a === '--runs') { const n = Number(val()); if (!Number.isInteger(n) || n < 1) throw new Error('--runs must be a whole number of at least 1'); o.runs = n; }
    else if (a === '--only') o.only = val().split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
    else if (a === '--assistants') {
      const l = val().split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
      for (const x of l) if (x !== 'claude' && x !== 'codex') throw new Error(`unknown assistant ${x} (use claude, codex)`);
      if (l.length === 0) throw new Error('--assistants needs at least one');
      o.assistants = l as Kind[];
    } else if (a === '--out') o.out = val();
    else if (a === '--report') o.report = val();
    else if (a === '--skip-isolation') o.skipIsolation = true;
    else if (a === '--fake-embedder') o.fakeEmbedder = true;
    else if (a === '--model-dir') o.modelDir = val();
    else throw new Error(`unknown option ${a}`);
  }
  return o;
}

/** Picks scenarios by id; an unknown id is an error, not a silent skip. */
export function selectScenarios(all: Scenario[], only: string[] | null): Scenario[] {
  if (!only) return all;
  const ids = new Set(all.map((s) => s.id));
  for (const id of only) if (!ids.has(id)) throw new Error(`unknown scenario ${id} (have ${[...ids].join(', ')})`);
  return all.filter((s) => only.includes(s.id));
}
