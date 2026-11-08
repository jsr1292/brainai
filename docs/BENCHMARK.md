# How well recall finds things

BrainAI's search is measured on LoCoMo, a public test of memory over long conversations
([snap-research/locomo](https://github.com/snap-research/locomo), Maharana et al., 2024, CC BY-NC 4.0). Its ten
conversations run to about 600 turns each, over many weeks, with questions about what was said.

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
