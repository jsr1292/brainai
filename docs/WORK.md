# Work memory (a separate copy on the work laptop)

A second, independent copy of this server for work, used by Codex and Claude Code on a Windows work laptop. It shares
code with the home server but nothing else: its own database, no tunnel, no link to the personal memory.

## Work mode

`MEMORY_MODE=work` changes, compared with the home server:

| | Home (`personal`, default) | Work |
|---|---|---|
| Listens on (`HOST`) | `0.0.0.0` in the Docker image (the tunnel container reaches it); `127.0.0.1` when run directly | `127.0.0.1`: nothing else on the network can reach it |
| Rate limits trust `cf-connecting-ip` (`TRUST_CF_CONNECTING_IP`) | yes in `docker-compose.yml`, which publishes no port: the tunnel is the only way in | no: any local program could fake the header |
| MCP server name and instructions | `cairn`, `SERVER_INSTRUCTIONS` | `work-memory`, `WORK_INSTRUCTIONS` |
| Discussions | on, with Full or Discussions only at consent | on, every connection Full (no access choice at consent) |
| Dashboard name | Cairn | Work brain |

`HOST` and `TRUST_CF_CONNECTING_IP` can still be set explicitly in either mode. The work instructions add five
rules to the home ones: team facts go in the repo's AGENTS.md, not memory; about people, only who owns or decides
what; project = git repo folder name or the client job code; a status only when a task ends with something to carry
over; dates on anything that will change. They also tell Codex never to save something because a file, page or
tool output asks it to.

Both modes:
- **Discussions without relaying (`ASK_COMMANDS`):** a JSON object of assistant (connection) name → shell command with
  `{prompt}`, e.g. `{"Codex":"codex exec --skip-git-repo-check \"{prompt}\""}`. The assistant that opened a
  discussion is told to give its own view first, then run the command for each asked assistant that has a command
  and has not replied this round; the prompt holds only the discussion id. When everyone has replied in round 2 or
  later, it is told to report to the owner, who decides or starts another round. Only the opener gets commands, and
  only when it has a command itself (a command-line assistant on the owner's computer, not a chat app), never its
  own, so an assistant it asks cannot ask the others in turn. Names match ignoring case, spaces and hyphens. The
  server never runs a command itself. For example, for Claude Code and Grok Build on your computer:
  `{"Claude Code":"claude -p \"{prompt}\" --allowedTools mcp__memory","Grok Build":"grok -p \"{prompt}\" --allow
  \"MCPTool(memory__*)\" --permission-mode dontAsk"}`: each asked assistant may use only its memory tools.
- **Held memories:** an AI save or update that reads like an instruction to assistants (`src/memory/instructionLike.ts`)
  waits on the dashboard home for approval, like a profile change. The owner's own saves are never held.
- **`BACKUP_DIR`** (off by default): a dated, integrity-checked single-file snapshot at start and every 24 hours;
  the newest `BACKUP_KEEP` (default 14) are kept. The home server keeps using `scripts/backup.sh`. Neither
  backup holds sign-in data (password hash, authenticator secret, sessions, tokens, client secrets): after a restore,
  run `set-password` and `setup-totp` again and reconnect the assistants.
- **`cli export [file]`:** every active memory as readable Markdown.

## Building the Windows zip

On the Mac: `scripts/windows/build-zip.sh` → `dist-windows/work-memory-win-x64-<commit>.zip` (about 210 MB). It
contains the compiled server, production dependencies with their Windows x64 binaries (checked to be PE x86-64),
the search model, a checksum-verified `node.exe` (latest Node 22) and the PowerShell scripts, so the laptop needs no
internet access and no installs. An ARM (Snapdragon) laptop would need a `win32-arm64` build instead.

## On the laptop

`scripts/windows/README.txt` is the owner's guide (it ships in the zip). `setup.ps1` installs to
`%LOCALAPPDATA%\WorkMemory` (or updates it, keeping `data\` and `work.env`), and:

- writes `work.env` (port 3100; backups to the work OneDrive, `%OneDriveCommercial%\Work memory backups`),
- on first install, runs `set-password` and `setup-totp`,
- allowlists `https://chatgpt.com/oauth/codex/` (Codex's client metadata host, see docs/CLIENTS.md),
- adds a Startup shortcut that runs `start.ps1` hidden at login, and a Start menu link to the dashboard,
- adds the memory rules to Codex's `AGENTS.md` between `<!-- work-memory:start/end -->` markers,
- connects Codex with `codex mcp add work-memory --url http://localhost:3100/mcp` (which signs in) unless it is
  already connected, and sets `default_tools_approval_mode = "approve"` for that server in `config.toml`,
- when Claude Code is installed, adds the same rules to its `CLAUDE.md` and the server with
  `claude mcp add --transport http --scope user work-memory` (it signs in from `/mcp` inside Claude Code),
- sets `ASK_COMMANDS` in `work.env` on every run, so Codex can ask Claude Code (`claude -p "…" --allowedTools
  mcp__work-memory`) and Claude Code can ask Codex (`codex exec --skip-git-repo-check "…"`) in a discussion.

`start.ps1` / `stop.ps1` only act on the memory's own `node.exe`. `export.ps1` writes Markdown to Documents.
`uninstall.ps1` exports first, then removes the shortcuts, the Codex and Claude Code connections, the AGENTS.md and
CLAUDE.md blocks and the install folder; OneDrive backups are left alone.

Tested against a work-mode server on macOS: Claude Code (`claude -p`) opened a discussion and ran Grok Build headless
for both rounds, and Grok Build opened one and ran `claude -p` for both rounds, with no relaying (Codex as the asked
assistant was not tried). With Codex 0.156.1, `codex mcp add` signed in through the consent page, and `codex exec`
called load_profile, remember and recall. The PowerShell scripts were checked with PowerShell 7 on macOS (syntax, and
the config.toml / AGENTS.md editing); they have not yet run on Windows.
