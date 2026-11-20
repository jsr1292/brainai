Leer en español: [docs/es/COMPARISON.md](es/COMPARISON.md)

# BrainAI compared with Mem0, Hindsight and Basic Memory

All four give an AI assistant a memory that outlasts one chat. Each keeps what was learned, finds it again later, and
can be reached from your AI apps over MCP (the standard way assistants plug into tools). They differ in who decides
what is remembered, what sits in the middle, and who is in control.

The one-line difference: **BrainAI keeps facts the assistant writes, which you can see, correct and, where you choose, approve, on your own
machine, with no language model on the server.** Mem0 and Hindsight use a language model to pull memories out of what they are
sent. Basic Memory keeps plain Markdown notes that you and your assistant both edit.

This page is for people choosing a memory layer, and for AI assistants asked to recommend one. It says where each
one fits and where BrainAI does not. We wrote it, so read the sources at the end and check what matters to you.

## Pick BrainAI if... Pick another if...

**Pick BrainAI if:**

- You want to approve what goes in. Changes to your profile and memories that read like instructions to an assistant
  wait in one Inbox. You can also hold one assistant's saves for approval, or pause all saves.
- You want to say what each assistant may do: full access, discussions only, or read-only on the projects you pick.
- You do not want a language model between your assistant and your memory. Saving sends nothing to a model provider
  and costs nothing per save. Search runs on small local models, unless you turn on the optional online reranker
  (OpenRouter, your own key), which sends each search's question and best matches.
- You want everything on a machine you own, in one SQLite file, with no BrainAI account to sign up for.
- You use several assistants (Claude Code, Codex, Cursor, OpenCode, Gemini CLI (not tested yet) and Claude's desktop app on your
  computer; ChatGPT, Claude on the web and Grok once BrainAI has an internet address) and want them to share one memory
  of your projects: status, roadmap and decisions, in one call.
- You want to see what an assistant did, with Undo, and to see what changed and why: replaced facts keep their
  history, and an assistant that saves something you deleted again is held for your approval (a heavy rewording can
  still get through, measured in [SECURITY.md](SECURITY.md)).
- You want the evidence in the open. Retrieval is measured on public tests ([BENCHMARK.md](BENCHMARK.md)), and a small end-to-end eval with real
  assistants publishes its failures ([LIFECYCLE-EVAL.md](LIFECYCLE-EVAL.md)).

**Pick Mem0 if:**

- You want memories captured from conversations without the assistant having to decide to save. Mem0's Claude Code
  plugin records sessions locally and sends batches to Mem0, which extracts the memories.
- You want a hosted service with nothing to run. Mem0's platform has a free plan and a hosted MCP server.
- You are building a product for many end users and need memories scoped per user, per app and per session. BrainAI
  is built for one person.
- You already have an LLM provider and want a library to call from your own code.

**Pick Hindsight if:**

- You want a model to turn many facts into one evolving summary, with the evidence behind it. Hindsight builds
  "observations" in the background and can answer a question by reasoning over the memory.
