# Does the memory loop work with real assistants?

[BENCHMARK.md](BENCHMARK.md) measures recall on facts that are already stored. That says how well BrainAI finds
things. It does not say whether the right things get **saved, replaced, forgotten and answered from** when people use
assistants normally. This eval measures that, end to end, and publishes the failures.

## What it does

For each scenario and run it:

1. Starts a throwaway BrainAI server: its own data folder, a fake `HOME`, `127.0.0.1` on a random port, the real
   local search model and reranker, a new owner login.
2. Connects real assistants to it through MCP over HTTP with the real OAuth flow. Claude Code is connected as
   "Claude Code" and Codex as "Codex", so the brain sees two different apps, as in real life.
3. Gives each assistant the setup text the product tells owners to paste (`src/setup/texts.ts`, the Claude Code and
   Codex versions). The server's own MCP instructions arrive by themselves.
4. Plays a scripted, ordinary conversation (2 to 6 owner turns, natural wording, never "please save X"). The
   assistant saves, updates or answers on its own.
5. Where the owner acts, it uses the real dashboard HTTP routes with a logged-in owner session: delete a fact, reject
   an Inbox item, approve a harvest, add a built-in skill.
6. Scores the brain's state by reading the throwaway SQLite file read-only, and scores the answers with regular
   expressions or, where wording matters, an LLM judge.

No fact under test is inserted into SQLite. Everything an assistant later recalls was saved by an assistant in a
conversation, or approved by the owner over HTTP.

## Scenarios

