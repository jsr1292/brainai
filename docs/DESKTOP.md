Leer en español: [docs/es/DESKTOP.md](es/DESKTOP.md)

# The BrainAI desktop app

The BrainAI app runs BrainAI on your own computer, with no server, no domain and no terminal: on a Mac with Apple silicon,
and on Windows 10 or 11 (x64). Download it from the [latest release](https://github.com/jsr1292/brainai/releases/latest).

## Installing it

- **Mac:** open `BrainAI_<version>_aarch64.dmg` and drag BrainAI to Applications. A release is built to be signed and
  notarised by Apple, so that it opens with no warning (see "A signed build for other Macs").
- **Windows:** see "On Windows" below.

If you run version 1.2, it has no updater: install this version over it by hand once. Your memories stay.

## Updating

The app checks once a day (and Settings › Version › Check for updates checks now). When a newer signed release is out, the
app downloads it by itself in the background and checks its signature; you keep working. A thin line above Settings in
the sidebar shows "Downloading update · 42%", and the tray tooltip says the same.

- When the download is done the update is **ready**: the sidebar says "Update ready · Restart", the tray menu has
  **Restart to update**, and a card on Home says what is new, with **Restart now**. Restarting saves a backup of your
  memories, installs the update and reopens the app, in a few seconds. Your memories, settings and connected tools stay.
  On Windows the installer runs silently (no window, no permission question: it installs for your user only).
- **Quit BrainAI** from the tray while an update is ready backs up and installs it without reopening, so the next time
  you open BrainAI it is the new version. If the backup or the install fails, BrainAI quits anyway (it waits for the backup one minute at most) and says why in
  `logs/update.log`. Meanwhile the window hides and the tray icon's tooltip says "Installing update…".
- **Later** hides the Home card for that version. The dot and the sidebar line stay, and a newer version brings the card back.
- The downloaded update lives in memory only. If BrainAI stops before installing it, the next check downloads it again.
- A failed download shows the reason on the card with **Try again**, and is tried again after 6 hours, then every 24. A download that fails its signature check is not fetched again by itself for that version; a newer version clears it. Nothing pops up.
- After an update, the first time the app opens, Home says "Updated to 1.7.2 · What's new" (**What's new** shows the
  release notes). It stays until you press **Dismiss** or the next update arrives.
- On Windows the app disappears for a few seconds while it updates (it closes, the installer runs without a window, and the app opens again). If the old version cannot be closed, the update stops before anything is replaced.
- If anything fails on the way, the version you are running stays as it was.

## What it does

- Opening the app starts BrainAI and shows its dashboard in the app's window, already signed in. On a new install the
  first screen leads to connecting your first assistant.
- A brain icon sits in the menu bar: **Open BrainAI**, **Start at login** (on after the first start), **Quit BrainAI**.
  Closing the window leaves BrainAI running; Quit stops it.
  The menu, the dialogs and the installer speak English or Spanish (Spain): the choice in Settings › Language, else the
  system language (see docs/I18N.md).
- Only apps on this Mac can reach it, and there is no password, until you turn on Reach from phone and web (below).
  On this computer BrainAI is used from its own window. With no password set, a browser is not signed in: it shows
  "Open BrainAI's window". Only the window (through its one-time ticket) or the password gives a session.

## Connecting your tools

The first time, the app opens on a short welcome of five steps: your name (optional); **Your apps**; search; the coding
tools it finds on this Mac, each with **Connect**; then "Try it", which shows the first memory an assistant saves. The
same buttons are in Settings › Tools on this Mac, with **Disconnect**.

**Your apps** asks which AI apps you use and says straight away which of them work on this computer (the coding tools
and the Claude app: no password, nothing leaves the computer) and which need an extra step (ChatGPT, Claude on the web
and Grok run on their makers' computers, so they need BrainAI to have its own internet address). For those you choose
to make this computer reachable (a Mac only, see Settings › Reach from phone and web), to put BrainAI on a server, or
"Not now"; setup carries on either way, and a card on Home reminds you of the next step until you dismiss it. Apps you
tick come first in Connect. Ticking nothing, or Skip, carries on to search and replaces an earlier answer with none.

| Tool | What Connect does | Then |
|---|---|---|
| Claude Code | `claude mcp add --transport http --scope user brainai …`, and its rules in `~/.claude/CLAUDE.md` | In Claude Code: `/mcp` → brainai → Authenticate |
| Codex | `codex mcp add brainai --url …`, tools approved in `~/.codex/config.toml`, rules in `~/.codex/AGENTS.md` | Your browser opens to sign it in |
| OpenCode | `mcp.brainai` in `~/.config/opencode/opencode.json`, rules in `~/.config/opencode/AGENTS.md` | `opencode mcp auth brainai` |
| Cursor | `mcpServers.brainai` in `~/.cursor/mcp.json` | Paste the rules shown into Cursor › Settings › Rules |
| Gemini CLI (not tested yet) | `mcpServers.brainai.httpUrl` in `~/.gemini/settings.json`, rules in `~/.gemini/GEMINI.md`; found when `gemini` is on your PATH | In Gemini CLI: `/mcp auth brainai` |

Each tool's sign-in opens your browser, which waits and says to open BrainAI's window. There a banner shows the tool; press Review, then Approve or Deny. The browser then goes on to the tool by itself. (With a password set for Reach, the browser signs in with the password and shows the consent page, as before.) Connect never changes a tool that already uses
another BrainAI (for example a home server, under the name `memory`) unless you press **Replace**, and even then it
leaves that other entry alone. Every file is backed up next to itself as `<name>.brainai-backup` before a change, and
only the part between the `<!-- brain setup -->` lines is ever written. An `opencode.jsonc` (with comments) is not
rewritten: add OpenCode by hand from Settings › Set up an app.

### Claude (desktop app)

Claude's own app (the one with the chat window, not Claude Code) is in the same list, as **Claude (desktop app)**.
Connect adds a `brainai` entry to Claude's `claude_desktop_config.json`: on the Mac in
`~/Library/Application Support/Claude/`, on Windows in `%APPDATA%\Claude\`. The entry runs BrainAI's own Node with
`dist/cli.js claude-bridge`, a small helper that passes Claude's questions to BrainAI on this computer. Its settings
are `BRAINAI_DATA_DIR` and `BRAINAI_PORT_FILE`.

- **One step after Connect:** quit Claude completely and open it again. On the Mac that is ⌘Q. On Windows, quit it
  from the tray icon. Closing the window is not enough.
- **The key** is a file in BrainAI's data folder (`claude-desktop-key`; on the Mac, readable only by you). It is never written to
  Claude's config. It shows in Settings › Connections as "Claude (desktop app)", and revoking it there disconnects
  Claude.
- **"Needs connecting again"** appears if the key was revoked, BrainAI moved to another port, or the app was moved.
  Press Connect and it is fixed. Connect is refused while BrainAI runs from the disk image: move it to Applications
  first.
- **If BrainAI is not running,** Claude says so. If Claude starts at login before BrainAI does, it waits up to 30
  seconds for it.
- **To remove it,** press Disconnect. Remove BrainAI and the Windows uninstaller do the same: they take the entry out
  and revoke the key. An update keeps it.
- **Windows, Microsoft Store build:** Connect writes `%APPDATA%\Claude\claude_desktop_config.json`. The Store version
  of Claude may keep its config somewhere else. If Claude does not show BrainAI after a restart, that is the likely
  reason.

### ChatGPT

There is no Connect for ChatGPT. Its app cannot reach a brain that lives only on this computer. Instead, on the Mac,
turn on **Reach from phone and web** (below), then add BrainAI in ChatGPT on the web. On Windows, where Reach is not available, put BrainAI on a server
(see "Move it to a server"); a server works from the Mac too. Technical users can also look at OpenAI's developer
[Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels).

## Reach from phone and web

Settings › Reach from phone and web lets Claude, ChatGPT and Grok on the web and your phone use this Mac's BrainAI too,
keeping every memory and every tool you connected:

1. **Set a password**, then **add BrainAI to your authenticator** (scan the QR code, confirm with a code). From then on
   a browser asks for both; the app's window stays signed in.
2. **Turn on.** BrainAI uses Tailscale Funnel to give the Mac a public address, `https://<mac>.<tailnet>.ts.net`, free and
   with no domain. Install the Tailscale app and sign in first; the first time, Tailscale may ask you to allow Funnel
   for your account (the page shows the link).
3. Connect each web app from its setup page, which now shows the public address. The tools on this Mac keep using
   `http://localhost`.

Phone and web reach BrainAI only while the Mac is on and awake. **Turn off** closes the public address; local tools keep
working and the password stays. Every sign-in is tied to the address it was made at, so a web app's connection only
works through the public address and a local tool's only on this Mac.

Tailscale forwards to a separate door that BrainAI opens only while Reach is on, and everything through it is treated
as the internet. BrainAI turns Funnel off when it stops (Quit, an update restart) and back on at every start, so after a normal stop Tailscale
never keeps forwarding to a door BrainAI no longer holds. If Tailscale is not ready at start (for example not signed in
yet), Reach stays saved and BrainAI waits. It tries again every minute for the first 10 tries, then every 15 minutes, for
as long as Tailscale is not ready. The Reach page says it is waiting and shows what Tailscale last said. Funnel is off meanwhile.
Reach turns itself off only when Tailscale is not installed or Funnel is not allowed for your account. If Turn off cannot reach Tailscale,
BrainAI remembers it (`funnel-off-pending` in its data folder) and asks again at the next start. After a crash or a
power cut Funnel can stay on until the next start: turn it off in Tailscale (`tailscale funnel --https=443 off`) if
BrainAI will not be started again. Once set, the password and the authenticator are not changed from the dashboard.

### Your own domain (Cloudflare)

If you have a domain on Cloudflare, Reach can use it instead of Tailscale: `https://brain.<your domain>`.

1. Install `cloudflared` (`brew install cloudflared`).
2. **Sign in to Cloudflare:** Cloudflare's page opens in your browser; sign in and choose the domain. BrainAI keeps this
   sign-in, and everything else it gives `cloudflared`, in its own data folder (`cloudflared/`): your own
   `~/.cloudflared` is never read or changed. Chose the wrong domain? **Use another Cloudflare domain** signs in again.
3. **Choose the name** and **Turn on.** BrainAI makes a tunnel for this Mac, adds the name in Cloudflare's DNS, starts
   the tunnel and checks that BrainAI answers there before saying On. A name already in use is refused: BrainAI never
   replaces a DNS record. The tunnel's credentials stay in BrainAI's data folder.

The tunnel runs while Reach is on and BrainAI is running. **Turn off** stops it; the name stays in Cloudflare (showing
Cloudflare's "tunnel offline" page) and is used again next time. To remove it for good, delete the record and the
tunnel (named `brainai-…`) in Cloudflare's dashboard (Networking › Tunnels).

*Not yet tried with a real Tailscale or Cloudflare account*: built and tested against stand-ins for their commands.

## Move it to a server

For a brain that should be on all the time: Settings › Move to a server.

1. **Make the moving file:** one file with every memory, page and picture, and none of your sign-in details.
   It is the same archive a saved copy holds (see "Leaving BrainAI"). It stays in BrainAI's data folder until you copy
   it; Show in Finder finds it.
2. **Set up the server** and bring the file in there: `docs/RUNBOOK.md`, "Moving from the app". The server gets its own
   password and authenticator, and each app connects to the server's address from its Settings.
3. **It's moved:** give the server's address. This Mac then tells any app still pointed at it where the brain lives,
   turns Reach off, and offers **Remove BrainAI from this Mac**, the same Remove BrainAI as in Settings (below).
   **Not moved after all** undoes step 3.

## Leaving BrainAI

**Save a copy of everything** (Settings) saves your memories any time and changes nothing else. It makes a folder
called `BrainAI saved <date>` in your Documents, then offers Show in Finder (Show in Explorer on Windows). If your
Documents folder syncs to iCloud Drive or OneDrive, the app says so first, because the copy holds every memory in
clear text: it suggests your home folder instead, and you can still choose Documents. The folder holds:

- `brainai-saved-<date>.tar.gz`: every memory, page and picture, in the one file BrainAI can bring back. No password,
  authenticator or app sign-in is in it.
- `Markdown/`: every page and fact as plain files you can read anywhere.
- `README.txt`: what the folder is, how to bring it back, and the checklist of what BrainAI could not remove.
- `Original tool settings/`: after a removal, your tools' settings as they were before BrainAI changed them. This
  includes Claude's config and Cursor's `mcp.json`, which may hold the keys of other MCP servers you use: keep the
  folder private.

**Remove BrainAI** (Settings) does this, in order. If step 1 fails it stops; after that, a step that fails is listed on the last page and the rest still run:

1. Saves a copy and checks it. If that fails, nothing is removed.
2. Turns Reach off, and deletes the Cloudflare tunnel BrainAI made, if there was one.
3. Disconnects Claude Code, Codex, OpenCode, Cursor, Gemini CLI and Claude's desktop app (its entry goes and its key is revoked), and takes out BrainAI's rules. Your own text stays. A tool
   connected to another BrainAI is left alone.
4. Removes BrainAI's Claude Code hooks and folder report, if you had them, and moves the tools' original settings
   (`<name>.brainai-backup`) into the saved folder.
5. When you choose **Finish removing BrainAI** on the last page, the app asks its server whether the removal finished
   with a saved copy (if not, it says so and removes nothing), then asks you, naming the saved folder. Only after
   **Remove BrainAI** there does it stop BrainAI from starting at login and delete its data folder.
6. Removes the app: on a Mac it moves itself to the Trash as it quits; on Windows it runs its own uninstaller.

The last page shows the checklist and where the saved folder is. The checklist covers what lives outside this computer:
the connectors in Claude, ChatGPT and Grok on the web and phone, and the text you pasted into their instructions.

**Dragging the app to the Trash** does none of this, and BrainAI cannot catch it. If you already did, your tools still
point at it: disconnect BrainAI in each tool. To finish removing it, delete these three things:
`~/Library/Application Support/io.github.jsr1292.brainai`, `~/Library/LaunchAgents/BrainAI.plist` and
`BrainAI.app` if it is still there. The memories are in that first folder: copy `data/memory.db` somewhere first if you
want to keep them.

## Coming back

On a new install, the first screen has **I have a saved BrainAI folder**. Choose the `brainai-saved-<date>.tar.gz`
file inside the saved folder (an older `brainai-move-…` file works too). BrainAI checks it, restarts, and brings back every fact, page,
picture and approval. Then the welcome goes on to connecting your tools.

It only brings a copy into an empty brain. If BrainAI already holds memories, it says so and does nothing. Nothing about
signing in comes back: your apps sign in again. A copy from a newer BrainAI than yours is refused; update the app first.

The same choice also takes a backup file, `memory-<date>.db`, from a backups folder (the app's own, or a server's
`backups/`). It brings back the memories and pages. A lone backup file has no pictures, so their pages keep their text (the welcome says
how many); but when an `images` folder sits beside the file, its pictures come back too. Sign-in is always removed, so sign in again where asked.

**The second folder** (Settings › Backups › Also keep the daily backups in) gets the finished backup file and also the
pictures, in `images/` next to the `memory-<date>.db` files, copied once each. Pictures deleted for good more than 30 days ago leave it, as in the main
backups. The copy is not encrypted: a folder that syncs (OneDrive, Dropbox, iCloud) means that service stores your memories in readable form;
an external drive or a private folder is the private option. If copying the pictures fails, the copy shows as failed in Settings, Home and Brain
health. To restore from it, choose **I have a saved BrainAI folder**, then the newest `memory-<date>.db` in that folder: the `images` folder beside it comes back with it.

## Moving from the Windows zip

The BrainAI Windows zip (a private install in `%LOCALAPPDATA%\WorkMemory`, with PowerShell scripts) is gone. On Windows
use the BrainAI app. To bring what the zip holds into the app:

1. Make the Windows zip install write a fresh backup. Open PowerShell in `%LOCALAPPDATA%\WorkMemory` and run
   `powershell -ExecutionPolicy Bypass -File .\stop.ps1`, then `powershell -ExecutionPolicy Bypass -File .\start.ps1`.
   It writes a backup file when it starts; wait about a minute.
2. Copy the newest `memory-<date>.db` to your Documents. If OneDrive for work or school was set up, it is in the folder
   "Work memory backups" in that OneDrive; otherwise it is in `%LOCALAPPDATA%\WorkMemory\backups`. Check the file is
   in Documents before the next step: removing the zip install deletes its own backups folder.
3. Remove the Windows zip install: in `%LOCALAPPDATA%\WorkMemory` run
   `powershell -ExecutionPolicy Bypass -File .\uninstall.ps1` and type `delete` when it asks. It also writes a Markdown
   export to Documents and disconnects Codex and Claude Code.
4. If the BrainAI app is already on this computer from trying it, uninstall it first with "Delete the application
   data" ticked: an import only fills an empty brain. Save a copy first if it holds memories you want.
5. Install the BrainAI app, choose **I have a saved BrainAI folder** on the welcome and pick that file.
6. Connect your tools on the next step.

Sign in again where asked: sign-in never moves.

## Search models

The app does not carry the search models. The first time it opens, it asks how BrainAI should find things and suggests
what fits this computer; you tick what you want, and it downloads only that. Until the models arrive, keyword search
works. A memory saved meanwhile gets its meaning added once the models are there.

| | What it does | Size |
|---|---|---|
| **Light** (search) | Finds memories by meaning: fastest. multilingual-e5-small, MIT licence | 135 MB |
| **Balanced** (search) | The same, a little more accurate and about 10 ms slower per search. EmbeddingGemma 300M, Gemma Terms of Use (the download includes Google's notice and the terms) | 219 MB |
| **Standard** (reranker) | Puts the right match first among the first few. mmarco-mMiniLMv2-L12, Apache-2.0 | 136 MB |
| **None** (reranker) | Skips that step: nothing to download, a little less exact | 0 |

**Choose for me** picks by the computer: under 4 GB of memory, Light and no reranker; on Apple silicon, or with 8 GB
of memory or more (and at least 1 GB of free disk), Balanced and Standard; otherwise Light and Standard. A larger
reranker, bge-reranker-v2-m3, was tried and not adopted (`docs/superpowers/notes/2026-11-13-strong-reranker-trial.md`).

The models live in the app's data folder, in `models/` (see "Where things are"). Downloads come from Hugging Face; a
GitHub release (`models-v1`) is the fallback source. Both work: Hugging Face is tried first, GitHub second. They use the
computer's proxy settings. Every file is checked against a fixed fingerprint (SHA-256); a file that does not match is
deleted and reported.

**An existing install** keeps the models its brain already uses: on the first start of this version the app downloads
those same models, with no question asked.

### Settings › Search

Change the models any time. A new search model re-reads every memory once, in the background; a new reranker works at
once. **Remove** on a downloaded model frees its disk space (a model in use cannot be removed). **Load model files from
a folder** is for a computer that cannot download: choose a folder holding a model's files; each is checked before
anything is copied, and a wrong file is refused.

### Online reranker (OpenRouter)

Instead of the local reranker you can use one on OpenRouter, with your own OpenRouter key (Settings › Search ›
OpenRouter key):

- **Voyage rerank 2.5** (`voyageai/rerank-2.5`): does not train on what you send, but may keep it.
- **Qwen3 Reranker 8B** (`qwen/qwen3-reranker-8b`): keeps nothing (zero data retention); a little slower.

For each search, your question and about 20 best matches are sent to the service. Nothing leaves this computer
otherwise. The key is stored only in the data folder (the file `openrouter-key`, readable by you alone), never in your
brain, a saved copy, a backup or a page. If the service is slow or down, that search uses the local reranker.

*Servers are different:* they keep `EMBED_MODEL` and `RERANK` in `.env`, with the models built into the image.

## Where things are

| | |
|---|---|
| Your memories | `~/Library/Application Support/io.github.jsr1292.brainai/data/memory.db` |
| Daily backups (the newest 14) | `…/io.github.jsr1292.brainai/backups/`, and a second folder if you set one (Settings › Backups) |
| Downloaded search models | `…/io.github.jsr1292.brainai/models/` |
| The server's log | `…/io.github.jsr1292.brainai/logs/server.log` |
| Its port | `…/io.github.jsr1292.brainai/brainai.json` (3100 unless something else had it) |

**A second backup folder:** Settings › Backups and copies › "Also keep the daily backups in" copies each daily backup to a folder
you choose (an external drive, a synced folder). It keeps the newest 14 (BACKUP_KEEP) `memory-….db` files there and removes older
ones; nothing else in the folder is touched. The copies are readable by you only on the Mac's own disk, and on drives where "Ignore ownership on this volume" is off (check it in the drive's Get Info). macOS usually turns that on for external drives, so there other accounts on this Mac can read the copies. On Windows and on network drives they are not owner-only either, so choose a folder only you can open. The app deletes only the copies it made, plus, once, the ones an earlier version left there. If that folder syncs to iCloud Drive or OneDrive the app warns you,
because the backups hold every memory in clear text.

Updating or reinstalling the app never touches the data folder. To remove BrainAI, use **Remove BrainAI** (next section).

Apps connect to `http://localhost:<port>/mcp` (Settings › Set up an app shows the exact address and steps). If the
port ever has to change because another program took it, the app says so and the apps need connecting again.

## On Windows

The same app, with the tray icon (by the clock) instead of the menu bar. What differs:

- **Installing:** run `BrainAI_<version>_x64-setup.exe`. It installs for you alone, with no admin rights, in
  `%LOCALAPPDATA%\BrainAI`. Windows asks once about an unknown publisher (the app is not signed with a paid
  certificate); **More info › Run anyway**. Or, from PowerShell, one line downloads the installer, checks its checksum
  and runs it without that screen:
  `irm https://github.com/jsr1292/brainai/releases/latest/download/install-app.ps1 | iex`. Offline, give the script the
  file: `powershell -ExecutionPolicy Bypass -File install-app.ps1 -Installer .\BrainAI_<version>_x64-setup.exe` (with
  `SHA256SUMS` next to it).
- **Microsoft's Visual C++ runtime** comes with the app: the five files its search engine and password hashing need
  (`vcruntime140*.dll`, `msvcp140*.dll`, version 14.44) sit in the folders of the two modules that load them
  (onnxruntime's and argon2's, under `server\node_modules`), where Windows looks first, so it runs on a PC without
  the runtime, or with an older one, and needs no administrator. They are Microsoft's own files, taken from Microsoft's
  official redistributable and checked against pinned fingerprints when the app is built; each BrainAI release
  carries the version it was built with. They remain Microsoft's, redistributed under the distributable-code terms of
  Microsoft's Visual Studio licence, not BrainAI's MIT licence.
- **Where things are:** your memories, backups and log are in `%LOCALAPPDATA%\io.github.jsr1292.brainai\` (`data\`,
  `backups\`, `models\`, `logs\server.log`). Updates and reinstalls keep that folder.
- **Connect** finds Claude Code, Codex, OpenCode and Cursor as on the Mac (including npm's `claude.cmd` and the like),
  and Claude's desktop app (see "Claude (desktop app)" above).
- **Reach from phone and web** is Mac-only for now: on Windows, use BrainAI from the apps on this computer, or move it to
  a server.
- **Removing it:** use **Remove BrainAI** in the app (see "Leaving BrainAI"): it saves a copy, then runs the uninstaller
  silently and deletes the data folder. Uninstalling from Settings › Apps › BrainAI also disconnects your coding tools
  (it does not when an update replaces the app). It saves no copy: the data folder stays unless you tick "Delete the
  application data", and the kept folder is your copy. Start at login is removed with the app.

## How it works

The app is a small Tauri shell (`desktop/src-tauri`, Rust) around the same server as the home-server install. On
each start it:

1. takes the port from `brainai.json`, or the first free one from 3100 to 3199 on both `127.0.0.1` and `[::1]`;
2. makes a new random key and starts the bundled Node with the server in local mode (`LOCAL_MODE=true`, the Mac's
   time zone, data in the folder above, nothing else from your environment);
3. asks the server to prove it holds the key (`GET /app/hello`, an HMAC of a fresh challenge), so the key is never
   sent to some other program on that port;
4. trades the key for a one-time ticket (`POST /app/ticket`) and opens the window at `/app/open?ticket=…`.

The server stops cleanly when the app quits, and also if the app is force-quit or crashes (it watches a pipe from
the app). If the server stops by itself, the app starts it again on the same port and says so. A second launch shows
the running app's window instead of starting another server. After a quick relaunch the app waits a few seconds for
its usual port rather than moving. Links to other sites open in your browser.

## Building it

On an Apple-silicon Mac with Node 22 and Rust (`rustup`):

```bash
desktop/scripts/stage-server.sh          # the server bundled with esbuild (dist/index.js, cli.js, hooks; about 330 files) + the darwin-arm64 native packages and Node 22 (no models)
desktop/scripts/smoke-staged-server.sh   # starts the staged server on a temp folder and checks pages, ticket, MCP, search model, cli
cd desktop && npm install && npx tauri build --bundles app
```

The app is in `desktop/src-tauri/target/release/bundle/macos/BrainAI.app` (about 281 MiB: the server's dependencies
and Node; no models, which the app downloads into its data folder once they are chosen). `cd desktop/src-tauri &&
cargo test` runs the shell's tests; the server's are `npm test` at the top of the repo.

**The Windows app** is built on the same Mac, cross-compiled for x64 Windows. Once, install the tools (cargo-xwin
downloads Microsoft's Windows SDK and C runtime, which means accepting Microsoft's licence for them):

```bash
brew install nsis llvm lld cabextract
cargo install --locked cargo-xwin
rustup target add x86_64-pc-windows-msvc
```

Then `desktop/scripts/build-windows.sh` stages the server for Windows and writes
`dist-windows/BrainAI_<version>_x64-setup.exe` and its `SHA256SUMS`. It also stages Microsoft's Visual C++ runtime
(`scripts/windows/vcruntime.sh`): it downloads Microsoft's `VC_redist.x64.exe` once (kept in `~/.cache/brainai`),
refuses it unless its fingerprint matches the pinned one, unpacks the five files with cabextract and checks each
one's fingerprint too. A newer runtime (Microsoft's security fixes) means updating those pins.

## A signed build for other Macs

Other people's Macs only open an app signed with a **Developer ID Application** certificate and notarised by Apple.
An "Apple Development" certificate is not enough. The signature shows the certificate holder's name to anyone who
checks the app. `scripts/publish/build-apps.sh` automates this (see "Publishing a release" below). The first real
Developer ID build and notarisation is still to come, so it may need adjusting. This is what it does, if you want to
do it by hand.

Notarisation needs the hardened runtime, under which Node may only compile JavaScript and load the server's native
modules with the permissions in `desktop/src-tauri/Entitlements.plist` (`allow-jit`, `allow-unsigned-executable-memory`,
`disable-library-validation`), and every native file in the bundle signed:

```bash
desktop/scripts/stage-server.sh
desktop/scripts/sign-resources.sh "$APPLE_SIGNING_IDENTITY"     # the .node and .dylib files in the staged server
cd desktop && npx tauri build --bundles app,dmg                  # signs the app and Node, then notarises
```

Tauri signs and notarises when these are set (check Tauri's "macOS code signing" guide for the current names):
`APPLE_SIGNING_IDENTITY` (the certificate's name, as `security find-identity -v -p codesigning` shows it), and for
notarisation an App Store Connect API key (`APPLE_API_ISSUER`, `APPLE_API_KEY`, `APPLE_API_KEY_PATH`) or
`APPLE_ID`, `APPLE_PASSWORD` (an app-specific password) and `APPLE_TEAM_ID`.

With `CI=true` in the environment, the build skips the dmg's Finder window layout (which needs permission to control
Finder, and times out from a terminal without it). The dmg still holds the app and the Applications link. Give your
terminal that permission (System Settings › Privacy & Security › Automation) to keep the layout.

## Publishing a release

For maintainers. A release is the source on the public repo, the two apps, and the update files the apps check.

**The keys.** Everything lives outside the repo:
- The **updater key** signs every update, and every installed app checks it: `~/.config/brainai/updater.key`, with its
  password in the Mac's Keychain (`brainai-updater`). Keep a copy of both somewhere safe. If they are lost, installed
  apps can never be updated again, and everyone installs by hand.
- The **Developer ID Application certificate** is in the login keychain. The **notary password** (an app-specific
  Apple password) is in the Keychain (`brainai-notary`). `~/.config/brainai/release.env` holds `APPLE_ID` and
  `APPLE_TEAM_ID`.

**The steps.** First write the `## <version>` entry in `CHANGELOG.md`, bump `package.json` and
`desktop/src-tauri/tauri.conf.json`, and commit. Then, in this order (a failed step stops the rest, and nothing is
public before step 4):

1. `scripts/publish/release.sh <denylist> <public-repo-url> <version> --dry-run`: the gate, the tests, the version and
   changelog checks. Nothing is pushed.
2. `scripts/publish/build-apps.sh <version>`: builds, signs and notarises the Mac app, builds the Windows installer, and
   writes `dist-release/<version>/` with `latest.json`, `release-notes.md` and `SHA256SUMS`.
3. `scripts/publish/check-release-files.sh <denylist> dist-release/<version>`: the files hold no private words.
4. `scripts/publish/release.sh <denylist> <public-repo-url> <version> --no-tests`: pushes the source and the tag.
5. `scripts/publish/upload-models.sh --if-missing`: puts the search-model files on the prerelease `models-v1` (the
   fallback when Hugging Face is unreachable) unless they are already there. It refuses a file whose SHA-256 differs
   from the pin, and the release is never marked "latest".
6. `scripts/publish/upload-release.sh <version> dist-release/<version>`: creates the release as the latest (or uploads
   over it, if a run was cut short), then downloads `latest.json` and `SHA256SUMS` from the public address and checks
   them.

Then try the dmg and the Windows setup by hand on a clean account or computer.

**A trial build.** `scripts/publish/build-apps.sh <version> --ad-hoc` signs with a throwaway identity, skips notarisation
and writes `dist-release/<version>-adhoc`, which is never uploaded.

**Without the updater key** you can still build and run the app for yourself, as in "Building it" above: it just makes no
update files, so that copy is never offered an update. `build-apps.sh` refuses to run without the key, so a release
can never ship files nobody can update from.