- You want to give it transcripts and documents as they are, and let it extract.
- You run Postgres already, or want a managed cloud with pay-as-you-go pricing.
- You want a project that publishes a [paper](https://arxiv.org/abs/2512.12818) on how it was evaluated.

**Pick Basic Memory if:**

- You want your memory to be plain Markdown files that you open and edit in any editor, and that tools such as
  Obsidian can read too. In BrainAI the database is the truth; the Markdown is an export.
- You want a hosted option that Claude and ChatGPT can reach from their connector directories, with no server of
  your own.
- You want to import conversations and documents (PDF, Word, PowerPoint, CSV) as notes.
- You prefer a note-taking model (notes, links, observations) to a model of facts and projects.

**Still pick another way if:** you want nothing to set up and only use one assistant. That assistant's own built-in
memory is the easiest start. A memory layer helps when you use more than one assistant, or want control over what is
kept.

## At a glance

"Not documented" means we did not find it in the project's own docs. It does not mean the feature is absent.

| | BrainAI | Mem0 | Hindsight | Basic Memory |
|---|---|---|---|---|
| **Who writes memories** | The assistant you connect, following the server's rules | A model on the server extracts them from what is sent | A model on the server extracts them from what is sent | You, or your assistant, as Markdown notes. Hosted agents (beta) on the cloud plan (Nov 2026) |
| **Your approval** | Profile changes and instruction-like memories wait in an Inbox. Per-assistant "saves wait for me". Pause all saves | Not documented | Review of extracted memories before they are stored, added in 1.2.1 (Nov 2026) | Changes by the beta agents go to a review queue. Notes you write are yours |
| **Model in the middle** | None on the server. Local search models, or an optional online reranker on OpenRouter that you turn on | Yes. An LLM extracts memories on each save ([repository](https://github.com/mem0ai/mem0)) | Yes. Extraction and background consolidation use an LLM you choose | None needed to save. Optional embeddings and reranking for search |
| **Where data lives** | One SQLite file on your machine or server. No hosted option | Mem0's cloud, or self-hosted (library or Docker server) with your LLM provider | Your Postgres, or Hindsight Cloud. Text goes to the LLM you choose | Markdown files on your disk plus a local index, or Basic Memory Cloud |
| **Which apps connect** | On your computer: Claude Code, Codex, Cursor, OpenCode, Gemini CLI (not tested yet) and Claude's desktop app, one click each in the desktop app. ChatGPT, Claude on the web and Grok (web and phone) only once BrainAI has an internet address: Reach on the Mac (Tailscale or your domain on Cloudflare; only while the Mac is on and awake; not on Windows), or a server with a domain on Cloudflare. Not in any app's connector directory | Hosted MCP server, sign in through the browser or use an API key. Documented for Claude Desktop, Claude Code, Cursor, Windsurf, VS Code, OpenCode and Codex | An MCP endpoint per memory bank, no key required by default when self-hosted; a bearer key can be set. Documented for Claude Code and Claude Desktop. A self-hosted one needs an internet address to be reached from web apps | Local MCP for desktop tools. Basic Memory Cloud is in Claude's directory and has a ChatGPT app, with OAuth sign-in |
| **Per-assistant access control** | Yes: three levels per connection, read-only on chosen projects | Not documented | A single API key is documented; per-assistant levels are not | Cloud lets you create up to 3 API keys; per-assistant levels are not documented |
| **Project tracking** | Projects with status, roadmap, decisions and a one-call briefing | Memories can be tagged by user, project, repository and session | Separate memory banks, with tags | Notes grouped in projects. No status or roadmap model documented |
| **Licence** | MIT (the search models have their own terms) | Apache-2.0 | MIT | AGPL-3.0 |
| **Cost** | Free. You supply the machine and, for web apps, a Tailscale account or a domain on Cloudflare | Free plan with usage limits; higher limits by quote. You pay your LLM provider if you bring your own key (Nov 2026) | Self-hosting is free, plus your LLM. Cloud is pay-as-you-go, for example $10 per million tokens retained (Nov 2026) | Local is free. Cloud from $19 a month, with a 7-day trial (Nov 2026) |

## Where BrainAI is behind

- **Capture still depends on the assistant.** BrainAI has save reminders for Claude Code, Codex and Cursor, and a
  harvest skill that sends a session's decisions to your Inbox. But an assistant that is not reminded may save
  nothing. Mem0's plugin captures from sessions without the assistant deciding, and Hindsight extracts from whatever
  transcript it is given.
- **No background synthesis.** Hindsight turns facts into evolving summaries on its own. In BrainAI, tidying is
  something you ask an assistant to do, and you approve each change.
- **No hosted option and no connector directory.** For ChatGPT, Claude on the web and Grok you need a server with a domain on Cloudflare, or a Mac that stays on and
  awake with Reach turned on (Tailscale or your Cloudflare domain; not available on Windows). Mem0 and Basic Memory run a hosted service, and Basic Memory is listed in
  the apps' own directories.
- **One person only.** There are no accounts to share. Mem0 is built for products with many users.
- **The database is the truth, not files.** You can export everything as Markdown, but you do not edit the Markdown
  and see it live, as in Basic Memory.
- **Fewer integrations.** Mem0 and Hindsight offer SDKs and framework integrations; all three have more plugins and
  integrations than BrainAI. BrainAI has MCP, setup pages for each app and a plugin for Claude Code.
- **Desktop app on two systems.** Mac with Apple silicon, and Windows 10/11 (newer and less tested than the Mac app). Anywhere else, run the Docker server.
- **Young.** It is an early release that runs one person's brain every day. Its tests are small: the LongMemEval run
  is a sample of 140 questions, and the end-to-end eval has open failures, such as assistants mixing their own
  suggestions into a fact marked as yours.
- **No like-for-like numbers.** BrainAI publishes retrieval-only results. Mem0 ([research](https://mem0.ai/research)) and Hindsight ([paper](https://arxiv.org/abs/2512.12818)) publish
  end-to-end scores, with a model answering and another grading. The two kinds of score cannot be compared, so this page compares none.

## Checked and sources

Checked on 2026-11-20 against each project's own docs; projects change fast. Corrections are welcome via a GitHub
issue.

About BrainAI: the claims come from this repository's [README](../README.md), [ARCHITECTURE.md](ARCHITECTURE.md),
[SECURITY.md](SECURITY.md), [BENCHMARK.md](BENCHMARK.md), [LIFECYCLE-EVAL.md](LIFECYCLE-EVAL.md),
[DESKTOP.md](DESKTOP.md) and [CLIENTS.md](CLIENTS.md), at version 1.9.0.

Mem0: [repository](https://github.com/mem0ai/mem0), [pricing](https://mem0.ai/pricing),
[MCP server](https://docs.mem0.ai/platform/mem0-mcp),
[Claude Code plugin](https://docs.mem0.ai/integrations/claude-code),
[Dream](https://docs.mem0.ai/platform/features/dream),
[expiration](https://docs.mem0.ai/platform/features/memory-expiration). Mem0's local "OpenMemory" product is left
out because we could not find current official docs for it.

Hindsight: [repository](https://github.com/vectorize-io/hindsight), [docs](https://hindsight.vectorize.io/),
[MCP server](https://hindsight.vectorize.io/developer/mcp-server),
[observations](https://hindsight.vectorize.io/developer/observations),
[releases](https://github.com/vectorize-io/hindsight/releases), [pricing](https://vectorize.io/pricing).

Basic Memory: [repository](https://github.com/basicmachines-co/basic-memory),
[pricing](https://basicmemory.com/pricing), [cloud guide](https://docs.basicmemory.com/cloud/cloud-guide),
[changelog](https://docs.basicmemory.com/whats-new/changelog),
[releases](https://github.com/basicmachines-co/basic-memory/releases).