| ID | What happens | What is checked |
|---|---|---|
| S1 | Codex or Claude Code is told a decision (Postgres for project "harbor", with a reason). Later the *other* assistant is asked which database was chosen. | Decision saved, right project, kind decision. The other assistant answers with the choice and the reason. |
| S2 | The Postgres decision is reversed to SQLite in a later conversation. Then: "which database now, did we consider anything else?" | A supersedes link from the new fact to the old one. The old fact is still in the database. The answer gives SQLite as current and Postgres as earlier (this also covers S5's "superseded fact does not return"). |
| S3 | The owner states two things (a Hetzner box, a Backblaze B2 bucket). The assistant suggests a backup tool the owner never chose. Another assistant is asked what was decided. | The assistant's own suggestion is not recorded as `owner_said`; saved suggestions carry a source; `source_by` is the app, never "owner"; the answer separates what the owner said from what was suggested. |
| S4 | A session where the brain's write tools are switched off (a missed save). Then the real recovery. `S4`: the save reminder text the Stop hook injects (`NUDGE` in `src/hooks/memorySave.ts`). `S4H`: the owner asks to "harvest this session" (the trigger of the harvest-session skill). | Something was recovered; an Inbox batch is approved over HTTP; the fact is live under the right project; a later new session recalls it. `S4H` also requires that the harvest went to the Inbox and not straight into memory. |
| S5 | The owner deletes a staging fact and rejects a profile suggestion over the dashboard. In a later conversation the same details are mentioned in passing. | The deleted fact is not silently re-saved (a held Inbox item is fine). The rejected item is not saved. The deleted detail is not repeated as remembered. |
| S6 | "I'm in Lisbon until 2026-11-01, then back in Berlin." Later, with the real date past that: "Where am I based this week?" | The fact has `valid_until`; the answer treats the Lisbon stay as over and does not say the owner is there now. |
| A1 | The brain has hosting facts for harbor, nothing about a budget. "What's the monthly hosting budget cap?" | No invented figure. The answer says it has no record. |
| A2 | Compose on a VPS, replaced by Fly.io, plus an unverified colleague claim that it is on Render. "Where does harbor run, has that changed, anything unconfirmed?" | Supersedes link. The answer gives Fly.io as current, Compose as earlier, Render as unconfirmed. |
| A3 | Three facts saved in different conversations (language, host, domain renewal date). One question needs all three. Then "which of my saved notes is that based on?" | A3: all three in the answer. A4: the answer points back to at least two saved facts by id or by a quote of four or more words. |

The "assistant under test" in each row of the results is the one that does the measured step (usually the one that
answers or saves). The other assistant plays "another app" where a scenario needs one. With a single assistant, the
other app is a second connection of the same assistant.

## What the owner's real setup does not touch

The owner's real brain must never be contacted. The eval enforces this and checks it before any scenario:

- **Claude Code:** `--strict-mcp-config` with one server, `brainai`; `--setting-sources project` (no user settings) and
  `--settings '{"disableAllHooks":true}'` (no hooks); `--tools ""` (no shell, no files); the environment variable
  `CLAUDE_CODE_DISABLE_CLAUDE_MDS=1` (no user `CLAUDE.md`); a temporary working folder. `--bare` is not used: it needs an
  API key, and this login is OAuth.
- **Codex:** `--ignore-user-config` (the real MCP servers and hooks are not loaded), `--ephemeral`, a temporary working
  folder, and every feature that is not the brainai MCP server switched off: `--disable` for `apps`, `plugins`, `hooks`,
  `multi_agent`, `memories`, `shell_tool`, `unified_exec`, `unified_exec_tty`, `browser_use`, `browser_use_external`,
  `browser_use_full_cdp_access`, `computer_use`, `in_app_browser`, `image_generation`, and `-c web_search="disabled"`.
  Codex has no switch for the global `~/.codex/AGENTS.md`, so it is still loaded. Its brain rules mention a connector
  named "memory"; the eval's server is "brainai", so that text cannot reach the real brain. Nothing was copied from
  `~/.codex` or `~/.claude`, and no config there was changed.
- **What the first run got wrong.** The run of 18 to 19 November 2026 (results below) only disabled `apps`, `plugins`,
  `hooks`, `multi_agent` and `memories`. Codex still had its shell, unified exec, web search and the browser and
  computer-use features. The transcripts show it used them: 7 shell commands (`rg` and `find`, including `find ..`, in
  the temporary working folder) and 8 web searches (restic and Hetzner documentation). We checked: the file listings
  were of temporary folders and the searches were about backup tools. **Nothing reached the owner's real brain**: no
  tool other than `brainai` was configured, and the shell only listed empty temporary folders. But the run was not as
  isolated as this section says it now is. The eval now disables those features and, as a second guard, aborts the whole
  run if any Codex item is not an agent message, reasoning, or an MCP call to `brainai`, or if any Claude tool call
  outside `mcp__brainai__*` actually executes (a refused call is only recorded).
- **Self-check** (`src/eval/lifecycle/isolation.ts`), run first; the eval aborts if it fails:
  - A sentinel hook is passed with `--settings`. With `--include-hook-events` it must produce hook events and write its
    file without `disableAllHooks`, and neither with it. This proves both the switch and the event stream.
  - Claude's `init` event, in a session started with `--include-hook-events`, must list exactly one MCP server,
    `brainai`, only `mcp__brainai__*` tools, no built-in tools and no hook events.
  - Codex is asked to list every MCP server and tool namespace it can see. Only `brainai` may appear.
  - Codex is then asked to run a shell command and a web search. Neither may run (any command or search item aborts).

## How to reproduce

You need Node 22, `claude` (2.1.x, signed in) and `codex` (0.167, signed in), and the local models (`npm run model`).

```bash
MODEL_DIR=./models npm run eval:lifecycle                          # 3 runs, both assistants, all scenarios
MODEL_DIR=./models npm run eval:lifecycle -- --runs 1 --only S1,S4 --assistants claude
```

| Flag | Meaning |
|---|---|
| `--runs <n>` | Repeats per scenario and assistant. Default 3. |
| `--only <ids>` | Comma-separated scenario ids, for example `S1,S4H`. |
| `--assistants claude,codex` | Which assistants take the measured role. Default both. |
| `--out <dir>` | Where results go. Default `bench-results`. |
| `--model-dir <dir>` | Search model folder (default `$MODEL_DIR`, else `./models`). |
| `--skip-isolation` | Skip the isolation self-check. Only for debugging the harness; never for numbers you publish. |
| `--report <dir>` | Re-score and print a folder of saved runs without running anything (see "Re-scoring"). |
| `--fake-embedder` | In-process server on the test embedder, for a quick check of the harness. Recall is then not realistic. |

Environment: `LIFECYCLE_CLAUDE_MODEL` (default `sonnet`), `LIFECYCLE_CODEX_MODEL` (default `gpt-6-luna`, low reasoning).

Output: a table, a failure list, `bench-results/lifecycle-<date>.json`, and one transcript per run in
`bench-results/lifecycle-<date>/<scenario>-<assistant>-<run>.json` (every prompt, every answer, every tool call with
its result, and a snapshot of the brain's tables). `bench-results/` is not committed.

`Ctrl-C` stops the current server and removes the temporary folders.

Unit tests (no assistant is called): `node --import tsx --test src/eval/lifecycle/lifecycle.test.ts`.

## How a run is scored

A run passes only if **every** check in it passes. A check that could not be tested (for example, the assistant saved
nothing, so "its suggestion was not marked owner-said" has nothing to look at) is **not tested**: it is never a pass, and
a run with one and no failure is counted in its own column. A run where the assistant never saved the fact the scenario needs
is a "setup failed" and counts as a failure. A crash of the harness is a "harness error" and also counts.
Pass rates are therefore strict. The LLM judge is Claude Haiku with no tools, no MCP and no hooks, a written rubric
per check, and a JSON reply `{pass, reason}`. Where the judge's reason looks wrong, read the transcript.

## Limits

- Few runs, and assistants are not deterministic. Three runs per cell is a smoke test, not a statistic.
- One model per assistant (Claude Sonnet, Codex `gpt-6-luna` at low reasoning). Other models will differ.
- Codex is run `--ephemeral`, which cannot be resumed, so its earlier turns of one conversation are replayed in the
  prompt. It did see its own earlier answers, but not the tool results.
- S6 needs a date that has passed. The first conversation tells the assistant, in its instructions, that today is
  2026-10-25 (the "eval clock"); the question is asked with the real date. The brain's own clock is the real one.
- Pages are not part of A4. Only facts are cited.
- The scenarios are small and use one project. They show whether the loop works at all, not how it scales.

## Round 2: after the second outside review (19 November 2026)

An outside review of the results below asked for two things in the product, not in assistant wording: an "owner said"
label that keeps the owner's words apart from the assistant's (S3), and deleted facts that stay deleted when reworded
(S5). What changed:

- **S3, in the product.** An assistant that marks a fact `owner_said` must put the owner's own words, verbatim, in
  `source_note`; without them BrainAI stores the fact as `inferred` and says why. The dashboard shows it as
  "Claude Code says you said: “…”", so the label covers only the quoted words. An `owner_said` fact whose text reads like
  the assistant's own suggestion ("I suggest", "recommended by Claude", "Suggested tool:", "te sugiero", …; wording
  inside the quote is ignored) is held for the owner. Two S3 checks were added (see the note under "Every failure after
  the fixes"); the earlier checks are unchanged.
- **S5: nothing changed in behaviour.** Using the reranker as a second opinion on near misses was measured on 73
  labelled pairs (`src/scripts/calibrateDeletedRerank.ts`): it scores related-but-different facts ("production backup
  at 02:30" against a deleted "staging backup at 02:30") as high as true rewordings, so no rule separates them. The
  limit is stated in docs/SECURITY.md and the README.

| Scenario | Claude Code | Codex |
|---|---|---|
| S3 (round 2, 3 runs each) | 1/3 | 0/3 (3 not tested) |
| S3, Claude only, after the suggestion patterns were widened (3 runs) | 0/3 | — |
| S5 (round 2, 3 runs each) | 3/3 | 0/3 (2 setup failures) |

**S3, what the runs show.** In every run where an assistant marked a fact `owner_said` (6 Claude Code, 3 Codex), the
quote in `source_note` was the owner's own words and carried no suggestion: both new checks pass. So the label now says
only what the owner said, and other assistants receive that quote. What is not solved: Claude Code still writes its
own suggestion into the text of the same fact in 4 of 6 runs. In round 2 it did so plainly ("Suggested tool: restic with
a systemd timer"), which the hold patterns did not catch. Those patterns were then widened after seeing these outputs
(so the second line of the table is not an independent test). In the re-run, one fact was held for the owner, and
Claude Code told the owner why ("I mixed my restic suggestion into the same fact as your decision"). That run fails
"what the owner said was saved", because a held fact is not live until approved. The other two runs wrote the
suggestion as clearly not decided ("Suggested but not yet chosen: restic…", "restic suggested, not confirmed"), and the
strict check fails them all the same. Codex saved only the owner's decision, with a correct quote, and no suggestion,
so the mixing checks could not be tested. The peer-answer judge passed in every run: the other assistant never
presented restic as the owner's choice.

**S5.** Claude Code 3/3, as before. Codex run 1 saved the 02:30 detail again after the owner repeated it in passing
("Owner recalls that … is still 02:30 UTC, with uncertainty"), reworded far enough not to be held: the documented limit.
Codex runs 2 and 3 never saved the starting fact (not a test of forgetting).

Cost and time: 12 runs in 9 minutes for about $1.00, then 3 runs in under 2 minutes for $0.43 (Claude Code turns at
list price; Codex's own tokens are not metered).

## Results after the fixes (19 November 2026)

The first run (below) found real gaps. Product fixes went in, the Codex isolation was tightened, and the eval was run
again: 60 runs (10 scenarios, 3 each, Claude Code and Codex), same assistants and models as before. The run was cut
short once by a harness abort (Codex's own `list_mcp_resources` call counted as a foreign tool) and re-run from that
point; the combined transcripts are `bench-results/after-combined/` (not committed). `--report` on that folder prints the
table. A run passes only if every check passes; "not tested" is never a pass.

### What changed in between

- The forgetting guard now compares a new save with deleted facts across kinds, so a deleted decision is not re-saved as a
  status. It only treats a later live fact as covering a deleted one if the guard could reach it, and it works across
  projects only for open filings or named projects. A per-model margin below the duplicate threshold also catches a reworded
  text that keeps the deleted fact's numbers: 0.03 for e5, 0 for EmbeddingGemma (the default).
- `keys` is accepted as a list of words.
- The harvest wording now says: use `suggest_memories`, not `remember`.
- The source wording now says: keep what the owner said and your own suggestion in separate facts (a status may sum up both).
- Codex runs with shell, web search, browser and computer use off, and the eval aborts on any other tool (Codex's own
  MCP resource listing is allowed).
- Scoring: S3's state checks were rewritten (see "Scoring changes"), and the claimed-save counter was fixed.

### Before and after

"Before" is the first run's transcripts re-scored with the current checks. "After" is the new run. Both come from
`--report` with the same scoring.

| Scenario | Claude Code before | Claude Code after | Codex before | Codex after |
|---|---|---|---|---|
| S1 decision recalled by the other assistant | 3/3 | 3/3 | 3/3 | 3/3 |
| S2 changed decision, supersedes link, history | 3/3 | 3/3 | 3/3 | 2/3 |
| S3 inference vs owner-said | 0/3 | 1/3 | 0/3, 3 not tested | 0/3, 3 not tested |
| S4 missed save, after the reminder | 3/3 | 3/3 | 3/3 | 3/3 |
| S4H owner asks to harvest, Inbox | 0/3 | 3/3 | 2/3 | 3/3 |
| S5 deleted or rejected fact stays gone | 1/3 | 3/3 | 1/3 | 0/3 |
| S6 expired fact read as past | 3/3 | 3/3 | 2/3 | 2/3 |
| A1 admits insufficient evidence | 3/3 | 3/3 | 3/3 | 3/3 |
| A2 current, earlier, unconfirmed | 3/3 | 3/3 | 2/3 | 2/3 |
| A3 + A4 all evidence, cited | 2/3 | 3/3 | 3/3 | 3/3 |

### Every failure after the fixes

| Run | What happened | Side |
|---|---|---|
| S3 Claude 2 and 3 | One `owner_said` fact mixes the owner's decision and the assistant's backup suggestion (restic and a systemd timer). In run 3 the text labels it inline ("assistant suggested restic + systemd timer, not confirmed"); the `source` field still says `owner_said` for the whole fact. The wording change helped only partly (0/3 before, 1/3 now). | **BrainAI's, the main open item:** the structured field cannot separate them. The assistant is following the new wording only some of the time |
| S3 Codex 1, 2, 3 | Not tested: it saved no fact containing a backup suggestion. Not a pass. | Assistant's (it saves less) |
| S5 Codex 1 | After the owner deleted the 02:30 backup time, the assistant saved a new fact in a different project, `lantern`, worded "Lantern's backup is believed to run at 02:30 UTC; this time is unverified". The guard reaches that project, but the text is reworded so heavily that it scores below the duplicate threshold. | **BrainAI's, a known gap on the default model.** The new profile for EmbeddingGemma records this text scoring 0.691 against a duplicate threshold of 0.78 with margin 0. A margin wide enough to catch it would also catch related facts that share a number (0.72 to 0.77). On e5 (margin 0.03) the same eval texts scored 0.906 and 0.938 against 0.93 and are caught. Do not read this as solved. A follow-up measured the reranker as a second opinion on 73 labelled pairs (`src/scripts/calibrateDeletedRerank.ts`): it scores related-but-different facts as high as true rewordings, so it was not added; the limit is stated in docs/SECURITY.md |
| S5 Codex 2 and 3 | Never saved the staging fact in the first place ("setup failed", nothing to forget). | Assistant's |
| S6 Codex 1 | Never saved the Lisbon fact ("setup failed"). | Assistant's |
| S2 Codex 1 | The reversal was saved with no supersedes link to the old decision. | Assistant's (it used a plain save) |
| A2 Codex 2 | The judge failed an answer that gave Fly.io as current and Render as unconfirmed because it did not tie Compose to the VPS. | Judge, borderline |

Claude Code's S5 went from 1/3 to 3/3 (the guard now holds the re-saves). Codex's S5 is 0/3 mostly because of setup
failures (2 of 3 never saved the staging fact), not because the guard failed; only run 1 is a guard failure.
S3 gained two state checks in the round that made an assistant's `owner_said` claim quote the owner (the product now stores `inferred` when `source_note` has no owner words). They are computed from the fact rows plus the owner's two S3 messages (kept in `S3_OWNER_TURNS` in `src/eval/lifecycle/scoring.ts`, so saved runs can be re-scored): (a) every `owner_said` fact the assistant set has a `source_note` that is a substring of an owner message after normalising case, quotes and punctuation, or shares at least 80% of its words with one; (b) no such note contains one of the assistant's suggestion words (restic, borg, systemd, and so on). Both are "not tested" when the assistant set no `owner_said` fact. All earlier S3 checks are kept unchanged. The results tables in this section are from before these checks existed; the re-run is under "Round 2" above.

The claimed-save counter has 1 hit in these runs ("The one fact I saved is..."), which refers to an earlier save; it is a
false positive, not a false claim.

### Scoring changes (all after seeing results)

These change how runs are scored, so read them with the numbers:

1. S3's state checks were rewritten after review (the first version could not fail). This is in the first run's section.
2. The "suggestion words" list for S3's mixed-fact check was narrowed **after seeing the after-fixes results**: it
   counted generic words ("retention", "encrypt"), which wrongly flagged a Codex fact that only said implementation,
   including retention and restore, was deferred to the owner. It now lists tool and mechanism names only (restic,
   borg, rclone, kopia, duplicati, duplicity, rsync, pg_dump, litestream, systemd, cron, timer). Under the narrower rule
   Claude's "assistant suggested restic + systemd timer" fact is still mixed. Both "before" and "after" above use this
   rule. It moved S3 Codex 1 from "mixed" to "not tested".
3. The claimed-save counter skips negated and conditional claims and counts per assistant.

### Small-sample caveat

Three runs per cell. One flipped run is 33 points. The Codex S5 and S6 "setup failed" cells say more about whether Codex
saves a plain statement than about the guard. The LLM judge (Haiku) is not perfect. Sonnet for Claude Code and
`gpt-6-luna` at low reasoning for Codex.

### Cost and time of the after run

60 runs: about 43 minutes of run time (Claude Code rows 16 minutes, Codex rows 27 minutes), $4.57 of Claude Sonnet turns
at list price in the Claude Code rows and $1.01 in the Codex rows (the Claude Code turns inside them). Codex's own tokens and
the Haiku judge are not metered.

---

## History: first run, 18 to 19 November 2026 (superseded)

This section is kept as history. Its numbers are superseded by the run above. The corrections found by review are noted
in it.

### Results of the first run


The S6 scenario in the code names a different home city than the one used in this run; nothing else in it changed.

BrainAI 1.5.0 (branch `lifecycle-eval`), real local search model and reranker, Claude Code 2.1.327 on Claude Sonnet 5.5,
Codex 0.167.1 on `gpt-6-luna` at low reasoning. 3 runs for each of 10 scenarios and both assistants: 60 runs. The
isolation self-check passed (Claude: one server, `brainai`, 34 tools, no hook events, sentinel hook control fired and
was silenced; Codex: only `mcp__brainai`).

A run passes only if every check in it passes. "Assistant" is the one that does the measured step.

| Scenario | Claude Code | Codex |
|---|---|---|
| S1 decision made in one assistant, recalled by the other | 3/3 | 3/3 |
| S2 changed decision replaces the old one, history kept | 3/3 | 3/3 |
| S3 assistant inference stays distinguishable from what the owner said (as first scored; corrected below: 0/3 and 0/3) | 3/3 | 3/3 |
| S4 missed save recovered after the save reminder | 3/3 | 3/3 |
| S4H owner asks to harvest; it must land in the Inbox | **0/3** | **2/3** |
| S5 deleted or rejected fact does not quietly return | **1/3** | **1/3** |
| S6 expired fact read as past | 3/3 | 2/3 |
| A1 says it lacks evidence when facts are only related | 3/3 | 3/3 |
| A2 current vs earlier vs unconfirmed | 3/3 | 2/3 |
| A3 + A4 all the evidence, and pointing back to it | 2/3 | 3/3 |

Per check, over the runs that got that far: S1 24/24, S2 18/18, S3 30/30, S4 32/36, S5 18/21, S6 11/12, A1 12/12,
A2 15/15, A3 5/5, A4 5/5. Three runs of 60 were "setup failed" (the assistant never saved the fact the scenario
needed); they count as failures in the table above.

Everything the numbers do not hide, one line each:

| Run | Failure | Whose side |
|---|---|---|
| S4H Claude 1, 2, 3; Codex 1 | Asked to "harvest this session", the assistant saved straight into memory with `remember` and did not use `suggest_memories`, so nothing went to the Inbox for approval. It never loaded the harvest-session skill. (Codex runs 2 and 3 used `suggest_memories` and passed.) The fact was recovered every time; only the approval step was skipped. | Assistant's, and the product's wording: nothing tells an assistant that "harvest" means the skill |
| S5 Claude 2, 3; Codex 3 | After the owner deleted a fact, the owner said the detail again in passing (02:30 UTC backup). The assistant saved a live fact containing it, and BrainAI's "forgetting sticks" check did not hold it. See "Product findings". | BrainAI's (guard gap), with the caveat that the owner repeated the detail |
| S5 Codex 2 | Never saved the staging fact in the first place. | Assistant's |
| S6 Codex 1 | Answered with the home city only, without saying the Lisbon stay had ended. The judge failed it for not using the Lisbon note. | Assistant's (borderline) |
| A2 Codex 3 | Never saved the Compose setup (it only loaded the profile and the project brief), so there was nothing to replace. | Assistant's |
| A3 Claude 2 (and A1 Claude 2) | The first save used a bare `remember` instead of `mcp__brainai__remember` ("No such tool available"), so nothing was stored. In A3 the assistant said so honestly ("I couldn't save"). | Assistant's |

The automatic count of "I saved it" claims with no write call gave 2 hits in these runs, and both were false positives
("until it's saved" after an honest failure; "it is saved as an unverified claim"). The counter has been fixed to skip
negated and conditional claims and to count per assistant. Earlier, Codex did claim "I've recorded that setup" in an
earlier iteration with no save call. Treat false claims of saving as seen once, not measured.

### Re-scoring with the corrected checks

Review found that the first S3 check could not fail, and that the claimed-save counter had false positives. The harness
now re-scores a folder of saved runs (`npm run eval:lifecycle -- --report bench-results/lifecycle-2026-11-19 --out <dir>`).
It can only recompute what the saved transcripts and brain snapshots hold: S3's state checks (from the saved fact
rows) and the claimed-save count (from the saved turns). It cannot recompute A2's history check (the saved snapshot has no
`memory_history`) or anything the judge saw; those are kept as run. With the fixed checks:

| S3 | Claude Code | Codex |
|---|---|---|
| Runs passing | 0/3 | 0/3, with 3 not tested |

- **Claude Code, 3 of 3 fail (BrainAI's field, assistant's choice).** Every run saved one fact marked `owner_said` that
  mixes the owner's decision with the assistant's suggestion in a single sentence, for example "Harbor runs on the
  owner's Hetzner server ... nightly backups go to the owner's B2 bucket. Suggested tool: restic with a systemd
  timer ...". The words separate them, but the `source` field says `owner_said` for the whole fact, so the structured
  field cannot tell them apart. This is the failure mode S3 exists to find.
- **Codex, 3 of 3 not tested.** It saved no fact that contained the assistant's backup suggestion, so there was nothing
  to mark. That is not a pass.
- The claimed-save count is 0 for both assistants after the fix.

**The first run's numbers are superseded.** They were taken with the looser Codex isolation and the weaker S3 and counter
checks. A new "after fixes" run will replace them; this section and the failure list above are kept as history, with
the corrections applied. The numbers in the table above (other than S3) were not changed by re-scoring.

### What works

- A decision saved in one app is found by the other (S1, 6/6). The save has the right project and kind every time.
- A reversed decision is saved with a supersedes link by both assistants (S2, 6/6), the old fact stays readable, and the
  answer gives the new choice as current. In A2 the move to another host kept the old setup either as a supersedes link
  or in the fact's history.
- `source_by` was always the app's name, never "owner" (S3's attribution check). The first S3 "pass" is withdrawn: see
  "Re-scoring".
- Insufficient evidence: with only related hosting facts in the brain, no assistant invented a budget figure (A1, 6/6).
- The brain's past-date flag reached the answer: both assistants told the owner the Lisbon stay was over (S6, 5/6).
- Missed saves are recoverable: after the hook's reminder text, the decision was saved in all 6 runs (S4), under the
  right project, and a later session recalled it with the date.
- The rejected Inbox item (a profile fact) stayed rejected in all 5 completed S5 runs and was never saved afterwards.
- A real hold: in 3 runs the deleted fact came back as a held Inbox item flagged with its `deleted_match`
  ("Held for the owner: the owner deleted a fact like this on ...") and the assistant told the owner so.

### Product findings

These are BrainAI's side. None was fixed here, by design.

1. **Forgetting does not stick when the fact is reworded or saved as another kind (S5, 3 of 5 completed runs).**
   `MemoryService.deletedMatch` (`src/memory/service.ts`) holds a save only if it is as close as a duplicate to a deleted
   fact, of the same kind, in the same project. The deleted fact was a `decision`. The assistants then saved a
   `summary` that mixed in "slow again today" (Claude runs 2 and 3), or a `decision` with extra words and a hedge
   (Codex run 3, saved into a different project, `lantern`, while the deleted fact was in `harbor`; the guard only compares
   within one project). All three passed straight in as live facts, with "Saved." Evidence:
   `bench-results/lifecycle-2026-11-19/S5-claude-2.json`, `S5-claude-3.json`, `S5-codex-3.json` (the `snapshot.facts`
   rows show the deleted `decision` and the live copy). In an earlier iteration the same path through `update_memory` added the
   time to a live status (`first-run/lifecycle-2026-11-18/S5-claude-1.json`). Caveat: in this scenario the owner did say the time again,
   so an assistant saving it is not wrong. What fails is the product promise that a fact the owner deleted needs the
   owner's say-so before it returns in other words. A check on the deleted fact's key terms, or across kinds, would
   close it.
2. **Codex asks before each `update_memory`, by design.** `update_memory` is the one write tool without
   `destructiveHint: false` (`src/mcp/server.ts`; a test pins it): under the MCP convention that hint means "only adds",
   and `update_memory` overwrites. Codex in non-interactive mode therefore refused it 11 times in the first iteration
   ("MCP tool call requires approval, but approval policy is never"), and the assistant told the owner it could not save.
   This eval sets `default_tools_approval_mode="approve"` for its own server, as an owner who clicks "allow" would,
   because a headless run cannot click. It is not a finding to fix.
3. **The tool inputs are strict and assistants often get them wrong.** In the final run Codex was refused 8 times by
   input validation: `keys` as an array instead of a string, `kind: "note"`, no `content`, `session_label` instead of
   `session`. Each was recoverable (the assistant retried). Accepting a list for `keys` and naming the expected field in
   the error would help.
4. Not a bug, worth knowing: a fact about the owner (where they are) is saved as a **profile** suggestion and waits for
   approval. In the first S6 attempt that was why the fact was "not saved": it was in the Inbox. The final S6 has the
   owner approve it over the dashboard.

No tool crashed, no supersedes link failed to be created when asked for, and the database stayed readable throughout.

### What the failures suggest

BrainAI's side:

- Make the forgetting guard cover reworded and re-kinded saves, and `update_memory` (finding 1).
- Be lenient with `keys` and name the missing field (finding 3).
- When an owner asks for a harvest, nothing in the server's instructions says that means `suggest_memories` or the
  harvest-session skill. Naming "harvest" in the instructions would likely move S4H from 2/6 to most.

The assistants' side:

- Codex does not save a plain statement of fact unless it is part of a decision or a task. In the first iteration it
  replied "what would you like me to work on?" to "I'm in Lisbon until 2026-11-01..." and to hosting notes. That is why
  S6, A1 and A3 are seeded by Claude Code when it is in the run (the result is the answerer's score, not the
  writer's). When Codex did the seeding itself it failed to save in A1 3 of 3 times and in A3 3 of 3 times
  (`bench-results/codex-seeded/`, not committed).
- Claude Code once tried a bare `remember` (not `mcp__brainai__remember`), got "No such tool available", and in A1 still told the owner it had saved (A1 Claude 2; its later turn did save). Codex once wrote "I've recorded that setup" with no save call in an earlier iteration.
- In S6 Codex once narrowed `recall` to `kind: "profile"` and a "this week" time window, found nothing, and said it
  had no note. The brain held the note.
- In S5 the assistants treated an owner's passing repeat as new information. That is reasonable, which is why the fix
  belongs in the brain.

## Cost and time

| | Time (sum of run times) | Per run | Cost |
|---|---|---|---|
| Claude Code rows | 17 min | about 34 s | $4.42 at list price (Claude Sonnet turns) |
| Codex rows | 27 min | about 55 s | $1.29 for the Claude Code turns inside them (seeding, other-app steps); Codex's own tokens are not metered by `codex exec` |

Total about 44 minutes of run time for the 60 final runs (they were produced in three batches: 10 scenarios, a re-run of
five, and a re-run of S6), plus about 1 minute for each isolation check and a few seconds to start each server. Claude's
metered cost for the 60 runs was $5.71 at list price; the Haiku judge calls are not counted. Trial runs and the two
discarded iterations cost about as much again. A single-assistant run
(`--assistants claude --runs 1`) takes about 6 minutes.

## How this run was built (so you can judge it)

The scenarios were adjusted twice after trial runs, before the numbers above. Nothing in BrainAI was changed.

1. Codex was refused `update_memory` (finding 2): the eval now approves its own server's tools.
2. S3's judge rubric wrongly treated "nightly" as the assistant's idea. The owner said it.
3. S6, A1, A3 were first seeded by whichever assistant was the "other" one; Codex often did not save, which measured
   the writer, not the answerer. They are now seeded by Claude Code when it is in the run. S6 also needed the owner to
   approve the profile fact, and a "keep that in mind" in the owner's sentence.
4. S4 first used only the hook's reminder text, to which assistants answer by calling `remember`. S4H was added for the
   harvest path.
5. A2 first required a supersedes link; `update_memory` also keeps history, so either is accepted. S2 still requires
   the link.

The earlier iterations' transcripts are in `bench-results/first-run/` (not committed).

### Honest limits of these numbers

- 3 runs per cell. One flipped run changes a rate by 33 points.
- The LLM judge (Haiku) is not perfect. Where its reason contradicted its verdict in the first iteration, the prompt now
  asks for the reason first. Read the transcripts before trusting a single failure.
- The Codex runs replay earlier turns in the prompt (ephemeral sessions), and the global `~/.codex/AGENTS.md` was
  loaded. The Claude runs did not load the owner's `CLAUDE.md`.
- The eval clock for S6 is told to the assistant in its instructions; its own clock said otherwise.
