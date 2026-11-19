# BrainAI plugin for Claude Code (1.7.0)

One install gives Claude Code the connection to your own BrainAI server, the save reminders and the harvest skill.
It is generated from BrainAI's sources (`npm run build:plugins`); do not edit it by hand.

## Install

```
claude plugin marketplace add jsr1292/brainai
claude plugin install brainai@brainai-plugins
```

Claude Code then asks for **brainai_url**: your BrainAI address, the one ending in `/mcp` (for example
`https://memory.example.com/mcp`, or the address the desktop app shows under Tools on this computer). It is stored in
your own settings; the plugin contains no address. Change it later in `/config` or `/plugin`. Then run `/mcp`, pick
`brainai` > `brainai` and log in once (OAuth, in the browser).

## What it carries

- **MCP server `brainai`**: `${user_config.brainai_url}`, over HTTP with OAuth.
- **Hooks** (no network calls, Node built-ins only): SessionStart tells the session to load your profile and the project
  briefing; Stop and PreCompact remind it to save decisions and status after real work.
- **Skills**: `brainai-memory` (how to use the memory) and `harvest-session` (send a session's lasting facts to your
  Inbox for approval).

Before installing, remove any MCP server you added by hand (`claude mcp remove memory`, or `brainai` if the desktop
app's Connect added it), or you would have two connections to the same server. Use either this plugin or the desktop app's
Connect for Claude Code (or scripts/install-claude-code-hooks.sh), not both: the reminders would fire twice. With the
plugin installed, the desktop Connect for Claude Code adds nothing of its own. Source and docs: https://github.com/jsr1292/brainai
