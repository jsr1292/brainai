# Connecting your AI apps to the shared memory

Replace `<domain>` with your domain everywhere below. Server setup is in `docs/RUNBOOK.md`; do that first.

The shared memory sits next to each app's built-in memory; it does not replace it. Built-in memories stay per app. The shared memory is the one place all your assistants read from and write to, and the source of truth for anything that matters across them.

## 1. The custom instruction (same text for every app)
Paste this exactly:

```
I have a shared memory (MCP connector "memory") used by all my AI assistants. At the start of each conversation, load my profile from it. Before answering anything about past work, my projects or my setup, recall from it. Save decisions, conclusions and lasting facts about me there as we go, and save or update a short status whenever a step of the work finishes; don't wait for the end of the conversation. If the memory connector is missing, needs a login, or a call fails, tell me right away. It is the source of truth for anything that matters across assistants.
```

The server also sends its own instructions. The memory tools are `load_profile`, `recall`, `project_brief`, `remember`, `update_memory`, `forget` and `list_projects`. The discussion tools are `open_discussion`, `list_discussions`, `read_discussion`, `reply_to_discussion` and `close_discussion` (see section 5).

When you approve a sign-in, the consent page asks you to name the connection (for example "Grok Build") and to choose its access level (section 6). The name is what shows on discussion posts, new memories and Settings › Connections. You can rename a connection later in Settings › Connections.

## 2. Claude Code
1. `claude mcp add --transport http --scope user brainai https://memory.<domain>/mcp`
   (An install that already uses the name `memory` keeps working; only new installs use `brainai`.)
2. In Claude Code run `/mcp`, pick `brainai`, and log in. The browser shows the consent page: check the client name and redirect site, then approve (you sign in with your password and authenticator code).
3. Add the snippet above to `~/.claude/CLAUDE.md`.

### Hooks (load and save without relying on the assistant to remember)

Hooks make a tool use the memory on its own. On the desktop app, **Settings › Tools on this computer › Connect** installs them for every tool below that has them, and Disconnect (or Remove BrainAI) takes them back; a tool connected earlier shows **Add save reminders**. On a server, `./scripts/install-claude-code-hooks.sh` builds the scripts and copies them (`~/.claude/hooks` and `~/.brainai/hooks`), and you wire them into the tools' hook files as shown below. Either way the tool's own hook file is read first and never rewritten when it is not plain JSON, it is backed up beside itself (`.brainai-backup`) before the first change, and only entries that name BrainAI's own scripts are ever added or removed.

