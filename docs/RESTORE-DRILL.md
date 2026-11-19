# Restore drill

A backup you have never restored is a hope. This drill restores every kind of saved copy onto a clean machine and
checks that the brain is whole. It is scripted, so anyone can run it again.

## What it does

1. It builds a **source brain** in a temp folder. It never touches real data, and `HOME` points at a temp folder too.
   The brain is filled through the real services and the real sign-in flow:
   - facts of several kinds, with `valid_until`, a source and a source note (set by the owner and by assistants), keys and tags;
   - a decision replaced by a newer one (a supersedes link), two facts flagged as disagreeing, and a project alias;
   - a fact edited twice (history rows);
   - a fact the owner forgot, and a change an assistant made that waits for approval (a held item);
   - pages with several sections and three versions, a link between pages, a note, two pictures, and a deleted page;
   - a discussion with a file;
   - a shared skill with two versions and a file, and a skill an assistant proposed;
   - an app registration with a grant and live access and refresh tokens, a registration that never got a grant, and the owner sign-in set (password, authenticator secret, sessions, devices, a client secret).
2. It records a **fingerprint**: row counts and row hashes for every table that holds memories, the sha256 of every
   picture file (every table below must hold rows, so "identical" is never two empty tables agreeing), and the top 3 results for 10 fixed fact questions and 3 fixed page questions.
3. For each restore path it makes the copy, restores it onto a **new empty machine** (new data folder, new `HOME`,
   nothing shared with the source), starts the real app on it, and compares with the fingerprint.

## How to run it

```bash
npm run drill:restore                       # fake search model, writes bench-results/restore-drill-<date>-fake.json
MODEL_DIR=./models npm run drill:restore -- --real-model   # the real default search model (EMBED_MODEL=e5 for the other)
npm run drill:restore -- --out some-folder --no-offsite --keep
```

It takes about 5 seconds. The exit code is 1 if any check fails. `bench-results/` is ignored by git.
`src/scripts/restoreDrill.test.ts` runs the same drill in CI (fake model, no `age`).

## The restore paths

| Path | Copy made by | Restored with |
|---|---|---|
| a1 nightly snapshot | the real `scripts/backup.sh` (snapshot plus images copy folder) | RUNBOOK section 3: `cp`, `PRAGMA integrity_check`, `rsync` of the pictures, the picture check |
| a2 in-app snapshot | `backupNow` (`BACKUP_DIR`) | the same steps |
| b1 saved copy | Save a copy of everything (`brainai-saved-<date>.tar.gz`) | the real `cli restore` command in its own process; a second restore must refuse |
| b2 saved copy, in the app | the same file | `stageRestore`, then the start-up swap (`applyPendingRestore`) |
| c off-site pack | the real `scripts/offsite.sh` (age encryption, a stand-in `rclone` that writes to a folder) | decrypt with the key, unpack, copy in, and RUNBOOK's `age -d` loop for the pictures |
| d1 failed migration | a migration that really throws half-way | nothing to restore: the drill checks the database is left untouched and a copy exists |
| d2 failed upgrade | the copy in `data/pre-migrate/` | RUNBOOK section 3 with that copy |

## Results of the runs on 2026-11-19

Run once with each real local search model, schema 43, Node 26. The default model (EmbeddingGemma) and the older
multilingual-e5-small each pass all 192 checks: 192 PASS, 0 FAIL, 0 SKIPPED (source 4, a1 30, a2 30, b1 31, b2 30,
c 32, d1 6, d2 29). The same run with the fake model passes the same checks.

```bash
EMBED_MODEL=gemma MODEL_DIR=./models npm run drill:restore -- --real-model   # the default model
EMBED_MODEL=e5 MODEL_DIR=./models npm run drill:restore -- --real-model
```

The report now records which model it ran with (`embedder` in the JSON, and the file name). The first published run,
on 2026-11-18, said it used e5, but its report did not record the model; these two runs replace it.

| Check | a1 | a2 | b1 | b2 | c | d2 |
|---|---|---|---|---|---|---|
| Integrity check is ok | PASS | PASS | PASS | PASS | PASS | PASS |
| The app starts on the restored data | PASS | PASS | PASS | PASS | PASS | PASS |
| Facts identical, every field (15 rows, embeddings included) | PASS | PASS | PASS | PASS | PASS | PASS |
| History (3 rows), supersedes link (1), disagreement (1) identical | PASS | PASS | PASS | PASS | PASS | PASS |
| Held item still held | PASS | PASS | PASS | PASS | PASS | PASS |
| Pages, sections, 5 versions, page link, note identical | PASS | PASS | PASS | PASS | PASS | PASS |
| Both picture files present, same sha256 | PASS | PASS | PASS | PASS | PASS | PASS |
| Discussion with its file, alias, skills with versions and proposal identical | PASS | PASS | PASS | PASS | PASS | PASS |
| Recall: same top 3 for 10 questions; page search for 3 | PASS | PASS | PASS | PASS | PASS | PASS |
| Forgotten fact still deleted, not in recall, an assistant re-saving it is held | PASS | PASS | PASS | PASS | PASS | PASS |
| Old access token refused (401), old refresh token refused (400). Controls: both work on the source | PASS | PASS | PASS | PASS | PASS | not applicable |
| No sign-in data comes back; the source's password with a valid authenticator code does not sign in (503, setup needed). Controls: the source signs in with them | PASS | PASS | PASS | PASS | PASS | not applicable (d2 keeps the owner and signs in: PASS) |
| Client secret replaced; registrations and grants kept, compared by row hash (3 clients, 1 grant) | PASS | PASS | PASS | PASS | PASS | PASS |

