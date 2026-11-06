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
1. `claude mcp add --transport http --scope user memory https://memory.<domain>/mcp`
2. In Claude Code run `/mcp`, pick `memory`, and log in. The browser shows the consent page: check the client name and redirect site, then approve (you sign in with your password and authenticator code).
3. Add the snippet above to `~/.claude/CLAUDE.md`.

### Hooks (load and save without relying on the assistant to remember)

Two hooks make Claude Code use the memory on its own. Install or update them with `./scripts/install-claude-code-hooks.sh`, which copies them to `~/.claude/hooks`. They are wired up in `~/.claude/settings.json` under `"hooks"`:

- **SessionStart** (`memory-start.mjs`, on startup, `/clear` and after compaction) tells the session to call `load_profile` and `project_brief` for the folder it was opened in (the git repository's folder name, so `~/Projects/wildlog` → `wildlog`). If the name doesn't match a project, `project_brief` suggests the closest ones.
- **Stop** (`memory-save.mjs`) counts edits, writes and shell commands since the last `remember` or `update_memory`. After 12, it stops Claude once and asks it to save or update the project's status, or to carry on if nothing lasting happened. It never blocks twice for the same stretch of work, and any error lets Claude stop normally.

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
