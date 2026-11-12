# Changelog

Each release says what changed and whether updating needs anything from you. Updating is always
`git pull && docker compose up -d --build` in `~/memory`; BrainAI copies its database to `data/pre-migrate/` before
any change to it. Settings › Backups and health shows the version you run.

## 1.2.0 (2026-11-12)

Updating needs nothing from you: the database updates itself when the server starts (a copy is kept first). The first
start after this update also rebuilds the search index for the new search model, which takes about a minute; the
server answers once it's done.

- **A better search model:** recall now finds facts with EmbeddingGemma-300m instead of multilingual-e5-small. On the
  author's own 168 recall questions the right fact came first 149 times instead of 143; on the LoCoMo benchmark the
  right turn is in the first 8 results for 87% of questions instead of 74% (docs/BENCHMARK.md). Duplicate
  warnings, related facts, project-merge suggestions and the graph's threads use cut-offs tuned for it. The Docker
  image grows by about 210 MB. `EMBED_MODEL=e5` in `.env` switches back (the index is rebuilt again at the next start);
  if you set `MIN_RECALL_SIMILARITY`, `RECALL_WINDOW`, `RECALL_CONFIDENT_SIMILARITY` or `DUPLICATE_THRESHOLD`
  yourself, they were tuned for e5: the server log names them at the first start so you can remove them.
- **Licence:** EmbeddingGemma is provided under and subject to the Gemma Terms of Use found at
  ai.google.dev/gemma/terms. The notice and the terms ship with the model (`licenses/`). Using BrainAI with it means
  using the model only as those terms allow, never for anything the Gemma Prohibited Use Policy forbids
  (ai.google.dev/gemma/prohibited_use_policy).
- **Work memory for a Windows laptop, as a download:** the release page now carries
  `work-memory-win-x64-1.2.0.zip`, a private memory for Codex and Claude Code on a work laptop: no install rights, no
  internet and no other software needed (docs/WORK.md). To update, unzip the newer zip and run `setup.ps1` again;
  your memories and settings are kept. Its README now has a licences section with the Gemma terms of use.
- **Projects by area:** the Projects page now has one section per area (Apps, Tools & AI, Home & infrastructure, Work,
  Personal). Projects you're working on are small tiles with a coloured dot (green: being worked on, amber: waiting on
  you, grey: quiet), their one-liner and what's being done now; quiet, ideas, parked and done projects fold into one line
  under their area. "On the go" and "Also open" are gone: pin a project to keep it first in its area.
- **Learning to work like a developer:** every project now has five areas: work is safe (committed and pushed), runs by
  itself (CI/CD), kept up to date, you'd know if it broke, and a clear finish line. Assistants see where each project
  stands, bring up the next area at a good moment (one at a time; "not now" holds two weeks), explain the why as they
  work on it with you, and keep what you learned as a handbook (project developer-handbook). "Work is safe" fills itself
  in from the Mac's folder report. Each project shows its five areas, and **Map** (from the Projects page) shows every
  project against them, with a week-by-week line. A tile marked "!" holds work that exists only on the Mac.
- **The weekly review** flags uncommitted work older than a day, like the project pages do.
- **Search asks assistants for a guess:** with a question, an assistant now usually sends one sentence written as the
  answer might be stored (a guess, never saved or shown). On LoCoMo this finds the right turn first 60% of the time
  instead of 57%, at about 0.3 s more per search on a mini PC.
- **Search words:** an assistant can give a fact a few search words the text doesn't say (a nickname, the Spanish
  word, the date of an event). Search finds the fact by them; nobody has to read them. You see and edit them on the
  fact's page. To add them to facts you already have, ask an assistant to "add search words to my facts".
- **More results for assistants:** a search from an assistant returns up to 12 facts instead of 8, as long as they fit
  in about 1,500 words. The dashboard is unchanged.
- **One topic per fact:** assistants are asked to save two facts when what they save covers two things.
- **Time questions:** "what did we decide last week?", "¿qué hicimos en octubre?": facts saved or dated in that time
  come first; nothing else is hidden. Assistants can also pass exact dates, and recall says how it read the time.
- **Page matches:** a page section found by search shows where it sits ("Stack and where it lives › Backups") and the
  passage that matched, not just its first lines.
- **Pages:** a live-styled editor (the page's own font and headings while you type, a [[ picker for links, ⌘S to save),
  Facts and Inbox in the sidebar, and Facts grouped by project with roadmaps as Now / Next / Done.

## 1.1.1 (2026-11-09)

Updating needs nothing from you.

- **Version number:** the server and the desktop app report their real version (1.1.0 was published still saying
  1.0.1 in Settings); a release is now refused unless both name the version being released.
- **Windows:** the app carries the five Microsoft Visual C++ runtime files it needs (version 14.44), in the folders of
  the two modules that load them, so it starts on a PC without the runtime or with an older one, without an
  administrator. They come
  from Microsoft's official redistributable and are checked against pinned fingerprints when the app is built. If
  they are ever missing and the PC lacks the runtime, the app still says so with Microsoft's download link.

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
