# How the brain is built

One Node process (TypeScript, Express 5) with one SQLite database (better-sqlite3), in one Docker container behind a
Cloudflare Tunnel. Everything the dashboard shows is rendered on the server; the browser runs only small scripts.

## The pieces

| Folder | What it does |
|---|---|
| `src/index.ts`, `src/cli.ts` | Start the server; the owner's command line (password, authenticator, clients, redirects, export). |
| `src/config.ts` | Every setting, read from the environment (`.env.example` lists them). |
| `src/db.ts` | Opens the database and runs the numbered migrations, after copying the file to `data/pre-migrate/`. |
| `src/auth/` | OAuth for apps (registration, consent, tokens), the owner's password and authenticator, sessions, the login rate limit. |
| `src/mcp/` | The MCP server: the tools each app sees and the instructions it gets, by access level. |
| `src/memory/` | Facts: save, recall (keyword and embedding search), duplicates, supersession, secrets refusal, briefings and roadmaps. |
| `src/pages/` | Pages: Markdown documents with sections, history, freshness checks and the Markdown export. |
| `src/projects/` | Projects, their aliases, and where each one lives (folders reported by your computers). |
| `src/review/`, `src/growth/` | The weekly review and the profile suggestions that wait for approval. |
| `src/discussions/` | Discussions: one question, several assistants, answered in rounds. |
| `src/skills/` | Shared skills, their versions and proposals, and keeping them in step with a computer. |
| `src/images/` | Pictures in pages: checked byte by byte, cleaned of metadata, served from `data/images`. |
| `src/folders/` | Device tokens and the reports a computer sends about its project folders. |
| `src/setup/` | The setup text for each app, with the owner's overlay lines added. |
| `src/web/` | The dashboard: routes, views and the static files. |
| `scripts/` | Host-side jobs: nightly backup, git copy, Markdown export, weekly off-site copy, the computer reporter. |

## Things worth knowing

- **Embeddings run in the app,** with a small multilingual model downloaded at build time, so recall works offline
  and no text leaves the server.
- **Migrations only go forward.** Each is numbered and runs once; the database is copied first, and the newest three
  copies are kept.
- **The overlay** (`overlay/`) is the one place for the owner's own texts and script settings; code never writes to it.
- **Tests** use Node's test runner (`npm test`), one process per file, with an in-memory database and a fake
  embedder unless a test says otherwise.
