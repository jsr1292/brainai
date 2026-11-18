# Importing existing knowledge into the shared memory

The dashboard's **Import** page (Settings › Backups and copies › Import, the Home first steps, or Ctrl K › Import) guides the owner through each source. Everything runs on the owner's own hardware: the server never fetches anything, and no AI model reads the text on the server. Nothing is saved without the owner's choice, and secrets are never imported.

## 1. Built-in memory of ChatGPT, Claude and Gemini

The owner gets the memory out as text, pastes it into the Import page and ticks the lines to keep.

The prompt that works in any of the three:

> List everything you remember about me, one item per line. Include saved memories and what you have picked up about my preferences, work and projects. Plain text only, no commentary.

| Assistant | Where the memory is | Help page (checked 2026-11-18) |
| --- | --- | --- |
| ChatGPT | Settings › Personalization › Memory › Manage (or Manage memories); copy the list, or use the prompt | https://help.openai.com/en/articles/8590148-memory-faq |
| Claude | Settings › Your Claude (older layout: Settings › Memory or Capabilities) › Manage next to Your memory; or ask for a verbatim copy with the prompt | https://support.claude.com/en/articles/12123587-import-and-export-your-memory-from-claude and https://support.claude.com/en/articles/11817273-use-claude-s-chat-search-and-memory-to-build-on-previous-conversations |
| Gemini | Settings & help › Personal context (older layout: Saved info); personal Google accounts only | https://support.google.com/gemini/answer/16413516 |

Menu names change between releases; the page repeats this and the prompt is the fallback. The text for each vendor lives in `src/import/vendors.ts`.

What the server does with a paste (`src/import/lines.ts`): strips bullets, numbering, `#` marks and bracketed dates; drops empty lines, lines under 12 characters, short headings ending in a colon, and repeats; refuses any line the secret check flags (and says how many); reads at most 200 lines. The review list shows each line with a tick box, an editable kind (decision or profile), a project (existing or new) and a warning when an existing fact of the same kind is a near match (`MemoryService.duplicatesOf`, the same cut-off as duplicate detection). While the app is on keyword search only, the page says duplicates cannot be checked.

Saving: one import saves up to 100 ticked rows. Decision rows go through `remember` with source `imported`, source_by `owner` and the note "Imported from ChatGPT memory, <date>". Profile rows are saved as owner-made profile facts: the owner ticking them is the approval. A ticked row that matches an existing fact is skipped and counted ("Saved 37 facts. 4 duplicates skipped.").

## 2. Project folders (a connected coding assistant)

The built-in skill **import-project-folders** (`src/skills/builtin/import-project-folders.md`) is offered once to the owner as a proposal from BrainAI in the Inbox, like harvest-session. The owner adds it, then tells the assistant to run it. The assistant:

1. Asks which folders to read and starts with one small project. Skips `node_modules`, `.git`, build output, `.env` and key files.
2. Reads `CLAUDE.md`, `AGENTS.md`, `README.md`, `docs/` and memory or notes files.
3. Calls `list_projects` and `project_brief` to reuse project names and avoid what is saved.
4. Drafts one short, self-contained fact per item: `decision` for decisions and lasting project facts, `summary` for one status per project, `profile` rarely. Source `from_file`. Never secrets.
5. Sends at most 20 items per call with `suggest_memories`, so everything waits in the Inbox for the owner's approval (profile changes included).

## 3. Past sessions

The **harvest-session** skill goes over one finished session and sends its decisions to the Inbox (see Skills).

## 4. Add a file as a page

One `.md` or `.txt` file at a time, up to 1 MB. Binary content, other types and text the secret check flags are refused; PDF is not supported yet. The title is the first heading or the file name and can be edited, the project or area is chosen, and a preview is shown before the page is created through the normal page service (sections indexed like any page). The page records its file name and date (table `page_file_imports`, migration 42) and the page view says "Imported from <file> on <date>, not written by an assistant." The upload is read in memory; no temp file is written.

## Checking the result
- Try the paste on a few lines first.
- Open the dashboard: check Facts › Tidy up for duplicates and projects saved under two names.