All reminders say the same short thing: *if decisions were made or the status changed and are not saved yet, save them with `remember` (update the project's status rather than adding one), or run the `harvest-session` skill to suggest them for the owner's approval; if nothing lasting happened, carry on.* They fire once per stretch of work (12 changes since the last save), never twice in a row, and any error lets the tool carry on.

What each tool offers (checked 2026-11-18 against the official documentation) and what BrainAI installs:

| Tool | Events that can put a message in front of the model | Installed |
| --- | --- | --- |
| Claude Code | **SessionStart** (`additionalContext`), **Stop** (`decision: "block"` + `reason` continues the turn), **PreCompact** (plain stdout becomes instructions for the compaction summary; it can also block compaction). **SessionEnd** cannot: no decision control, JSON output is discarded, 1.5 s budget. | SessionStart: load profile and briefing. Stop: the reminder. PreCompact: the reminder, phrased as a to-do in the summary, only after at least 3 unsaved changes. No SessionEnd hook. The commands run plain `node` (an absolute path only when `node` is not on the PATH); on Windows Cursor runs hook commands through PowerShell (a quoted absolute interpreter needs `& `), Codex's docs do not say which shell. Scripts `memory-start.mjs`, `memory-save.mjs` in `~/.claude/hooks`, wired in `~/.claude/settings.json`. |
| Codex CLI | **Stop** (`decision: "block"` starts a new continuation prompt from `reason`), SessionStart / UserPromptSubmit / PreToolUse / PostToolUse (`additionalContext`). **PreCompact** only stops compaction (no message to the model); **SessionEnd** is advisory (1 s, cannot keep the thread open). | Stop (the reminder) and PostToolUse (counts work; prints nothing) in `~/.codex/hooks.json`, script `~/.brainai/hooks/memory-nudge.mjs codex`. Codex asks you to trust new hooks once: type `/hooks`. |
| Cursor | **stop** (`followup_message` is auto-submitted as the next user message; default cap 5 follow-ups), sessionStart / postToolUse (`additional_context`). **preCompact** only returns `user_message` (shown to the user, not the model); **sessionEnd** is fire-and-forget. | stop (the reminder) and postToolUse (counts work) in `~/.cursor/hooks.json` (`"version": 1`, flat entries), script `~/.brainai/hooks/memory-nudge.mjs cursor`. |
| OpenCode | Plugins (not hook files): subscribe to events with `ctx.event.subscribe` (the event list includes `session.idle`, `session.deleted` and `session.compaction.*`) and send into a session with `ctx.session.prompt` / `ctx.session.synthetic`; a `compaction` session hook replaces the summary. | **Nothing yet.** The plugin API was reworked and its docs do not show a stable `session.idle` payload or a plugin that can be dropped in and loaded from `~/.config/opencode/plugins/`; shipping code that could not be run against it would risk breaking OpenCode at start. OpenCode relies on its rules and the `harvest-session` skill. |
| Grok Build | Hook files `~/.grok/hooks/*.json` (and it also reads `.claude/settings.json` and `.cursor/hooks.json` of a project). Events: SessionStart, SessionEnd, UserPromptSubmit, PreToolUse, PostToolUse, Stop, PreCompact, PostCompact and more, **but only PreToolUse can block, and the docs name no event that adds text to the model's context**; stdout of the others is ignored. | **Nothing**: there is no documented way to put a message in front of the agent. Grok relies on its rules and the skill. |
| Gemini CLI | Hook files in `settings.json` (`hooks`): **BeforeAgent** and **SessionStart** can return `hookSpecificOutput.additionalContext`, **AfterAgent** can force a retry. Checked 2026-11-19 in <https://github.com/google-gemini/gemini-cli/blob/main/docs/hooks/reference.md>. | **Nothing yet.** Gemini CLI setup is itself untested, and its hooks need strict JSON on stdout, which BrainAI's scripts do not write for it. Left out until someone with a real Gemini CLI can try it; Gemini relies on its rules (`GEMINI.md`) and the skill. |
| Claude (desktop app, web, mobile) | No hooks. | Nothing: relies on the server instructions and the skill. |

Documentation used: Claude Code <https://code.claude.com/docs/en/hooks> (PreCompact and SessionEnd sections; checked 2026-11-18: "On these events, your plain-text stdout reaches Claude or the compaction summary: PreCompact: your stdout becomes instructions for the compaction summary", so the PreCompact reminder does reach the model that writes the summary, not only the transcript view); Codex <https://developers.openai.com/codex/hooks> (now served from <https://learn.chatgpt.com/docs/hooks>; schemas in <https://github.com/openai/codex/tree/main/codex-rs/hooks/schema/generated>); Cursor <https://cursor.com/docs/hooks>; OpenCode <https://opencode.ai/docs/plugins/>, <https://opencode.ai/docs/build/plugins/server> and the event list at <https://opencode.ai/docs/server/>; Grok Build <https://docs.x.ai/build/features/hooks>.

By hand (server users), the wiring is, for Claude Code in `~/.claude/settings.json`:

```json
{ "hooks": {
  "SessionStart": [{ "hooks": [{ "type": "command", "command": "node /Users/you/.claude/hooks/memory-start.mjs" }] }],
  "Stop":         [{ "hooks": [{ "type": "command", "command": "node /Users/you/.claude/hooks/memory-save.mjs" }] }],
  "PreCompact":   [{ "hooks": [{ "type": "command", "command": "node /Users/you/.claude/hooks/memory-save.mjs" }] }]
} }
```

for Codex in `~/.codex/hooks.json` the same shape with `Stop` and `PostToolUse` running `node /Users/you/.brainai/hooks/memory-nudge.mjs codex`, and for Cursor in `~/.cursor/hooks.json`: `{ "version": 1, "hooks": { "stop": [{ "command": "node /Users/you/.brainai/hooks/memory-nudge.mjs cursor" }], "postToolUse": [{ "command": "node /Users/you/.brainai/hooks/memory-nudge.mjs cursor" }] } }`.

The two Claude Code scripts, in short: **SessionStart** (`memory-start.mjs`, on startup, `/clear` and after compaction) tells the session to call `load_profile` and `project_brief` for the folder it was opened in (the git repository's folder name, so `~/Projects/wildlog` → `wildlog`); **Stop** (`memory-save.mjs`) counts edits, writes and shell commands since the last `remember`, `update_memory` or `suggest_memories`.

### Install as a plugin

Instead of the three steps above plus the hooks, Claude Code can take everything from one plugin published in BrainAI's own public repository (no third-party marketplace). The plugin carries the MCP entry, the instruction text (as the `brainai-memory` skill), the save reminders (SessionStart, Stop, PreCompact) and the `harvest-session` skill.

```
claude plugin marketplace add jsr1292/brainai
claude plugin install brainai@brainai-plugins
```

Claude Code then asks for **brainai_url**, your own address ending in `/mcp` (`https://memory.<domain>/mcp`, or the one the desktop app shows). It is stored in your settings (`claude plugin install brainai@brainai-plugins --config brainai_url=https://memory.<domain>/mcp` sets it without the prompt; change it later with `/plugin configure brainai@brainai-plugins`), and the plugin itself holds no address: its `.mcp.json` says `"url": "${user_config.brainai_url}"`. Before installing, remove any MCP server you added by hand (`claude mcp remove memory`, or `claude mcp remove brainai` if the desktop app's Connect added it), or you would have two connections to the same server. Then run `/mcp`, pick the `brainai` server that comes from the brainai plugin and log in as in step 2. Use the plugin or the desktop Connect for Claude Code, not both, or each reminder fires twice; with the plugin installed, the desktop Connect for Claude Code detects it (`~/.claude/plugins/installed_plugins.json` lists `brainai@brainai-plugins`) and adds nothing of its own. Add the custom instruction to `~/.claude/CLAUDE.md` only if you want it in every session regardless of the skill.

The plugin is generated, never edited: `npm run build:plugins` writes `plugins/claude-code/brainai/` and `.claude-plugin/marketplace.json` from `src/hooks`, `src/skills/builtin` and `src/setup/texts.ts`, and `src/plugins/plugins.test.ts` fails when the committed copy has drifted, a version differs from `package.json`, or an owner-specific string slipped in. The release gate publishes `plugins/` with the rest of the tracked files. Check a build with `claude plugin validate plugins/claude-code/brainai` and `claude plugin validate .`.

Plugin formats checked 2026-11-18, and why only Claude Code gets one:

| Tool | Format found | Plugin built? |
| --- | --- | --- |
| Claude Code | Stable and fully documented: `.claude-plugin/plugin.json` (`userConfig`, `${user_config.KEY}` in MCP `url`, `${CLAUDE_PLUGIN_ROOT}`), `.mcp.json`, `hooks/hooks.json` (exec form), `skills/<name>/SKILL.md`, and a `.claude-plugin/marketplace.json` that `claude plugin marketplace add <owner>/<repo>` reads from any GitHub repository. <https://code.claude.com/docs/en/plugins-reference>, <https://code.claude.com/docs/en/plugin-marketplaces>, <https://code.claude.com/docs/en/hooks>, <https://code.claude.com/docs/en/mcp> | **Yes**, `plugins/claude-code/brainai`. |
| Codex CLI | Documented: root `plugin.json` (or `.codex-plugin/plugin.json`), `skills/`, `mcp.json`, `hooks/hooks.json`, marketplace at `.agents/plugins/marketplace.json`; the CLI only manages marketplaces (`codex plugin marketplace add owner/repo`) and installs through `/plugins`. <https://developers.openai.com/codex/plugins/build> (served from <https://learn.chatgpt.com/docs/plugins>) | **No.** The docs give a plugin no way to ask the user for their own address, so the MCP entry would have to hold a fixed URL; plugin hooks are documented only for plugins installed by hand in the desktop app, and need a separate trust step. Use the manual route in section 2's tool steps and Connect's hooks. |
| Cursor | Documented: `.cursor-plugin/plugin.json`, `mcp.json`, `hooks/hooks.json`, `.cursor-plugin/marketplace.json`. <https://cursor.com/docs/plugins>, <https://cursor.com/docs/reference/plugins> | **No.** Plugin variables (`variables` in the manifest) are filled in by an admin in the Cursor dashboard, and installing from a repository goes through a Team marketplace or Cursor's public one; the docs give a single owner no way to set their own address or install from their own repository. Use the manual route and Connect's hooks. |
| OpenCode | Plugins are JavaScript/TypeScript packages listed under `plugin` in `opencode.json` (`opencode plugin add`); the docs mention tools, hooks, commands and agents, not MCP servers or skills. <https://opencode.ai/docs/plugins/> | **No.** A plugin cannot carry the MCP entry or the skill, and its event API has no documented stable save-reminder hook (see the hooks table above). Use the manual route. |
| Grok Build, Claude (desktop, web, mobile), ChatGPT | No plugin format that bundles an MCP server with hooks or skills. | **No.** Manual route. |

### Harvest: `suggest_memories` and the `harvest-session` skill

Hooks only nudge; the assistant still has to go over its session. `suggest_memories` takes up to 20 items (`content`, `kind` decision, summary or profile, `project`, optional `keys`, `valid_until`, `source`, `source_note`) and one `session` label. Nothing is saved: each item becomes a held suggestion marked as harvested, goes through the same checks as a held `remember` (secrets refused, instruction-like text flagged, a close existing memory or a fact you deleted attached as a warning), and waits in the Inbox as the group **Harvested from <app> · <label> · N** under Approvals, with Approve all / Reject all and each item's own buttons. They count in the needs-you badge. Harvested suggestions have their own room (60 waiting), apart from the 20 plain held saves.

The `harvest-session` skill (text in `src/skills/builtin/harvest-session.md`) tells the tool's own model how to do it. It reaches you once, on first start, as a skill proposal from "BrainAI" in the Inbox; only you add it (a skill with that name that already exists is never proposed over).

## 3. Claude (web, desktop, mobile)
1. Customize → Connectors → Add custom connector.
2. URL: `https://memory.<domain>/mcp`
3. Authentication: **Sign in now**.
4. OAuth client: **Use Claude's published identity**. If that fails, use **Register automatically**.
5. Check the consent page, then approve.
6. Add the snippet above to Settings → Profile → personal preferences.

Claude's web callbacks (`claude.ai` and `claude.com`) and local loopback addresses are allowed from the start, so no setup is needed for them.

## 4. Grok and ChatGPT
Their redirect addresses are not allowed by default. The easy way: open Settings › Set up an app › Grok (or ChatGPT) and press **Allow Grok to sign in** before connecting. If the app still fails, the address it tried is listed on that page under **Refused lately**, with an Allow button. The rest of this section is the same thing from a terminal.
1. Grok: grok.com/connectors → New Connector → Custom, URL `https://memory.<domain>/mcp`. ChatGPT: Developer Mode (only if your plan allows it), add a connector with the same URL.
2. The connection fails with: `Redirect URI … is not on this server's allowlist`. The error itself contains the exact command to run. Some apps (Grok) show only `invalid_client_metadata`; the full reason and command are then in `docker compose logs --tail 100 app` (look for `Client registration rejected`).
   Grok's address, verified 2026-10-18: `https://grok.com/connectors-oauth-exchange-code/`.
3. On your server, in `~/memory`, run the command from the error, in this form:
   ```bash
   docker compose exec app node dist/cli.js redirects add <entry>
   ```
4. Retry the connection, check the consent page, approve, and add the snippet to the app's custom instructions.

Check what is allowed any time: `docker compose exec app node dist/cli.js redirects list`.

Codex (CLI, IDE extension, app) identifies itself with a document on chatgpt.com and signs in through a loopback address, which is always allowed. The server only reads such documents from sites on the allowlist, so a server where ChatGPT was never connected answers `Invalid client_id` until chatgpt.com is on it: press **Allow Codex to sign in** on Settings › Set up an app › Codex, or run `redirects add https://chatgpt.com/oauth/codex/`. Either chatgpt.com entry (Codex's or ChatGPT's) lets the server read client documents from all of chatgpt.com, so allowing one covers both apps. ChatGPT's address (`https://chatgpt.com/connector_platform_oauth_redirect`) was last checked on a live connection in October 2026; if ChatGPT now uses another one, it shows under **Refused lately**. `codex mcp add <name> --url …/mcp` signs in by itself. Codex asks before every tool call unless the server's section in `~/.codex/config.toml` has `default_tools_approval_mode = "approve"` (verified with Codex 0.156.1, 2026-10-20).

## 4b. Gemini CLI (not tested yet)
BrainAI's Gemini CLI setup follows Google's documentation (<https://github.com/google-gemini/gemini-cli/blob/main/docs/tools/mcp-server.md>, <https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/gemini-md.md>) but has not been tried against a real Gemini CLI. On the desktop app, **Settings › Tools on this computer › Connect** does the steps below when it finds `gemini` on your PATH; Disconnect (or Remove BrainAI) takes out only the `brainai` entry and BrainAI's rules.
1. In `~/.gemini/settings.json` add (keep your other keys and servers; a remote Streamable HTTP server uses `httpUrl`, `url` is for SSE):
   ```json
   { "mcpServers": { "brainai": { "httpUrl": "https://memory.<domain>/mcp" } } }
   ```
   Or, in a terminal: `gemini mcp add --transport http --scope user brainai https://memory.<domain>/mcp`.
2. In Gemini CLI type `/mcp auth brainai`; your browser shows the consent page: approve it.
3. Add the snippet from section 1 (or the text from Settings › Set up an app › Gemini CLI) to `~/.gemini/GEMINI.md`, Gemini CLI's global context file.

BrainAI does not set up save reminders (hooks) for Gemini CLI: see the table under Hooks.

## 5. Discussions
A discussion is a question that several of your assistants answer, in rounds, until you decide. Use it when you are stuck on a direction, want ideas, or want one assistant to check what another built. Discussions are not memory: nothing from them reaches recall, your profile or project briefings, except the one decision you save at the end.

1. **Open one from any assistant.** Say, for example, "open a discussion about how wildlog should handle a small cellar". The assistant writes the question and the context the others need. Assistants on the Mac (Claude Code, Grok Build, OpenCode) can attach files from the project; the web assistants can't see your code, so open code discussions from the Mac.
2. **Round 1 is blind.** Ask each assistant to "read the wildlog discussion and give your view". An assistant can't see the other replies until it has posted its own, so it doesn't just agree with whoever went first. Each assistant and model replies once per round.
3. **Ask the others from the dashboard.** Discussions on Projects shows who you still need to ask. On a discussion's page, each assistant that hasn't replied has an "Ask in..." button (for the web apps), which opens a new chat with the request already typed, and a Copy button (for the Mac assistants) to paste the request yourself. If an app doesn't accept a typed request, the button copies it instead.
4. **Your notes and next rounds.** Round 2 starts when everyone you asked has replied, or sooner if you click "Start round 2 now". From then on everyone sees everything and is told to say where the others are wrong, not to summarise them. Add a note ("keep it cheap") on the discussion page and every assistant sees it. Click "Start next round" for more rounds.
5. **Decide.** Write the decision on the dashboard (choose a project if the discussion has none), or tell any assistant "close the wildlog discussion: we'll rank by drinking window". This saves one decision memory, so every assistant knows it. The discussion stays on the dashboard, read-only. Assistants close a discussion only when you tell them to.

The server never contacts an assistant; you drive every round. Openers are told to leave your personal details out of the question. A discussion also has an "Include discussions-only assistants" switch (on by default). Turn it off if the topic is private: connections with Discussions only access then can't see or answer it. Turning it off later hides it from then on but can't unsend what was already read.

## 6. Access levels
Each connection has one of three levels:
- **Full:** the memory tools and the discussion tools. This is the default.
- **Discussions only:** only the discussion tools: open, list, read and reply. It can't load your profile, recall, or save or see any memory, and it can't close a discussion (the decision becomes a memory, so you record it on the dashboard).
- **Read only, chosen projects:** search, project briefings, list projects, recent work and what's left, limited to the projects you tick. It can't see your profile or any other project, can't save, change or delete anything, and takes no part in discussions. It reads exactly the ticked names: if a ticked project is later renamed or merged into another one, the connection reads nothing of it (merging must not open up the other project), and Settings › Connections asks you to tick the new name. When an app is already connected with Full access, or at different levels, its next consent page preselects nothing, so a second account of it (a work ChatGPT next to the personal one) never gets Full by a quick click: you choose each time. An app connected only as Discussions only or Read only gets that level preselected again (the projects still need ticking).

You choose the level on the consent page when you approve a sign-in, and you can change it (and the ticked projects) any time in Settings › Connections (it applies to that connection's next request). Choose Discussions only for assistants whose model provider you don't want to see your profile and memories, for example OpenCode running GLM or MiniMax. They can still join discussions. Choose Read only for an assistant that should know some projects but nothing else about you, for example a work ChatGPT reading the work projects: whatever it reads ends up in that account's chat history.

A new ChatGPT connector gets its own redirect address: if its sign-in fails with `Invalid client_id` or a redirect error, add the address from the error page with `redirects add <address>`.

## 7. Good to know
- **Reused refresh token = disconnect.** If an app reuses an old refresh token more than 15 seconds after it was swapped for a new one (for example after a network failure in the middle of a refresh), the server treats it as possible theft and disconnects that app. This is deliberate. Reuse within those 15 seconds is allowed, because several Claude Code terminals share one login and may refresh at the same moment. To reconnect, open the app's connector settings and connect / sign in again. The same applies after you revoke an app in Settings › Connections.
- **Dashboard on your phone:** open `https://memory.<domain>` and choose "Add to Home Screen" (iPhone: Safari share sheet; Android: Chrome menu → "Install app").
- **Dashboard logins last 30 days.** You can log them out remotely from Settings › Your login.
- **Cutting an app off:** `docker compose exec app node dist/cli.js clients list`, then `clients revoke <grantId>`.

## 8. Go-live checks
Seed one profile fact on the dashboard first (for example, what your home server runs). Then:
1. In a brand-new Claude Code session, ask "what's my home server running?". It answers correctly without explanation.
2. Have Claude Code save a decision. Then ask Claude on the web, "based on what we've worked on, what did we decide about auth for the memory server?". It answers correctly.
3. `https://memory.<domain>` without logging in shows only the login page, and `curl -s -o /dev/null -w '%{http_code}' -X POST https://memory.<domain>/mcp` prints `401`.
4. On your server, `docker compose exec app node dist/cli.js clients list` succeeds (it proves the x86_64 image's native modules load).
5. When you type your password at `set-password`, no characters show.
