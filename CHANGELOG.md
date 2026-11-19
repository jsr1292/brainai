# Changelog

Each release says what changed and whether updating needs anything from you. Updating is always
`git pull && docker compose up -d --build` in `~/memory`; BrainAI copies its database to `data/pre-migrate/` before
any change to it. Settings › Backups and health shows the version you run.

## 1.5.2 (2026-11-19)

Updating needs nothing from you.

**Privacy fixes**
- **The copies kept before an update are now narrowed at every start.** 1.5.1 said each start makes `data/pre-migrate` (full copies, with the sign-in data) readable by its owner only, but it did so only when an update changed the database. Now every start does.
- **The nightly backup is owner-only too (servers run with Docker).** `scripts/backup.sh` now writes its backups, and the copies in `COPY_DIRS`, readable by their owner only. They hold every memory, though not the sign-in data. Older ones are narrowed on its next run. A network share mounted with fixed permissions keeps its own, so check who can open that share.

## 1.5.1 (2026-11-19)

Updating needs one check from you if you run the server yourself: BrainAI now makes `data/memory.db` and its side files readable by their owner only. The nightly `scripts/backup.sh` must run as the same user as `PUID` in `.env` (the usual setup), or as root; a job that runs as another user can no longer read the database. The desktop apps need nothing. There is no database change.

**Privacy fixes**
- **The database and its copies are owner-only.** The live database, the copies BrainAI makes in `data/pre-migrate/` before an upgrade and the backup folder could be read by other accounts on the same computer. All of them hold your sign-in secrets. Each start narrows them; nothing is ever loosened.
- **Deleted facts stay deleted more often.** When you delete a fact, an assistant that saves it again reworded, as another kind (a status instead of a decision) or under another project is held for your approval, as an exact copy already was. It is always a hold for you to decide, never a refusal.
- **The instruction check sees through disguises.** Text that reads like an instruction to an assistant is no longer missed when it uses lookalike letters from other alphabets, fullwidth forms, invisible characters, accents or line breaks inside the words. Discussion questions, replies and attached files are marked the same way pages are. Existing pages are checked again once on the first start.
- **The weekly review saves nothing while saves are paused.** Asking for the weekly review during "Pause all saves" shows the week without storing it.

**For assistants**
- Asking an assistant to harvest a session now sends it to `suggest_memories` (you pick in the Inbox), not straight to `remember`.
- An assistant is asked to keep what you said and its own suggestion in separate facts, each with its source.
- `keys` can be sent as a list of words as well as one line.

**Evidence, published**
- **Restore drill** (`npm run drill:restore`, docs/RESTORE-DRILL.md): builds a brain with every kind of data, restores it on a clean setup from the nightly copy, "Save a copy", the encrypted off-site copy and a failed upgrade, and checks 192 things, including that old sign-ins stop working and deleted facts stay deleted.
- **Security model** (docs/SECURITY.md): the trust boundaries, what each one is tested by, and the known gaps. It is the author's own review, not an independent audit.
- **Memory loop eval** (`npm run eval:lifecycle`, docs/LIFECYCLE-EVAL.md): real Claude Code and Codex sessions against a throwaway brain, scored on what ends up stored and what the assistant answers, with results before and after the fixes above and every failure listed.

## 1.5.0 (2026-11-18)

Updating needs nothing from you. BrainAI changes its database on the first start (six additions, nothing removed) and copies it to `data/pre-migrate/` first. On the desktop app, press Connect again (or "Add save reminders") on Settings › Tools to get the new save reminders.

**Each fact says how long it holds and where it came from**
- **Valid until.** An assistant can give a fact the date it stops being true (a deadline, a version, who holds a job). Recall, briefings and the fact page show "valid until …" or "past its date since …"; nothing is hidden or reordered. Facts past their date appear in the Inbox under tidy-ups, with "Still true" and "Set a new date".
- **Source.** A fact can say whether you said it, an assistant inferred it, it was imported or it came from a file, with a short note. It also records who set that: when an assistant says you said something, it reads "Codex says you said this", never as your own words. An assistant that rewrites such a fact without saying so again clears the claim. Disagreements show each side's source.
- **Your profile's size.** Brain health shows how big the profile is (every assistant reads all of it at the start of every conversation) and which entries say nearly the same thing.

