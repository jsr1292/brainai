# How well recall finds things

BrainAI's search is measured on LoCoMo, a public test of memory over long conversations
([snap-research/locomo](https://github.com/snap-research/locomo), Maharana et al., 2024, CC BY-NC 4.0). Its ten
conversations run to about 600 turns each, over many weeks, with questions about what was said.

## What is measured

**Retrieval only.** Every turn of a conversation is saved as one fact in a fresh, empty brain ("Caroline on 8 May,
2023: …", photos as their captions). Each question is then asked through BrainAI's own recall, with the server's
default settings and its local model, for up to 10 results. A question counts as found at rank *n* when the *n*th
result is one of the turns LoCoMo marks as its evidence.

No language model writes or judges an answer. These numbers are therefore **not comparable** to the end-to-end LoCoMo
scores that memory products publish, where a model answers from what was retrieved and another model grades it.
They say how often the right part of the conversation reaches the assistant, which is the part BrainAI is
responsible for.

Left out: the 446 adversarial questions (category 5, which have no answer in the conversation) and 4 questions
without evidence. A multi-hop question counts as found when any one of its evidence turns is returned.

## Results

8 November 2026, BrainAI 1.0.0 (unreleased B1), model Xenova/multilingual-e5-small (q8), LoCoMo data at commit
cbfbc1d. 5,882 turns saved; 1,536 questions scored; 31 seconds on an Apple Silicon Mac. Two runs gave identical numbers.

| Questions | How many | Found first | In the top 5 | In the top 10 | MRR |
|---|---:|---:|---:|---:|---:|
| Single-hop | 841 | 35.7% | 60.4% | 69.7% | 0.463 |
| Multi-hop | 282 | 23.0% | 51.1% | 61.7% | 0.346 |
| Temporal | 321 | 43.9% | 67.9% | 74.1% | 0.543 |
| Open-domain | 92 | 16.3% | 29.3% | 40.2% | 0.225 |
| **All** | **1,536** | **33.9%** | **58.4%** | **67.4%** | **0.444** |

MRR (mean reciprocal rank) is 1 when the answer always comes first, 0.5 when it comes second on average.

What this means in use: for two questions out of three, an assistant that recalls 10 facts gets at least one turn
that answers it (for a multi-hop question, at least one of the turns it needs).
Open-domain questions, which need knowledge from outside the conversation, are hardest, as expected.

## Running it

```bash
npm run bench:locomo
```

The first run downloads `locomo10.json` (2.8 MB) from the pinned commit into `bench-results/cache/` and checks its
SHA-256; a file that doesn't match is refused, never scored. Results print as a table and are written to
`bench-results/locomo-<date>.json`, with the model and settings used. Nothing from LoCoMo is kept in the repository.