Other checks that passed:

- b1: `cli restore` printed "Restored 14 facts and 2 pages". A second restore refused ("This brain already has memories") and left the file byte for byte the same.
- c: the pack held the database, `memory.md` and the Markdown page export; both pictures came back through the documented `age -d` loop.
- d1: the migration threw, the database stayed at the old schema version with all 15 fact rows, and `pre-migrate-42-to-43-….db` had been made first.
- d2: the pre-migrate copy was at the old schema, passed `integrity_check`, and a full copy keeps the sign-in data (owner 1, tokens 2), as it should.

Facts counted: 14 live, 15 rows (one is the forgotten one, kept so forgetting sticks).

### A bug the drill found, and its fix

The `data/pre-migrate/` copies were made with the default file mode (`644`). They are full copies of the database,
so they hold the password hash, the authenticator secret and the token hashes that a backup leaves out. Any other
user on the machine could read them. The fix (`src/db.ts`, tests in `src/db.test.ts`), all best effort (a share that
refuses `chmod` only logs a warning and never stops the brain from starting), and it only ever removes access:

- each pre-migrate copy is created `600` before SQLite writes into it;
- a new `pre-migrate/` folder is created `700`, and an existing one has group and other access taken off at every copy;
- copies an older version left behind are made `600` when the next copy is made;
- when the brain opens, `memory.db` and any `-wal` and `-shm` files are made `600`.

If another user (a backup job run as someone else) needs to read `data/memory.db`, give it the same owner instead of relying on group access.

## What a restore does not bring back (exceptions)

- **The sign-in.** A backup has no password, authenticator secret, sessions, known devices, folder-report tokens,
  upload links or OAuth tokens and codes. After a restore the owner sets the password and authenticator again
  (RUNBOOK step 6), and every app signs in again. The drill proves the old tokens and password are refused.
  The drill does not run `set-password` and `setup-totp` (they ask on the keyboard); it only checks that the sign-in is absent.
- **Client secrets** are replaced by random ones, so an app that had one registers again. Registrations and grants
  (the access levels) are kept. A grant with no tokens does nothing until the app signs in again.
- **Anything saved after the copy was made.**
- **Pre-migrate copies are the one full copy.** They keep the sign-in data. Treat them like the database itself.
- **Restoring a bare `memory-<date>.db` with `cli restore` brings no pictures**: it lists them as removed. To keep
  pictures, use RUNBOOK section 3 (copy the file in, then `rsync` the images), as paths a1 and a2 do. A saved copy
  (`.tar.gz`) carries its pictures. The drill does not test the bare-file `cli restore`.
- **Pictures deleted for good** more than 30 days ago leave the copy folders and the off-site folder, so they do not come back.
- **The Markdown export** (also inside the off-site pack) is for reading. BrainAI does not read it back.
- **Search triggers** are rebuilt when the restored database first opens (the log says "restored 9 of BrainAI's own
  database triggers"). Nothing is lost, but the first start prints that line.
- **Deleted things come back deleted.** Forgotten facts and deleted pages are in the copy, still deleted, so forgetting sticks.

## Not covered by the drill

The whole database file is copied, so these tables travel with it, but the drill does not fill or compare them:
`observations`, `observation_evidence`, `page_imports`, `page_file_imports`, `weekly_reviews`, `tidy_proposals`,
`meaning_links` (rebuilt from the vectors), `skill_links`, `device_skills`, and the usage log (`tool_calls`).

## What the drill could not simulate

- **A real old version.** There is no old code to run. For d1 and d2 the "old schema" is the source database with the last migration
  undone (a recipe in `DOWNGRADES` in `src/scripts/restoreDrill.ts`, for schema 43 only; it also says how to make the next migration fail). The previous version is stood in by opening the
  restored copy without migrating (`openDb` with `upTo`). If a new migration lands without a recipe, d1 and d2 report SKIPPED and the CI test fails until a recipe is added (a comment above `MIGRATIONS` in `src/db.ts` says so).
- **d1 uses a made-up failure** (the migration's table already exists). It is a real throw inside a real migration, but not a real bad release.
- **Docker, `chown`, and the server's cron.** The scripts run on the Mac against folders in `/tmp`. File ownership (RUNBOOK steps 4 and 5's `chown`) and the container are not part of it.
- **rclone and the cloud.** The off-site test uses a stand-in `rclone` that copies to a local folder. `age` is real, with a throwaway key.
  If `age` is not installed, path c reports SKIPPED and nothing is installed.
- **Tokens over a real network.** The apps are started in-process, and tokens are tried over HTTP on a local port.
- **The desktop app's second backup folder** (`BackupCopy`) copies the same `memory-<date>.db` file as a2, so it is not run on its own.