**Memory that keeps itself in shape**
- **Save reminders** for Claude Code (also before a conversation is compacted), Codex and Cursor, installed by Connect and taken back by Disconnect or Remove BrainAI. BrainAI backs up each tool's settings file first and only touches its own entries. OpenCode and Grok Build have no hook that can reach the model; docs/CLIENTS.md says why.
- **Harvest.** A new tool, `suggest_memories`, lets an assistant send up to 20 decisions, statuses and facts from its session at once. Nothing is saved until you approve: they wait in your Inbox as one group with Approve all, which leaves any flagged item (reads like an instruction, close to something you deleted or replaced) for your own answer. A new skill, harvest-session, arrives as a proposal built into BrainAI; you decide whether to add it.
- **Tidy sessions.** Ask an assistant to tidy a project: it gets groups of related facts one at a time (`tidy_session`) and proposes replacing, merging, moving decisions into the project page's Key decisions, or leaving them (`propose_tidy`). Each proposal waits in your Inbox with a before and after; the originals stay as history, and replace and merge can be undone.
- **Brain health** says when a connected app read your memory 20 or more times in a week and saved nothing.

**You see and control what assistants do**
- **Activity** (Week › Activity): what each assistant saved, changed, deleted or replaced and which pages it edited, by day, filterable by assistant, with Undo on each fact. Undoing an assistant's new fact counts as you deleting it, so it is not saved straight back.
- **Saves wait for me**, per connection in Settings › Assistants: that assistant's saves, changes and deletions wait in your Inbox; its page edits and a few other direct changes are paused.
- **Pause all saves from assistants**: every assistant write stops at once, with a Resume banner on every page.

**Easier to start**
- **Import** (Settings › Backups and copies, or the first steps on Home): paste what ChatGPT, Claude or Gemini remember about you, tick the lines to keep (lines that read like instructions to assistants and duplicates start unticked), and they are saved as imported. Up to 100 facts per import. A built-in skill, import-project-folders, lets a coding assistant propose facts from your project folders. A Markdown or text file can become a page, marked "imported, not written by an assistant".
- **A Claude Code plugin**: `claude plugin marketplace add jsr1292/brainai`, then `claude plugin install brainai@brainai-plugins`. It asks for your brain's address and brings the save reminders, the harvest skill and the rules. Use it or the desktop app's Connect, not both (Connect skips Claude Code when the plugin is installed).

**The dashboard**
- **Inbox is one list**, grouped: approvals, harvested groups, tidy proposals, facts that disagree, discussions waiting, and tidy-ups "when you have time". The badge counts only what needs you. ⌘↵ (Ctrl ↵) approves, ↑↓ move between items, and Approve and Reject show a line with Undo.
- **Settings regrouped**: Assistants (on this computer, or on the web and phone through Reach), Search, Backups and copies (with Back up now, a folder picker in the app, and how to get a backup back), Other computers, Your login, and Remove BrainAI on its own at the end.
- **The phone bar** is Projects · Pages · Inbox · Week. A new brain shows first steps on Home until they are done or hidden. Projects explain the five areas and their colours; Map is now called Five areas.
- **Honest connection states**: a tool reads "Added · one step left" until it has signed in, then "Connected ✓". The welcome can be skipped or gone back through, and "Try it" says what to check when nothing arrives. Skills has its own link, Ctrl-K finds settings and places, and the project panel shows the roadmap's current step.
- **Reach** opens at once and checks Tailscale in the background (no more 30-second wait), and says it works only while this computer is on and awake.
- **Briefings** always list a couple of pages and name a page that may be out of date.

**Checks**
- Text that reads like it tries to send your chats, memories or keys to an email address is held for your approval, like text that sends them to a web address.
- A second benchmark, LongMemEval (retrieval only, no AI judge), is in docs/BENCHMARK.md: the right conversation was in the first 8 results for every question of a 140-question sample.

## 1.4.0 (2026-11-18)

If you connected Claude's desktop app through BrainAI's Connect (the Mac or Windows app), updating needs one thing from you: restart Claude's desktop app once. Until then, a bridge it already started keeps 1.3.0's code, which lacks the new check. Nothing else needs a restart.

