Leer en español: [docs/es/REPRODUCE.md](es/REPRODUCE.md)

# Check our claims

BrainAI's docs make claims about what it does: recall finds the right fact, a backup restores everything, the security
boundaries hold, assistants use the memory loop properly. Each claim comes with a command, so you can check it on your own
computer instead of taking our word for it. Everything below runs against throwaway data in temporary folders; none of
it touches a brain you already have.

If your results differ from ours, please open an issue with the result file (each command says where it writes one), your
OS, Node version and the commit you ran. A security problem goes through the private route in `SECURITY.md` instead.

## Setup (once)

You need Node 22 or newer, `git` and `sqlite3`. `age` is optional (the restore drill's off-site path uses it; without it
that path is reported as skipped, never as passed).

```bash
git clone https://github.com/jsr1292/brainai.git && cd brainai
npm ci
npm run model        # downloads the local search models into ./models (about 275 MB); only the model runs need them
```

## What to run

| Claim | Where it is written | Command | Time | Needs |
|---|---|---|---|---|
| The whole test suite passes (about 3,350 tests, including every security test) | — | `npm test` | about 5 min | — |
| The trust boundaries hold: grants, pause and "saves wait", dashboard auth, CSRF/Origin, XSS, instruction-like text, hostile files | [docs/SECURITY.md](SECURITY.md) | `node --import tsx --test src/security/*.test.ts` | about 10 s | — |
| Every kind of backup restores onto a clean machine: 192 checks | [docs/RESTORE-DRILL.md](RESTORE-DRILL.md) | `npm run drill:restore` | about 5 s | `age` for path c |
| The same, with the real default search model | [docs/RESTORE-DRILL.md](RESTORE-DRILL.md) | `MODEL_DIR=./models npm run drill:restore -- --real-model` | about 10 s | the models |
| The same, with the older e5 model | [docs/RESTORE-DRILL.md](RESTORE-DRILL.md) | `EMBED_MODEL=e5 MODEL_DIR=./models npm run drill:restore -- --real-model` | about 10 s | the models |
| The search models behave as calibrated (duplicates, off-topic questions, rewordings) | comments in `src/memory/embeddingProfile.ts` | `npm run test:model` | about 5 s | the models |
| Real assistants keep, recall, replace and forget facts properly, failures included | [docs/LIFECYCLE-EVAL.md](LIFECYCLE-EVAL.md) | `MODEL_DIR=./models npm run eval:lifecycle` | about 45 min, about $6 | `claude` and `codex`, signed in |
| Retrieval on LongMemEval: the right conversation is found | [docs/BENCHMARK.md](BENCHMARK.md) | `npm run bench:longmemeval -- --sample 20` | about 2 hours the first time (140 questions), 1 to 2 min after that | the models, a download |
| Retrieval on LoCoMo | [docs/BENCHMARK.md](BENCHMARK.md) | `npm run bench:locomo` | about 3 min | the models, a download |

Results go to `bench-results/` (ignored by git) unless a command says otherwise.

## What to expect

- **Tests and the restore drill** give the same result every time: everything passes, or the drill exits with 1 and
  names the check that failed.
- **The memory loop eval** drives real assistants, so single runs vary. Compare scenario by scenario with the tables
  in [docs/LIFECYCLE-EVAL.md](LIFECYCLE-EVAL.md), not the total: 3 runs per scenario is a smoke test, not a reliability
  estimate. A cheaper first try is one assistant, one run: `MODEL_DIR=./models npm run eval:lifecycle -- --runs 1 --assistants claude`
  (about 6 minutes). It uses your own Claude Code and Codex accounts, so it costs what their turns cost. Before any
  scenario runs, it checks that the assistants can reach nothing but the throwaway brain (no other MCP servers, no hooks,
  no shell, no web search for Codex) and stops if they can. Saved runs can be re-scored without running anything:
  `npm run eval:lifecycle -- --report <folder>`.
- **The benchmarks** download their datasets from pinned commits and check their SHA-256 before scoring; a file that
  doesn't match is refused.

## What these checks cannot show

They are our own tests. They show that the code does what the docs say on the cases we thought of; they are not an
independent security audit, and they say nothing about how BrainAI holds up over weeks of use by people other than its
author. The known gaps are listed in [docs/SECURITY.md](SECURITY.md) and [docs/LIFECYCLE-EVAL.md](LIFECYCLE-EVAL.md).
