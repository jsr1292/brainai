# Changelog

Each release says what changed and whether updating needs anything from you. Updating is always
`git pull && docker compose up -d --build` in `~/memory`; BrainAI copies its database to `data/pre-migrate/` before
any change to it. Settings › Backups and health shows the version you run.

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