- **Assistants get all the rules again.** Claude Code keeps only the first 4,096 characters of a server's instructions, so BrainAI's later rules (trust, failure reporting, discussions, roadmaps, pages, skills) never reached it. The instructions sent when an assistant connects are now a short version with the essentials (under 2,000 characters), and `load_profile` returns the full rules as its first block, marked as coming from BrainAI, not from stored data.
- **Project briefings stay a readable size.** `project_brief` now returns at most about 16,000 characters. The roadmap, the latest status, the newest three decisions and up to five of your open page notes are always there in full; older decisions and statuses become one-line excerpts with their ids, and the briefing says what it shortened. `all_decisions: true` returns every decision in full.
- **Tool descriptions match what the tools do.** Date ranges in `recall` are preferred, not strict, and the descriptions now say so; search words (`keys`) are described where they are actually shown; limits are stated and checked. Every tool is marked as reading or writing, so assistants can tell them apart.
- **Restores keep search working.** Restoring or importing a brain dropped BrainAI's own database triggers, so memories saved while no search model was ready were never searchable by meaning. BrainAI now puts the triggers back every time it starts, and a brain that was already restored repairs itself on its first start of this version.
- **Setup pages for Claude, ChatGPT and Grok:** in the desktop app, while Reach is off, they say these apps can't see this computer yet and send you to Reach first, instead of showing an address they cannot use. The sign-in line now matches whether you have set a password.
- **Settings setup pages are readable again.** The first-run wizard's styles no longer squeeze the steps on Settings › Set up …, Reach and Move, and the steps no longer disappear on narrow windows. The rows in Settings › Connections show their descriptions under the title.
- **Desktop app: update checks that keep failing are shown.** When checks have failed for two days, Settings › Backups and health says so, with the reason (for example, a proxy refusing the request).
- **Desktop app: a reminder when backups stay on this computer.** Home suggests keeping a copy in a folder that syncs elsewhere until you choose one; *Later* hides it for 30 days.
- **Smaller fixes:** Settings › Tools opens faster (the tools are looked at together), keyboard hints read Ctrl on Windows and Linux, long folder paths wrap on phones, and `/favicon.ico` works.
- **Desktop app: Disconnect ends the tool's sign-in.** Disconnecting Claude Code, Codex, OpenCode or Cursor in Settings › Tools now also revokes the connection it signed in with (as Revoke does in Settings › Connections), so it stops working. Other apps keep theirs.
- **Saved copies: names that Windows reads differently are refused.** A saved file is refused when an entry name holds a backslash or colon (Windows tar reads a backslash as a folder separator and a colon as a drive or stream). Lines of tar's listing that end with CRLF are read like any others.
- **Sign-in: an https callback must match exactly.** A registered https callback no longer also matches the same address with a query string added, and `/register` refuses a client whose callback has one.
- **Backups: copies are owner-only and the second folder's copier trusts only its own files.** Every daily backup and its second-folder copy is readable by you only on the Mac's own disk, and on drives where "Ignore ownership on this volume" is off in the drive's Get Info. macOS usually turns that on for external drives. There, other accounts on this Mac can read the copies. On Windows and on network drives they are not owner-only either, so choose a folder only you can open. Each run narrows copies left by 1.3.0. The copier no longer follows a link planted at its temporary or final name. It deletes only the `memory-….db` copies it made (it keeps a list in `backup-copy.json`), plus, once, the ones an earlier version left there. Choosing the folder works only on this computer, not through the public door.
- **Desktop app: after a normal stop, Funnel does not outlive BrainAI.** Reach through Tailscale is turned off when BrainAI stops normally (Quit, an update restart) and back on at every start, so a program of another account that takes BrainAI's public door while BrainAI is closed no longer receives your internet traffic. If Tailscale is not ready at start (not open, not signed in, no answer), Reach stays saved and waits. It tries again every minute for 10 tries, then every 15 minutes. The Reach page says it is waiting and shows what Tailscale last said. Reach turns itself off only when Tailscale is not installed or Funnel is not allowed for your account. A Turn off that Tailscale did not confirm is retried at the next start.
- **Saved copies: export and restore keep every name inside its folder.** A saved file with skill, skill file or project names such as `../../x` can no longer make Save a copy or Remove BrainAI write outside the chosen folder, and restoring such a file is refused.
- **Desktop app: the Claude bridge checks who is listening.** Before it sends its key, the bridge makes BrainAI prove, on every new connection, that it is BrainAI. A program of another account that takes BrainAI's port while BrainAI is closed no longer receives the key. If BrainAI is not the one answering, Claude is told BrainAI isn't running.
- **Desktop app: tool sign-ins are approved in BrainAI's window.** When Claude Code, Codex or another tool opens your browser to sign in, the browser page waits and BrainAI's window shows a banner with Review. The browser also waits for the window while sign-in from other devices is not set up (the password and the authenticator are not both set yet). Approve or deny there; the browser then goes on to the tool by itself.
- **Desktop app: no automatic sign-in.** A browser or program on the computer is no longer signed in by itself while the owner account is not fully set up; only the app's window is. Updating signs every browser and phone out once, and you sign in again with your password. Apps you connected before keep their access: check Settings › Connections.

## 1.3.0 (2026-11-16)

