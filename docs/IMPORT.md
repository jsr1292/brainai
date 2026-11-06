# Importing existing knowledge into the shared memory

Procedure for Claude Code (connected to the memory, see `docs/CLIENTS.md`) to follow together with the owner. Nothing is saved without the owner's approval, and secrets are never imported.

1. **Read.** For each folder in `~/Projects`, read `CLAUDE.md`, `README.md`, `docs/` and any memory files. Skip `node_modules`, `.git` and build output.
2. **Draft candidates** as a table with the columns `kind`, `project`, `content`. One fact per row, in the language it was written in, each a short self-contained statement (1 to 1000 characters). Follow the rule of thumb in the server instructions: save lasting facts, decisions and conclusions; skip small talk, one-off details, and things already written in the project's own files. **Never include secrets** (passwords, API keys, tokens, tunnel tokens). Check `list_projects` to reuse existing project names.
3. **Show the table to the owner.** Only approved rows are saved:
   - `profile` rows are saved as **suggestions** (AIs cannot change the live profile). The owner then approves them on the dashboard.
   - `decision` and `summary` rows are saved directly with `remember`.
4. **Built-in memories.** The owner exports ChatGPT memory (Settings → Personalization → Memory) and Claude memory, and pastes them in. Repeat steps 2 and 3 on that text.

## Checking the result
- Run it first on one small project folder, and check the profile and facts it proposes before doing the rest.
- Open the dashboard: approve the pending suggestions, then check Facts › Tidy up for duplicates and projects saved under two names. If `remember` reports similar memories, update one with `update_memory` instead of adding another.
