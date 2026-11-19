Leer en español: [docs/es/BENCHMARK.md](es/BENCHMARK.md)

# How well recall finds things

BrainAI's search is measured on LoCoMo, a public test of memory over long conversations
([snap-research/locomo](https://github.com/snap-research/locomo), Maharana et al., 2024, CC BY-NC 4.0). Its ten
conversations run to about 600 turns each, over many weeks, with questions about what was said.

> These tests start from facts that are already stored. They do not show that the right things get saved, replaced and
> forgotten in normal use. That is measured end to end, with real assistants and the real save and approval paths, in
> [LIFECYCLE-EVAL.md](LIFECYCLE-EVAL.md).

## What is measured

**Retrieval only.** Every turn of a conversation is saved as one fact in a fresh, empty brain ("Caroline on 8 May,
2023: …", photos as their captions). Each question is then asked through BrainAI's own recall, with the server's
default settings and its local models, for up to 10 results. A question counts as found at rank *n* when the *n*th
result is one of the turns LoCoMo marks as its evidence.

No language model writes or judges an answer. These numbers are therefore **not comparable** to the end-to-end LoCoMo
scores that memory products publish, where a model answers from what was retrieved and another model grades it.
They say how often the right part of the conversation reaches the assistant, which is the part BrainAI is
responsible for.

Left out: the 446 adversarial questions (category 5, which have no answer in the conversation) and 4 questions
without evidence. A multi-hop question counts as found when any one of its evidence turns is returned.

**Corrected evidence.** An independent audit of LoCoMo's answer key
([dial481/locomo-audit](https://github.com/dial481/locomo-audit), CC BY-NC 4.0) found 156 errors, 57 of them
questions whose evidence points at the wrong turn. Because this benchmark scores exactly that evidence, those 57
questions use the audit's corrected turns by default. The other 99 errors concern the answer, not where it is, and
change nothing here. `--evidence original` scores LoCoMo's own evidence.

## Results

8 November 2026, BrainAI 1.0.1 with the reranker (unreleased B3): search model Xenova/multilingual-e5-small (q8),
reranker cross-encoder/mmarco-mMiniLMv2-L12-H384-v1 (int8), LoCoMo data at commit cbfbc1d. 5,882 turns saved; 1,536
questions scored; 195 seconds on an Apple Silicon Mac.

Recall's search finds its first 20 matches by meaning and by words; the reranker, a small local model, then reads the
question next to each of them and puts them in its order.

| Questions | How many | Found first | In the top 5 | In the top 8 (default) | In the top 10 | MRR |
|---|---:|---:|---:|---:|---:|---:|
| Single-hop | 841 | 56.2% | 73.8% | 75.9% | 77.1% | 0.638 |
| Multi-hop | 282 | 41.1% | 66.7% | 69.9% | 70.2% | 0.527 |
| Temporal | 321 | 56.4% | 74.5% | 76.9% | 77.6% | 0.643 |
| Open-domain | 92 | 15.2% | 32.6% | 35.9% | 41.3% | 0.236 |
| **All** | **1,536** | **51.0%** | **70.2%** | **72.6%** | **73.8%** | **0.595** |

MRR (mean reciprocal rank) is 1 when the answer always comes first, 0.5 when it comes second on average; both tables
count answers up to the 20th result (`--limit 20`).

The reranker only reorders the first 20 matches, so the top 20 (75.9%) is the same with or without it; what changes is
how near the top the answer comes. On the author's own brain (about 370 facts and 70 questions with known answers) the
right fact came first for 76% of questions instead of 61%. It costs CPU on each recall: on that brain a recall takes
about 0.3 s (median over its 52 questions, 1.7 s of CPU time across cores) on an Intel Core Ultra 7 mini PC, with the
reranker reading 20 real facts. Until B5 it took 0.9 s and 18 s of CPU, because the two local models' thread pools
spun against each other; each model now uses at most 6 threads that sleep while waiting. A first estimate of 65 ms,
made with 20 short made-up facts, was far too low. Reading less of each fact would be faster (192 tokens: 0.21 s) but
lost answers on long facts (LoCoMo with turns packed into 1,000-character facts: 86.1% in the top 8 instead of 90.8%),
so the reranker reads up to 256 tokens. A larger reranker (bge-reranker-v2-m3) found the
answer first a little more often (59% on LoCoMo) but took several seconds a search, too slow to be the default.
`RERANK=off` turns it off.

### Nicknames and other phrasings (B4)

Scored against the audit's corrected evidence (see above), the current search finds the answer first for 51.7% of
the 1,536 questions, in the top 8 for 73.8% and in the top 20 for 76.9% (MRR 0.603), the same as before within a few
questions. LoCoMo cannot show B4's two additions: its questions are in English and name no projects. They were
measured on the author's own brain instead (52 questions, and 20 more kept aside and never used for tuning):

| | Found first | In the top 3 | In the top 8 |
|---|---:|---:|---:|
| Before B4 | 77% | 90% | 96% |
| With nicknames and other phrasings | 83% | 94% | 98% |
| Kept-aside questions, before → after | 80% → 75% | 90% → 95% | 100% → 100% |

On the 52 questions, six moved and all for the better: Spanish questions about facts written in English, and
questions that call a project by its everyday name. Of the 20 kept aside, one moved up (sixth to second) and one down
(first to second). Each extra phrasing is one more pass of the reranker, and a recall uses at most two (a nickname's
real-name phrasing counts as one), so a recall with two takes up to three times as long; on the author's questions,
which include some, the slowest tenth took about 0.6 s. Two other ideas were measured and
left out: extra vectors for the parts of long facts (no gain on these questions or on LoCoMo with turns packed into
1,000-character facts, `--pack 1000`) and a short header before each fact for the reranker (a gain on one set, a loss
on the other).

### When nothing matches closely (B6)

The reranker's best score also tells when nothing matches closely, but not reliably enough to hide results: some of the
author's real questions scored lower than unrelated ones (lowest real −5.4, highest unrelated −0.6). So recall always
returns its nearest facts, and when the reranker's best score is below −4 the reply says none of them matches the
question closely. Measured on the score itself, that is 3 of 72 real questions and 23 of 32 unrelated ones; a question
answered by its project's pinned status never gets the note, and with `RERANK=off` there is none.

Skipping the reranker when the search's first match clearly wins was measured and left out: done safely (only when the
first match beats every other in the pool by 0.03 or more in similarity) it saved about 5% of the reranker's work on
LoCoMo and 1–6% on the author's questions.

### Questions about where something stands (B7)

A question asking how a project is going gets that project's roadmap and newest status on top: the reranker cannot read
roadmap lines ("Done / Now / Next") and would bury them. Since B7, with the reranker on, that happens only when the
question is about the whole project ("how is X going?", "what's the next step for X?", "¿qué queda por hacer en X?").
When it names one part ("what's the latest on X's episode strip?"), the roadmap and status compete with the other facts
and the one about that part usually comes first. The author's recall test has three sets: 52 main questions, 20 kept
aside and 100 drafted from the author's facts in November 2026 (kept aside too). On the 100 the right fact came first
for 89% of questions instead of 86%; the 52 and the 20 did not change.

### Search words and 12 results (B9)

Since B9 a saving assistant can add `keys` to a fact: up to 15 search words the text doesn't say (other names, the
other language, an event's date). They are embedded with the fact and put in the keyword index, and never shown. The
gain depends on assistants writing them, so it was simulated, not measured on real use: on 742 LoCoMo questions with a
simulated saving assistant, keys in the keyword index alone took the top 8 from 73.5% to 76.0%, and fact and keys
embedded as one text took it to 76.8% (both on today's e5-small; with a better embedder the second reached 87.7% from
84.4%). Details are in the research report "Recall precision beyond B4" (§3.6). The two together were not measured.

Assistants now get up to 12 facts per recall instead of 8, within about 8,000 characters. On LoCoMo the evidence was in
the top 8 for 73.4% of questions, the top 10 for 74.6% and the top 20 for 76.6%, so 12 adds a point or two; the
dashboard is unchanged.

### Time questions (B10)

Since B10, recall reads time words in a question ("last week", "in July 2023", "hace 3 días", "recently") as a range of
days. The facts saved or dated in that range (a date like "2026-11-03" written in the fact counts) that the search
would match anyway get one more ranked list in the fusion: a boost, not a filter. A range that holds more than half the
facts adds nothing, the dashboard's own searches don't read time words, and an assistant can pass exact `since`/`until`
dates to narrow the search. 244 of LoCoMo's 1,986 questions hold time words.

As the bench normally runs, every turn is saved on the day of the run, so no time word can pick out a session.
`--dated` saves each turn on its session's day and asks the questions the day after the last session. Top 20, reranker
on, audited evidence, run on 2026-11-11:

| All 1,536 questions | @1 | @5 | @8 | @10 | @20 | MRR |
|---|---:|---:|---:|---:|---:|---:|
| Undated (as before B10) | 51.9 | 70.9 | 73.5 | 74.7 | 76.6 | 0.604 |
| Dated | 52.7 | 71.7 | 74.3 | 75.5 | 77.6 | 0.611 |

Paired: 15 questions gained and 3 lost within the first result (net +12), 16 gained and 4 lost within 8 (net +12). Only
questions with time words can move; the undated run matches the run before B10 exactly. On the author's own recall test
(170 questions, almost none about a time) nothing changed. The reranker reads only the
text, so the boost mostly decides which facts reach it: with the reranker on, the gain is small.

### EmbeddingGemma as the search model

Since the switch to EmbeddingGemma-300m (4-bit ONNX, 768 dimensions; `EMBED_MODEL=e5` keeps the old model), every
cut-off has a value tuned for it (`src/memory/embeddingProfile.ts`, calibrated with `src/scripts/calibrateEmbedder.ts`):
a recall floor of 0.3 with no window, keyword ranks weighted 0 (meaning alone orders the candidates; keyword-only
matches still reach the reranker), and the search order blended into the reranker's (rerankPrior 1). Top 20, reranker
on, audited evidence, run on 2026-11-11:

| All 1,536 questions | @1 | @5 | @8 | @10 | @20 | MRR |
|---|---:|---:|---:|---:|---:|---:|
| e5-small (before) | 51.9 | 70.9 | 73.5 | 74.7 | 76.6 | 0.604 |
| EmbeddingGemma | 57.0 | 81.6 | 86.6 | 88.3 | 91.7 | 0.678 |

Paired: 124 questions gained and 46 lost within the first result (net +78), 226 gained and 25 lost within 8 (net +201).
The search now finds the right turn among its first 20 for 92% of questions, so the reranker has it to work with far
more often. On the author's own recall test (168 questions, on the mini PC that serves it, the same backup copy for
both): found first 149 instead of 143, in the top 3 162 instead of 160, in the top 8 165 instead of 166 (the one fact
that left the top 8 is within the 12 results an assistant gets). The 20 held-out questions alone: first 16 instead of
15, top 8 19 of 19 for both. Caveat: the keyword weight and rank prior were chosen on all three question files, the
held-out ones included, so those are not an untouched check. On a Mac the same settings gave 150 / 162 / 166 (ONNX
kernels differ slightly between ARM and x86).

Remote models were tried on the same bench before choosing (OpenRouter, 2026-11-11): OpenAI text-embedding-3-small
reached 87.2% at 20, Gemini embedding 87.1%, bge-m3 83.1%, Qwen3-Embedding-8B 80.7%; all below the local model. A paid
reranker (Voyage rerank-2.5) on top of EmbeddingGemma reached 72.3% first on LoCoMo but changed nothing on the author's
own questions, so it was not adopted.

### Without the reranker

The same data, BrainAI 1.0.1's search alone (`npm run bench:locomo -- --limit 20 --rerank off`); 31 seconds.

| Questions | How many | Found first | In the top 5 | In the top 10 | MRR |
|---|---:|---:|---:|---:|---:|
| Single-hop | 841 | 35.7% | 60.4% | 69.7% | 0.469 |
| Multi-hop | 282 | 23.0% | 51.1% | 61.7% | 0.354 |
| Temporal | 321 | 43.9% | 67.9% | 74.1% | 0.546 |
| Open-domain | 92 | 16.3% | 29.3% | 40.2% | 0.229 |
| **All** | **1,536** | **33.9%** | **58.4%** | **67.4%** | **0.450** |

An assistant's recall returns 8 results unless it asks for more, and 20 at most. The same run, scored at each:

| Questions | In the top 8 (default) | In the top 10 | In the top 20 (most) |
|---|---:|---:|---:|
| Single-hop | 66.0% | 69.7% | 78.8% |
| Multi-hop | 58.9% | 61.7% | 73.4% |
| Temporal | 71.3% | 74.1% | 78.8% |
| Open-domain | 37.0% | 40.2% | 46.7% |
| **All** | **64.1%** | **67.4%** | **75.9%** |

Without the reranker, asking for 20 found the answer for about 12 more questions in 100 than the default 8; with it,
the default 8 already finds 72.6%.

What this means in use: for about three questions out of four, an assistant that recalls its default 8 facts gets at
least one turn that answers it (for a multi-hop question, at least one of the turns it needs), and for half of them
the answer is the first fact. Open-domain questions, which need knowledge from outside the conversation, are hardest,
as expected.

## LongMemEval

A second public test, [LongMemEval](https://github.com/xiaowu0162/LongMemEval) (Wu et al., "LongMemEval: Benchmarking Chat
Assistants on Long-Term Interactive Memory", ICLR 2025). Each of its 500 questions comes with its own chat history of
about 50 sessions (115,000 tokens, 550 turns on average) between a user and an assistant, with distractor sessions
mixed in, and one to a few sessions that hold the answer.

**Licence and source.** The code and the data are MIT-licensed (repository LICENSE, "Copyright (c) 2024 Di Wu"; the
Hugging Face dataset card says `license: mit`), so using them for this benchmark is allowed. Data:
[xiaowu0162/longmemeval-cleaned](https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned) at revision
98d7416c24c778c2fee6e6f3006e7a073259d48f, file `longmemeval_s_cleaned.json` (277 MB, SHA-256
d6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442), the September 2025 clean-up of the authors' original
files. It is downloaded into `bench-results/cache/` (git-ignored) and checked against that hash; it is never committed.

### What is measured

Retrieval only, as for LoCoMo, with the same rules: no model writes or judges an answer, runs are paired (the same
facts and questions with the reranker on and off), and the misses are published.

- **Variant: LongMemEval_S** (about 50 sessions per question), not the oracle variant (only the answer sessions, which
  makes retrieval trivial) and not M (about 500 sessions).
- **Unit: one fact per turn**, as LoCoMo's turns are: "User on 2023/05/20 (Sat) 02:21: ..." or "Assistant on ...", saved
  by the owner in a fresh in-memory brain for each question, then asked through the same `MemoryService.recall` the
  server uses, with its default models (EmbeddingGemma 4-bit, reranker mMiniLM int8), for up to 20 results. A turn longer
  than the 1,000-character fact limit (about 4 turns in 10) is cut at paragraph, line, sentence or word ends into several
  facts that each begin with the same speaker and date. I did not pack turns into longer facts: LongMemEval turns
  already average 880 characters, so packing would hold two turns at most, and a fact per turn keeps the turn-level
  labels exact.
- **Two scores.** *Session* (s): an answer session (`answer_session_ids`) is among the first *k* results, which is the
  level LongMemEval itself reports retrieval at. *Turn* (t): a turn labelled `has_answer` is among the first *k*. Because
  a session is about 10 turns, the session score is much easier; turn-level shows whether recall finds the sentence
  and not just the right conversation. For questions that need several sessions, "all" requires every answer session
  among the results (a multi-session question counts as found in "s" when any one is).
- **Abstention** (30 questions, ids ending `_abs`, the thing asked about was never said) is its own row. There is nothing
  to find, so the number that matters is how often recall says so: the share of questions where recall's weak-match
  warning (the server's own cut-off, WEAK_SCORE) would be shown, or recall returned nothing. Its session and turn scores
  are given for completeness (the labelled session is one that talks about something close).
- The brain's clock is not set (the date is in each fact's text). `--dated`, which saves each turn on its session's day
  and asks on the question's date, gave identical numbers here.

### Cost and sample

About 200,000 distinct turns across the 500 histories, and EmbeddingGemma on this Mac embeds about 17 facts a second, so
a full run is about 8 hours (measured: 46 seconds a question, 6,514 s for 140), well over the 2 hours I allowed. The
results below are therefore a **stratified sample: 20 questions of each of the 7 categories (140)**, taken at an even
stride through the file (not random, not chosen by result), 121,062 facts saved. Embeddings are cached per model in
`bench-results/cache/`, so a re-run with the reranker off or on, another limit, or `--dated` takes 1 to 2 minutes.
With 20 questions per row a percentage moves 5 points per question: read differences of a few points as noise.

### Results

18 November 2026, BrainAI 1.4.0 (commit c9969b4, with the A3 files added), EmbeddingGemma-300m (4-bit), reranker
cross-encoder/mmarco-mMiniLMv2-L12-H384-v1 (int8), LongMemEval_S cleaned, 20 questions per category, up to 20 results, on
an Apple Silicon Mac. Session: an answer session in the first *k*; Turn: an answer turn in the first *k*.

| Category (20 each) | Session @1 | Session @8 | Session @20 | Turn @1 | Turn @8 | Turn @20 | Weak-match warning |
|---|---:|---:|---:|---:|---:|---:|---:|
| Single-session, user | 100% | 100% | 100% | 75% | 95% | 100% | 0% |
| Single-session, assistant | 100% | 100% | 100% | 75% | 100% | 100% | 5% |
| Single-session, preference | 75% | 100% | 100% | 15% | 70% | 95% | 25% |
| Multi-session | 100% | 100% | 100% | 50% | 95% | 100% | 35% |
| Knowledge update | 100% | 100% | 100% | 55% | 85% | 100% | 0% |
| Temporal reasoning | 95% | 100% | 100% | 55% | 85% | 90% | 30% |
| Abstention | 95% | 100% | 100% | 10% | 20% | 20% | **55%** |
| **All 140** | **95.0%** | **100%** | **100%** | **47.9%** | **78.6%** | **86.4%** | 21.4% |

Recall never returned nothing (0% empty in every category): its search always has nearest facts to show. For the six
real categories the weak-match warning is a false alarm, since an answer is there: 16% of those 120 questions (19 of them) (0% to
35% by category). For abstention it is the right signal, and it fired for 11 of 20 (55%); the other 9 returned plausible
facts with no warning, which is the weak spot for "no answer".

Questions needing every answer session (multi-session, temporal, abstention's labelled sessions): all of them within 8
results for 75%, 80% and 80% of questions (within 20: 100%, 85%, 90%); overall 90.7% within 8 and 96.4% within 20.

Without the reranker (the search alone, same facts): session 95.0 / 99.3 / 100 and turn 34.3 / 77.1 / 86.4 (at 1 / 8 /
20), MRR 0.965 either way. The reranker's gain is at the turn level at rank 1: 47.9% instead of 34.3% (multi-session
50% instead of 15%, knowledge update 55% instead of 30%); within 20 it changes nothing, as for LoCoMo. The warning needs
the reranker's score, so it is never shown without it.

Weakest: recognising no-answer questions (abstention, 55% warned; its turn-level 20% is not meaningful, as it has
no answer turn). Among the real categories the weakest are **single-session-preference** (turn @1 15%, @8 70%: the answer is a preference
spread over a long reply, so the labelled turn is often not the one that matches the question words; session rank 1
for 75%, and one question's labelled turn was not in the first 20) and **temporal reasoning** (the evidence for 3 of 20
questions spans sessions that are not all found within 20; turn-level 90% at 20). The 34 facts of 121,062 that were
not saved were refused by the save checks (not investigated).

Misses, per question, are in `bench-results/longmemeval-2026-11-18-sample20.json` (rank of the first answer session,
first answer turn and of all answer sessions for each of the 140 questions). Those files are git-ignored like LoCoMo's.

**Comparison.** The LongMemEval paper reports retrieval at session level over all 500 questions for retrievers such as
BM25, Contriever, Stella and GTE. I did not copy those numbers here: I have not re-checked them against the paper's
tables, and they measure other things (all 500 questions, per-session or per-turn-value indexing with other unit sizes,
recall of any answer session among the top-*k* sessions rather than among *k* facts). The session numbers above are
near the ceiling and, on a 20-question sample, cannot separate retrievers; the turn level and the weak-match rate are
where BrainAI can improve.

```bash
npm run bench:longmemeval -- --sample 20              # 20 questions per category, up to 20 results
npm run bench:longmemeval -- --sample 20 --rerank off  # the search alone (1 minute once embeddings are cached)
npm run bench:longmemeval                              # all 500 questions: about 8 hours here
npm run bench:longmemeval -- --only <question_id,...>  # named questions;  --dated  --limit <n>  --cache/--out <dir>
```

## Running it

```bash
npm run bench:locomo                 # up to 10 results
npm run bench:locomo -- --limit 20    # up to 20
npm run bench:locomo -- --rerank off  # the search alone
npm run bench:locomo -- --evidence original              # LoCoMo's own evidence, without the audit's corrections
npm run bench:locomo -- --against bench-results/<earlier>.json   # questions gained and lost since that run
```

The first run downloads `locomo10.json` (2.8 MB) and the audit's `errors.json` (150 KB) from their pinned commits
into `bench-results/cache/` and checks their SHA-256s; a file that doesn't match is refused, never scored. Results
print as a table and are written to `bench-results/locomo-<date>-top<limit>.json` (`-norerank` added without the
reranker, `-original` with LoCoMo's own evidence), with the models and settings used and each question's rank, so two
runs can be compared question by question. Nothing from LoCoMo or the audit is kept in the repository.