Updating needs nothing from you, except for the desktop app, which you install by hand once (see the first two bullets).

- **The apps are downloads:** the Mac app (a `.dmg` for Apple silicon, built to be signed and notarised by Apple) and the Windows setup are on the release
  page, with `SHA256SUMS`. No more building them yourself.
- **One-click updates in the desktop app:** it checks once a day and tells you with a dot in the menu bar or tray and
  a card on Home. *Update and restart* downloads, checks the signature, saves a backup first and reopens the app;
  *Later* hides the card for that version (the dot stays; a newer version brings it back). If an update fails, the version you run stays. Your memories and settings stay too.
- **Claude's desktop app in Connect:** Settings › Tools on this Mac (this computer on Windows) has a new row, *Claude (desktop app)*. Connect adds
  BrainAI to Claude's config; quit Claude completely and open it again. Its key stays in BrainAI's data folder and can
  be revoked in Settings › Connections. Disconnect, Remove BrainAI and the Windows uninstaller take it out.
- **ChatGPT, explained in Connect:** a row says why ChatGPT's app cannot reach a brain that lives only on this
  computer, and what to do: Reach from phone and web, or a server.
- **Windows asks once** about an unknown publisher (SmartScreen): More info › Run anyway.
- **If you run version 1.2 of the app,** it has no updater: install this version by hand once. Updates are automatic
  after that.
- **Save a copy of everything:** one button in Settings, in the app and on the dashboard. It makes a folder with the file
  BrainAI reads back, every memory as Markdown, and a README. In the app it goes into your Documents (it asks first if
  Documents syncs to iCloud or OneDrive). On a server the dashboard asks for the authenticator code and downloads a
  `.tar.gz`.
- **Remove BrainAI, in the app:** Settings › Remove BrainAI saves a copy, turns Reach off, disconnects your coding tools,
  deletes the data and removes the app. Your tools' original settings go into the saved folder. It ends with a checklist
  of what BrainAI cannot remove itself.
- **The Windows uninstaller disconnects your tools** when you uninstall from Settings › Apps. Not during an upgrade.
- **Coming back with a saved folder:** the app's welcome offers "I have a saved BrainAI folder"; on a server, run
  `docker compose run --rm app node dist/cli.js restore data/<file>`. It only fills an empty brain.
- **`scripts/remove.sh`** removes a server install: it saves a copy, lists what it will remove, waits for you to type
  `remove`, and asks about each outside copy (default: keep).
- **Import a backup file:** the app's welcome ("I have a saved BrainAI folder") and `cli restore` also take a backup file,
  `memory-<date>.db`. Sign-in is always removed. It only fills an empty brain.
- **A second backup folder:** Settings › Backups › "Also keep the daily backups in". The app warns when the folder
  syncs to iCloud or OneDrive.
- **Ask commands by default:** the app sets the commands that let Claude Code and Codex ask each other in a discussion.
  `ASK_COMMANDS` still overrides them.
- **The moving file now has the saved copy's format and name,** `brainai-saved-<date>.tar.gz`; older `brainai-move-…` files still restore.
- **Four new general rules** in the assistants' instructions.
- **The Windows zip is gone:** on Windows use the BrainAI app. If you installed the zip, see "Moving from the Windows
  zip" in docs/DESKTOP.md. `MEMORY_MODE=work` is no longer accepted.
- **The app asks how BrainAI finds things:** on first run it suggests search models for your computer ("Choose for me")
  and downloads the ones you pick. Until they arrive, keyword search works; memories saved meanwhile get their
  meaning added afterwards.
- **Models are downloaded on demand and checked:** from Hugging Face, with a GitHub release as the fallback. Each file
  is checked against a fixed fingerprint; one that does not match is deleted and reported. They use your computer's
  proxy settings.
- **A progress bar and a test search for the search models:** while they download, a bar shows how much is done; when
  they are ready, BrainAI runs a real test search and says it is ready and working, with how long it took.
- **Settings › Search:** change the search model and the reranker any time, remove a model to free its disk space, or
  load model files from a folder when the computer cannot download. A new search model re-reads your memories once, in
  the background.
- **An online reranker, if you want one:** through OpenRouter, with your own key (Voyage rerank 2.5 or Qwen3
  Reranker 8B). Each search sends your question and its best matches to the service; the key stays in the app's data
  folder. If the service is slow or down, the local reranker is used.
- **A smaller app:** the Mac app is about 281 MiB; it was about 550 MB with the models inside.
- **Existing app users:** the first start of this version downloads the models your brain already uses, once, with no
  question asked.
- **Servers:** nothing changes.

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
