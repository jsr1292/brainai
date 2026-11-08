# The BrainAI desktop app

The BrainAI app runs BrainAI on your own computer, with no server, no domain and no terminal: on a Mac with Apple silicon,
and on Windows 10 or 11 (x64). It is in progress: today it is built from source and unsigned. Windows is a test
build, and has not yet been tried on a real Windows computer (see "On Windows" below).

## What it does

- Opening the app starts BrainAI and shows its dashboard in the app's window, already signed in. On a new install the
  first screen leads to connecting your first assistant.
- A brain icon sits in the menu bar: **Open BrainAI**, **Start at login** (on after the first start), **Quit BrainAI**.
  Closing the window leaves BrainAI running; Quit stops it.
- Only apps on this Mac can reach it, and there is no password, until you turn on Reach from phone and web (below).

## Connecting your tools

The first time, the app opens on a short welcome: your name (optional), then the coding tools it finds on this Mac,
each with **Connect**, then "Try it", which shows the first memory an assistant saves. The same buttons are in
Settings › Tools on this Mac, with **Disconnect**.

| Tool | What Connect does | Then |
|---|---|---|
| Claude Code | `claude mcp add --transport http --scope user brainai …`, and its rules in `~/.claude/CLAUDE.md` | In Claude Code: `/mcp` → brainai → Authenticate |
| Codex | `codex mcp add brainai --url …`, tools approved in `~/.codex/config.toml`, rules in `~/.codex/AGENTS.md` | Your browser opens to sign it in |
| OpenCode | `mcp.brainai` in `~/.config/opencode/opencode.json`, rules in `~/.config/opencode/AGENTS.md` | `opencode mcp auth brainai` |
| Cursor | `mcpServers.brainai` in `~/.cursor/mcp.json` | Paste the rules shown into Cursor › Settings › Rules |

Each tool's sign-in shows BrainAI's consent page: you click Allow. Connect never changes a tool that already uses
another BrainAI (for example a home server, under the name `memory`) unless you press **Replace**, and even then it
leaves that other entry alone. Every file is backed up next to itself as `<name>.brainai-backup` before a change, and
only the part between the `<!-- brain setup -->` lines is ever written. An `opencode.jsonc` (with comments) is not
rewritten: add OpenCode by hand from Settings › Set up an app.

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
as the internet. If BrainAI is quit, removed or reset while Funnel is still on in Tailscale, the public address reaches
nothing. Once set, the password and the authenticator are not changed from the dashboard.

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

1. **Make the moving file:** one file with every memory, page and picture, and none of your sign-in details. It stays
   in BrainAI's data folder until you copy it; Show in Finder finds it.
2. **Set up the server** and unpack the file there: `docs/RUNBOOK.md`, "Moving from the app". The server gets its own
   password and authenticator, and each app connects to the server's address from its Settings.
3. **It's moved:** give the server's address. This Mac then tells any app still pointed at it where the brain lives,
   turns Reach off, and offers **Remove BrainAI from this Mac**: the tools on this Mac are disconnected from it, BrainAI
   stops and no longer starts at login, and the data folder stays. **Not moved after all** undoes step 3.

## Where things are

| | |
|---|---|
| Your memories | `~/Library/Application Support/io.github.jsr1292.brainai/data/memory.db` |
| Daily backups (the newest 14) | `…/io.github.jsr1292.brainai/backups/` |
| The server's log | `…/io.github.jsr1292.brainai/logs/server.log` |
| Its port | `…/io.github.jsr1292.brainai/brainai.json` (3100 unless something else had it) |

Updating or reinstalling the app never touches that folder. To remove BrainAI completely, quit it, delete
`BrainAI.app`, that folder and `~/Library/LaunchAgents/BrainAI.plist`.

Apps connect to `http://localhost:<port>/mcp` (Settings › Set up an app shows the exact address and steps). If the
port ever has to change because another program took it, the app says so and the apps need connecting again.

## On Windows

The same app, with the tray icon (by the clock) instead of the menu bar. What differs:

- **Installing:** run `BrainAI_<version>_x64-setup.exe`. It installs for you alone, with no admin rights, in
  `%LOCALAPPDATA%\BrainAI`. Windows may warn about an unknown publisher (the app is not signed yet); **More info › Run
  anyway**. Or, from PowerShell, the script checks the installer's checksum and runs it without that warning:
  `powershell -ExecutionPolicy Bypass -File install-app.ps1 -Installer .\BrainAI_<version>_x64-setup.exe` (with
  `SHA256SUMS` next to it). Once a release carries the Windows installer, one line will do:
  `irm https://github.com/jsr1292/brainai/releases/latest/download/install-app.ps1 | iex`.
- **Where things are:** your memories, backups and log are in `%LOCALAPPDATA%\io.github.jsr1292.brainai\` (`data\`,
  `backups\`, `logs\server.log`). Updates and reinstalls keep that folder.
- **Connect** finds Claude Code, Codex, OpenCode and Cursor as on the Mac (including npm's `claude.cmd` and the like).
- **Reach from phone and web** is Mac-only for now: on Windows, use BrainAI from the apps on this computer, or move it to
  a server.
- **Removing it:** quit BrainAI from the tray, then Settings › Apps › BrainAI › Uninstall. The data folder stays unless you
  tick "Delete the application data"; start at login is removed with the app.

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

On an Apple-silicon Mac with Node 22, Rust (`rustup`) and the search model (`npm run model`):

```bash
desktop/scripts/stage-server.sh          # the server, its darwin-arm64 dependencies, the model, and Node 22
cd desktop && npm install && npx tauri build --bundles app
```

The app is in `desktop/src-tauri/target/release/bundle/macos/BrainAI.app` (about 550 MB, most of it the search models,
its runtime and Node). `cd desktop/src-tauri && cargo test` runs the shell's tests; the server's are `npm test` at the
top of the repo.

**The Windows app** is built on the same Mac, cross-compiled for x64 Windows. Once, install the tools (cargo-xwin
downloads Microsoft's Windows SDK and C runtime, which means accepting Microsoft's licence for them):

```bash
brew install nsis llvm lld
cargo install --locked cargo-xwin
rustup target add x86_64-pc-windows-msvc
```

Then `desktop/scripts/build-windows.sh` stages the server for Windows and writes
`dist-windows/BrainAI_<version>_x64-setup.exe` and its `SHA256SUMS`.

## A signed build for other Macs

Other people's Macs only open an app signed with a **Developer ID Application** certificate and notarised by Apple.
An "Apple Development" certificate is not enough. The signature shows the certificate holder's name to anyone who
checks the app.

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

**Checked so far:** with an ad-hoc signature (`APPLE_SIGNING_IDENTITY=-`) and the hardened runtime, the app starts and
the server, its database and the search model all load. **Not yet done:** a build with a Developer ID certificate and
Apple's notarisation, so the first real one may need adjusting.
