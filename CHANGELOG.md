# Changelog

Each release says what changed and whether updating needs anything from you. Updating is always
`git pull && docker compose up -d --build` in `~/memory`; BrainAI copies its database to `data/pre-migrate/` before
any change to it. Settings › Backups and health shows the version you run.

## 1.1.0 (2026-11-08)

Updating needs nothing from you: the database updates itself when the server starts (a copy is kept first), and the
next build downloads the reranker model once (about 145 MB). On a Mac that syncs skills, run
`scripts/mac/install-folder-report.sh` again to get the safer sync.

- **Safer files:** the Markdown export never writes or deletes through a link in its folder; two backups started at
  once no longer trip over each other (the second does nothing); the Mac's skills sync stages each skill in a new
  folder of its own.
- **Disagreements:** settling a pair is one change; a fact from another project is named on the project page; the
  pages that list them do less work.
- **Better first answers:** recall's first 20 matches are reordered by a small local model (multilingual, about
  145 MB, downloaded with the search model) that reads the question next to each fact. On LoCoMo the right answer
  comes first for 51% of questions instead of 34%, and is in the default 8 for 73% instead of 64%. Each recall takes
  about 0.3 s on a mini PC with a real brain (about 1.7 s of CPU time across up to 6 threads per model, which sleep
  while they wait) and about 300 MB more memory: the app's memory limit in
  `docker-compose.yml` rises from 1 GB to 1.5 GB. `RERANK=off` turns it off.
- **Latest on one part of a project:** with the reranker on, "what's the latest on X's export?" usually gets the fact
  about the export first; the project's roadmap and status stay on top for questions about the whole project.
- **Honest misses:** when the reranker finds that none of the facts recall returns matches the question closely, the
  reply says so, so an assistant doesn't take the nearest unrelated fact for an answer. Nothing is hidden.
- **Nicknames:** a project can have everyday names ("the wine app"), set by an assistant with `set_project_info` or
  on the project's Edit details. Every assistant gets them at the start of a conversation, and a question that uses
  one is also searched with the project's real name.
- **Questions in another language:** `recall` takes up to two other phrasings from the assistant (`alt_queries`),
  such as an English version of a Spanish question, and searches them together. On the author's brain the right fact
  came first for 83% of questions instead of 77%.
- **The benchmark** also scores the top 8 (recall's default) and the top 20 (`--limit 20`), with or without the
  reranker (`--rerank off`). It uses the LoCoMo audit's corrected evidence by default, records each question's rank
  and compares two runs question by question (`--against`). The recall test groups questions by type (`tags`),
  sends each question's other phrasings (`alt`), and writes and compares runs (`--json`, `--against`).

## 1.0.1 (2026-11-08)

Updating needs nothing from you: the database gains one table (for disagreements).

- **Cairn is now called BrainAI.** Your memories and settings stay as they are.
- **The Mac app** (`docs/DESKTOP.md`): BrainAI on your own Mac with no server, domain or password; one-click Connect for
  Claude Code, Codex, OpenCode and Cursor; a first-run welcome.
- **Reach from phone and web:** a password and an authenticator from the dashboard, then a public address through
  Tailscale (no domain) or your own domain on Cloudflare, served through a separate door that is open only while
  Reach is on.
- **Move to a server:** one moving file with every memory and picture, a tested runbook section to unpack it on a
  server, and an app that then points its apps to the server and removes itself.
- **The README** starts with "Where will it live?": your computer, a home server or a cloud server.
- **Facts that disagree:** when an assistant sees that two saved facts can't both be true, it flags them
  (`flag_disagreement`); you settle each pair on its project or on Facts that disagree, and until then assistants see
  both marked.
- **Brain health:** Settings › Brain health and backups shows how up to date and ready the brain is and what waits on
  you, each 0–100 with its reasons; For you shows a line when one drops below 70, and the weekly review includes it.
- **A recall benchmark:** `npm run bench:locomo` measures how often search finds the answer on the public LoCoMo test
  (`docs/BENCHMARK.md`).
- **Windows (test build):** the same app for Windows 10/11 x64, installed per user with no admin rights, with a
  checksum-checked PowerShell install. Reach from phone and web is Mac-only for now.

## 1.0.0 (2026-11-06)

The first public release.

- **Memory for all your assistants:** one MCP server that Claude, ChatGPT, Grok, Claude Code, Codex, Grok Build and
  OpenCode connect to with OAuth. Facts (decisions, statuses, roadmaps, your profile) and pages (long documents),
  with recall that understands meaning as well as words, in several languages.
- **You stay in charge:** changes to your profile and memories that read like instructions wait for your approval;
  forgetting sticks (an assistant can't quietly save a deleted fact again); secrets are refused.
- **Dashboard:** projects with their statuses, roadmaps and pages; a weekly review; tidy-up suggestions;
  discussions where several assistants answer one question in rounds; pictures and diagrams in pages.
- **Shared skills:** skills you share from one computer reach your other assistants, with versions and proposals.
- **Guided setup:** a page per app with the text to paste, and a number that shows when an app's text is out of date.
- **Backups:** nightly snapshots copied to your other drives, a nightly Markdown export into git, and a weekly
  encrypted off-site copy.
- **Work mode:** a separate copy that runs on a work laptop with nothing shared with home.
- **Your settings stay yours:** your own texts and script settings live in `overlay/`, which updates never touch.
