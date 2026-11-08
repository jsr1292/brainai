import { DEVICE_DAYS } from './auth/sessions.js';
import Database from 'better-sqlite3';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';

export type DB = Database.Database;

const MIGRATION_1 = `
CREATE TABLE memories(
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('profile','decision','summary')),
  content TEXT NOT NULL,
  project TEXT,
  tags TEXT NOT NULL DEFAULT '[]',
  embedding BLOB NOT NULL,
  created_at TEXT NOT NULL, created_by TEXT NOT NULL,
  updated_at TEXT NOT NULL, updated_by TEXT NOT NULL,
  last_recalled_at TEXT,
  deleted_at TEXT, deleted_by TEXT
);
CREATE INDEX memories_kind ON memories(kind) WHERE deleted_at IS NULL;
CREATE VIRTUAL TABLE memories_fts USING fts5(memory_id UNINDEXED, content, project, tags,
  tokenize = 'unicode61 remove_diacritics 2');
CREATE TABLE memory_history(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  memory_id TEXT NOT NULL REFERENCES memories(id),
  action TEXT NOT NULL CHECK(action IN ('update','delete','restore')),
  content TEXT NOT NULL, project TEXT, tags TEXT NOT NULL,
  changed_at TEXT NOT NULL, changed_by TEXT NOT NULL
);
CREATE TABLE profile_suggestions(
  id TEXT PRIMARY KEY,
  action TEXT NOT NULL CHECK(action IN ('add','update','delete')),
  memory_id TEXT REFERENCES memories(id),
  content TEXT, tags TEXT NOT NULL DEFAULT '[]',
  suggested_at TEXT NOT NULL, suggested_by TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
  resolved_at TEXT
);
CREATE TABLE owner(id INTEGER PRIMARY KEY CHECK(id = 1), password_hash TEXT, totp_secret TEXT, totp_last_step INTEGER);
CREATE TABLE sessions(token_hash TEXT PRIMARY KEY, id TEXT NOT NULL UNIQUE, user_agent TEXT,
  created_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, expires_at TEXT NOT NULL);
CREATE TABLE redirect_allowlist(entry TEXT PRIMARY KEY, added_at TEXT NOT NULL);
CREATE TABLE oauth_clients(client_id TEXT PRIMARY KEY, client_name TEXT, metadata TEXT NOT NULL,
  is_cimd INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, fetched_at TEXT);
CREATE TABLE oauth_pending(id TEXT PRIMARY KEY, client_id TEXT NOT NULL, params TEXT NOT NULL, expires_at TEXT NOT NULL);
CREATE TABLE oauth_grants(id TEXT PRIMARY KEY, client_id TEXT NOT NULL, created_at TEXT NOT NULL,
  last_used_at TEXT, revoked_at TEXT);
CREATE TABLE oauth_codes(code_hash TEXT PRIMARY KEY, grant_id TEXT NOT NULL REFERENCES oauth_grants(id),
  client_id TEXT NOT NULL, code_challenge TEXT NOT NULL, redirect_uri TEXT NOT NULL, resource TEXT,
  expires_at TEXT NOT NULL, used_at TEXT);
CREATE TABLE oauth_tokens(token_hash TEXT PRIMARY KEY, grant_id TEXT NOT NULL REFERENCES oauth_grants(id),
  type TEXT NOT NULL CHECK(type IN ('access','refresh')), resource TEXT,
  expires_at TEXT NOT NULL, revoked_at TEXT);
INSERT INTO redirect_allowlist(entry, added_at) VALUES
  ('https://claude.ai/api/mcp/auth_callback', datetime('now')),
  ('https://claude.com/api/mcp/auth_callback', datetime('now')),
  ('loopback', datetime('now'));
`;

/** Duplicate pairs the owner chose to keep ("Keep both"); ids are stored sorted. */
const MIGRATION_2 = `
CREATE TABLE dismissed_pairs(a TEXT, b TEXT, PRIMARY KEY(a, b));
`;

/** When a refresh token was used up by rotation, as opposed to revoked, so a replay soon after can be forgiven. */
const MIGRATION_3 = `
ALTER TABLE oauth_tokens ADD COLUMN rotated_at TEXT;
`;

/** Project pairs the owner said are different projects ("Different projects"); names are stored sorted. */
const MIGRATION_4 = `
CREATE TABLE dismissed_projects(a TEXT, b TEXT, PRIMARY KEY(a, b));
`;

/** One row per MCP tool call (who and which tool, never the arguments), counted in the weekly digest. */
const MIGRATION_5 = `
CREATE TABLE tool_calls(at TEXT NOT NULL, client TEXT NOT NULL, tool TEXT NOT NULL);
CREATE INDEX tool_calls_at ON tool_calls(at);
`;

/**
 * Keyword search matches word forms ("battery" finds "batteries"): the full-text index is rebuilt with the Porter
 * stemmer. It is English-only but applied to queries and memories alike, so Spanish words still match themselves.
 */
const MIGRATION_6 = `
DROP TABLE memories_fts;
CREATE VIRTUAL TABLE memories_fts USING fts5(memory_id UNINDEXED, content, project, tags,
  tokenize = 'porter unicode61 remove_diacritics 2');
INSERT INTO memories_fts(memory_id, content, project, tags)
  SELECT m.id, m.content, COALESCE(m.project, ''),
    COALESCE((SELECT group_concat(value, ' ') FROM json_each(m.tags)), '')
  FROM memories m WHERE m.deleted_at IS NULL;
`;

/**
 * Discussions: several assistants answer one question in rounds. Replies are unique per voice (author + model) per
 * round. Clients get a display name and grants an access level ('full' or 'discussions' only).
 */
const MIGRATION_7 = `
CREATE TABLE discussions(id TEXT PRIMARY KEY, title TEXT NOT NULL, question TEXT NOT NULL, project TEXT,
  opened_by TEXT NOT NULL, opened_model TEXT NOT NULL, opened_at TEXT NOT NULL, round INTEGER NOT NULL DEFAULT 1,
  ask TEXT NOT NULL DEFAULT '[]', include_limited INTEGER NOT NULL DEFAULT 1,
  closed_at TEXT, decision TEXT, decision_memory_id TEXT, deleted_at TEXT);
CREATE TABLE discussion_posts(id INTEGER PRIMARY KEY, discussion_id TEXT NOT NULL REFERENCES discussions(id),
  round INTEGER NOT NULL, kind TEXT NOT NULL, author TEXT NOT NULL, model TEXT NOT NULL, voice_key TEXT NOT NULL,
  text TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE UNIQUE INDEX discussion_one_reply ON discussion_posts(discussion_id, round, voice_key) WHERE kind = 'reply';
CREATE TABLE discussion_files(discussion_id TEXT NOT NULL REFERENCES discussions(id), name TEXT NOT NULL,
  content TEXT NOT NULL, size INTEGER NOT NULL, added_by TEXT NOT NULL, added_at TEXT NOT NULL, PRIMARY KEY(discussion_id, name));
ALTER TABLE oauth_clients ADD COLUMN display_name TEXT;
ALTER TABLE oauth_grants ADD COLUMN access TEXT NOT NULL DEFAULT 'full';
`;

/** The reply a file came with (NULL: attached when the discussion was opened), so round 1 can hide reply files. */
const MIGRATION_8 = `
ALTER TABLE discussion_files ADD COLUMN post_id INTEGER REFERENCES discussion_posts(id);
`;

/**
 * Suggestions are no longer only for the profile: a memory that reads like an instruction to assistants is held too,
 * so a suggestion records the kind and project to save it under and why it was held (NULL: a profile change).
 */
const MIGRATION_9 = `
ALTER TABLE profile_suggestions ADD COLUMN kind TEXT NOT NULL DEFAULT 'profile';
ALTER TABLE profile_suggestions ADD COLUMN project TEXT;
ALTER TABLE profile_suggestions ADD COLUMN reason TEXT;
`;

/**
 * Other names of a project (an alias always points at a real project name), and devices the owner has logged in
 * from (hashed cookie tokens), which skip the login limit shared by all addresses.
 */
const MIGRATION_10 = `
CREATE TABLE project_aliases(alias TEXT PRIMARY KEY, project TEXT NOT NULL, added_at TEXT NOT NULL, added_by TEXT NOT NULL);
CREATE TABLE known_devices(token_hash TEXT PRIMARY KEY, created_at TEXT NOT NULL, last_used_at TEXT NOT NULL);
`;

/**
 * Memories can be roadmaps (one per project: what is left). SQLite cannot change a CHECK constraint in place, so the
 * table is rebuilt (sqlite.org/lang_altertable.html, "other kinds of table schema changes"), with foreign keys off
 * so memory_history and profile_suggestions keep pointing at it; rowid order (the tie-break of list order) is kept.
 */
const MIGRATION_11 = `
CREATE TABLE memories_new(
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('profile','decision','summary','roadmap')),
  content TEXT NOT NULL,
  project TEXT,
  tags TEXT NOT NULL DEFAULT '[]',
  embedding BLOB NOT NULL,
  created_at TEXT NOT NULL, created_by TEXT NOT NULL,
  updated_at TEXT NOT NULL, updated_by TEXT NOT NULL,
  last_recalled_at TEXT,
  deleted_at TEXT, deleted_by TEXT
);
INSERT INTO memories_new(id, kind, content, project, tags, embedding, created_at, created_by, updated_at, updated_by, last_recalled_at, deleted_at, deleted_by)
  SELECT id, kind, content, project, tags, embedding, created_at, created_by, updated_at, updated_by, last_recalled_at, deleted_at, deleted_by
  FROM memories ORDER BY rowid;
DROP TABLE memories;
ALTER TABLE memories_new RENAME TO memories;
CREATE INDEX memories_kind ON memories(kind) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX memories_one_roadmap ON memories(project) WHERE kind = 'roadmap' AND deleted_at IS NULL;
`;

/** The projects a read-only grant (access 'projects') may read, as a JSON array; NULL for other access levels. */
const MIGRATION_12 = `
ALTER TABLE oauth_grants ADD COLUMN projects TEXT;
`;

/**
 * Projects become first-class: one row per project with its area, one-line description, owner-set state and pin.
 * Filled from the live non-profile memories; a roadmap's "done"/"parked" tags become the state and leave the tags.
 */
const MIGRATION_13 = `
CREATE TABLE projects(
  name TEXT PRIMARY KEY,
  one_liner TEXT,
  area TEXT CHECK(area IN ('apps','home','tools','work','personal')),
  state TEXT NOT NULL DEFAULT 'open' CHECK(state IN ('idea','open','parked','done','archived')),
  state_changed_at TEXT NOT NULL,
  pinned_at TEXT,
  folder TEXT,
  remotes TEXT NOT NULL DEFAULT '[]',
  url TEXT,
  snoozed_until TEXT,
  created_at TEXT NOT NULL, created_by TEXT NOT NULL,
  updated_at TEXT NOT NULL, updated_by TEXT NOT NULL
);
INSERT INTO projects(name, area, state, state_changed_at, created_at, created_by, updated_at, updated_by)
SELECT p.project,
  CASE WHEN p.project IN ('career','finances','investments','health','leisure','preferences') THEN 'personal' END,
  COALESCE((SELECT CASE
      WHEN EXISTS (SELECT 1 FROM json_each(r.tags) WHERE value = 'done') THEN 'done'
      WHEN EXISTS (SELECT 1 FROM json_each(r.tags) WHERE value = 'parked') THEN 'parked' END
    FROM memories r WHERE r.project = p.project AND r.kind = 'roadmap' AND r.deleted_at IS NULL), 'open'),
  strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'migration',
  strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'migration'
FROM (SELECT DISTINCT COALESCE(a.project, m.project) AS project FROM memories m LEFT JOIN project_aliases a ON a.alias = m.project
      WHERE m.project IS NOT NULL AND m.kind != 'profile' AND m.deleted_at IS NULL) p;
UPDATE memories SET tags = (SELECT json_group_array(value) FROM json_each(memories.tags) WHERE value NOT IN ('parked','done'))
WHERE kind = 'roadmap';
UPDATE memories_fts SET tags = COALESCE((SELECT group_concat(j.value, ' ') FROM memories m, json_each(m.tags) j WHERE m.id = memories_fts.memory_id), '')
WHERE memory_id IN (SELECT id FROM memories WHERE kind = 'roadmap');
`;

/**
 * Growth: what assistants noticed about how the owner works. Kept apart from memories, so it never reaches recall,
 * briefs or the profile. A repeat of the same moment adds an evidence row instead of a new observation.
 */
const MIGRATION_14 = `
CREATE TABLE observations(
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('strength','improve')),
  area TEXT NOT NULL CHECK(area IN ('planning','briefing','testing','reviewing','understanding','finishing','git','security','deploying','product')),
  project TEXT,
  summary TEXT NOT NULL,
  practise TEXT,
  embedding BLOB NOT NULL,
  evidence_count INTEGER NOT NULL DEFAULT 1,
  reaction TEXT CHECK(reaction IN ('agree','disagree','dismiss')),
  reacted_at TEXT,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  last_evidence_at TEXT NOT NULL
);
CREATE INDEX observations_match ON observations(kind, area, project);
CREATE TABLE observation_evidence(
  id INTEGER PRIMARY KEY,
  observation_id TEXT NOT NULL REFERENCES observations(id),
  what TEXT NOT NULL,
  project TEXT,
  added_by TEXT NOT NULL,
  added_at TEXT NOT NULL
);
CREATE INDEX observation_evidence_of ON observation_evidence(observation_id);
`;

/**
 * Pages: long documents. Every version is kept; the current version's sections are embedded and indexed for search;
 * [[links]] are resolved at save. A page with a project takes its project's area, so `area` is only for the others.
 */
const MIGRATION_15 = `
CREATE TABLE pages(
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  title_key TEXT NOT NULL,
  project TEXT,
  area TEXT CHECK(area IN ('start','apps','home','tools','work','personal')),
  body TEXT NOT NULL,
  version INTEGER NOT NULL,
  created_at TEXT NOT NULL, created_by TEXT NOT NULL,
  updated_at TEXT NOT NULL, updated_by TEXT NOT NULL,
  deleted_at TEXT
);
CREATE UNIQUE INDEX pages_live_title ON pages(title_key) WHERE deleted_at IS NULL;
CREATE INDEX pages_project ON pages(project) WHERE deleted_at IS NULL;
CREATE TABLE page_versions(
  page_id TEXT NOT NULL REFERENCES pages(id),
  version INTEGER NOT NULL,
  title TEXT NOT NULL,
  project TEXT,
  area TEXT,
  body TEXT NOT NULL,
  saved_at TEXT NOT NULL,
  saved_by TEXT NOT NULL,
  PRIMARY KEY(page_id, version)
);
CREATE TABLE page_sections(
  page_id TEXT NOT NULL REFERENCES pages(id),
  anchor TEXT NOT NULL,
  position INTEGER NOT NULL,
  heading TEXT NOT NULL,
  level INTEGER NOT NULL,
  text TEXT NOT NULL,
  embedding BLOB NOT NULL,
  instruction_like INTEGER NOT NULL,
  PRIMARY KEY(page_id, anchor)
);
CREATE VIRTUAL TABLE page_sections_fts USING fts5(page_id UNINDEXED, anchor UNINDEXED, heading, text,
  tokenize = 'unicode61 remove_diacritics 2');
CREATE TABLE page_links(
  from_page TEXT NOT NULL REFERENCES pages(id),
  kind TEXT NOT NULL CHECK(kind IN ('page','project','fact')),
  target TEXT NOT NULL,
  PRIMARY KEY(from_page, kind, target)
);
CREATE INDEX page_links_target ON page_links(kind, target);
`;

/** Notes for the AIs: the owner asks for a page (or one section) to be updated; an assistant resolves it with a reply. */
const MIGRATION_16 = `
CREATE TABLE notes(
  id TEXT PRIMARY KEY,
  page_id TEXT NOT NULL REFERENCES pages(id),
  anchor TEXT,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','resolved','withdrawn')),
  reply TEXT,
  resolved_at TEXT,
  resolved_by TEXT
);
CREATE INDEX notes_page ON notes(page_id, status);
`;

/** The Mac's folder reports: a device token per Mac (only its hash), its latest report, and folders the owner ignores. */
const MIGRATION_17 = `
CREATE TABLE device_tokens(
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  last_report_at TEXT,
  revoked_at TEXT
);
CREATE TABLE folder_reports(
  device_id TEXT PRIMARY KEY REFERENCES device_tokens(id),
  received_at TEXT NOT NULL,
  folders TEXT NOT NULL
);
CREATE TABLE ignored_folders(
  name TEXT PRIMARY KEY,
  ignored_at TEXT NOT NULL
);
`;

/**
 * The move from Outline: every exported document, the page it became (or why it was not moved, so nothing goes
 * missing unseen), and whether the owner checked it.
 */
const MIGRATION_18 = `
CREATE TABLE page_imports(
  outline_id TEXT PRIMARY KEY,
  page_id TEXT REFERENCES pages(id),
  collection TEXT NOT NULL,
  title TEXT NOT NULL,
  original TEXT NOT NULL,
  outline_updated_at TEXT NOT NULL,
  imported_at TEXT NOT NULL,
  checked_at TEXT,
  status TEXT NOT NULL DEFAULT 'imported' CHECK(status IN ('imported','refused','conflict')),
  reason TEXT
);
`;

/** Growth's daily cap counts per connection (its OAuth client id), not per connection name, which is not unique. */
const MIGRATION_19 = `
ALTER TABLE observations ADD COLUMN created_by_client TEXT;
CREATE INDEX observations_by_client ON observations(created_by_client, created_at);
`;

/**
 * Weekly reviews: one stored week per Monday, built once from history at full scope and shown filtered. Also the
 * indexes week lookups need (memory_history had none), shared with the "may be out of date" flags.
 */
const MIGRATION_20 = `
CREATE TABLE weekly_reviews(
  monday TEXT PRIMARY KEY, format INTEGER NOT NULL, body TEXT NOT NULL,
  built_at TEXT NOT NULL, built_by TEXT NOT NULL, opened_at TEXT, dismissed_at TEXT
);
CREATE INDEX memory_history_memory ON memory_history(memory_id, changed_at);
CREATE INDEX memory_history_changed ON memory_history(changed_at);
CREATE INDEX memory_history_project ON memory_history(project, changed_at);
CREATE INDEX memories_created ON memories(created_at);
CREATE INDEX memories_project_kind ON memories(project, kind, created_at) WHERE deleted_at IS NULL;
CREATE INDEX page_versions_saved ON page_versions(saved_at);
CREATE INDEX observation_evidence_added ON observation_evidence(added_at);
`;

/**
 * The graph (round 2 section 15): where each project runs, and the meaning links between facts and page sections of
 * different projects, worked out once per save. kind 'm' = fact (id = memory id, anchor ''), 's' = page section
 * (id = page id, anchor = section anchor). A pair is stored once, smaller key first. Projects are never stored here: an
 * item's project is looked up when reading, through project_aliases.
 */
const MIGRATION_21 = `
ALTER TABLE projects ADD COLUMN runs_on TEXT NOT NULL DEFAULT '[]';
CREATE TABLE meaning_links(
  a_kind TEXT NOT NULL CHECK (a_kind IN ('m','s')), a_id TEXT NOT NULL, a_anchor TEXT NOT NULL DEFAULT '',
  b_kind TEXT NOT NULL CHECK (b_kind IN ('m','s')), b_id TEXT NOT NULL, b_anchor TEXT NOT NULL DEFAULT '',
  similarity REAL NOT NULL,
  PRIMARY KEY(a_kind, a_id, a_anchor, b_kind, b_id, b_anchor)
);
CREATE INDEX meaning_links_b ON meaning_links(b_kind, b_id, b_anchor);
CREATE TABLE meaning_indexed(
  kind TEXT NOT NULL CHECK (kind IN ('m','s')), id TEXT NOT NULL, anchor TEXT NOT NULL DEFAULT '',
  fingerprint TEXT NOT NULL, indexed_at TEXT NOT NULL,
  PRIMARY KEY(kind, id, anchor)
);
`;

/**
 * Superseded facts (round 2 section 16): which fact replaced which. A fact is replaced while it has a row here with
 * undone_at NULL; undoing sets undone_at, replacing again adds a row. Held saves keep the ids they would replace.
 */
const MIGRATION_22 = `
-- Any later migration that rebuilds \`memories\` (as migration 11 did) must add 'supersessions' to its foreignKeysOff list.
CREATE TABLE supersessions(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  old_id TEXT NOT NULL REFERENCES memories(id),
  new_id TEXT NOT NULL REFERENCES memories(id),
  created_at TEXT NOT NULL, created_by TEXT NOT NULL,
  undone_at TEXT, undone_by TEXT,
  CHECK(old_id != new_id)
);
-- At most one live replacement per fact: a second save that tries fails here, not silently.
CREATE UNIQUE INDEX supersessions_live ON supersessions(old_id) WHERE undone_at IS NULL;
CREATE INDEX supersessions_by_new ON supersessions(new_id) WHERE undone_at IS NULL;
ALTER TABLE profile_suggestions ADD COLUMN supersedes TEXT NOT NULL DEFAULT '[]';
`;

/**
 * May be out of date (round 2 section 13): when each page was last brought up to date, how and by whom. The flag
 * itself is never stored; it is worked out from the facts when a page is shown. page_checks holds the owner's
 * "Still true" taps, with the values before each one for a one-level Undo.
 */
/**
 * Each connection keeps its own name (oauth_grants.name). Every install of an app such as Codex shares one client
 * (one client ID document), so a name kept on the client renamed all of them at once. Each connection starts with
 * the name its app shows today; the client's display_name stays as the name a new consent of that app suggests.
 */
const MIGRATION_24 = `
ALTER TABLE oauth_grants ADD COLUMN name TEXT;
UPDATE oauth_grants SET name = (SELECT COALESCE(c.display_name, c.client_name) FROM oauth_clients c WHERE c.client_id = oauth_grants.client_id);
`;

/**
 * Pictures and diagrams in pages (round 2 section 12; the spec's "migration 23", renumbered). images: one row per
 * stored file, named by the hash of its cleaned bytes. page_images: the current version's pictures, filled at save
 * like page_links. image_upload_links: assistants' one-use upload links (batch I4). diagram_checks: what the owner's
 * browser saw when it drew each diagram (batch I3).
 */
const MIGRATION_25 = `
CREATE TABLE images(
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK(type IN ('jpeg','png','webp','gif')),
  bytes INTEGER NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL,
  frames INTEGER NOT NULL DEFAULT 1,
  alt TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL, created_by TEXT NOT NULL,
  page_id TEXT REFERENCES pages(id),
  removed_at TEXT, removed_by TEXT
);
CREATE TABLE page_images(
  page_id TEXT NOT NULL REFERENCES pages(id), image_id TEXT NOT NULL,
  PRIMARY KEY(page_id, image_id)
);
CREATE INDEX page_images_image ON page_images(image_id);
CREATE TABLE image_upload_links(
  token_hash TEXT PRIMARY KEY, grant_id TEXT NOT NULL, page_id TEXT NOT NULL REFERENCES pages(id),
  alt TEXT NOT NULL, title TEXT, created_by TEXT NOT NULL,
  created_at TEXT NOT NULL, expires_at TEXT NOT NULL, used_at TEXT, image_id TEXT
);
CREATE TABLE diagram_checks(
  page_id TEXT NOT NULL REFERENCES pages(id), block INTEGER NOT NULL,
  version INTEGER NOT NULL, source_hash TEXT NOT NULL,
  error TEXT,
  checked_at TEXT NOT NULL,
  PRIMARY KEY(page_id, block)
);
`;

const MIGRATION_23 = `
ALTER TABLE pages ADD COLUMN caught_up_at TEXT;
ALTER TABLE pages ADD COLUMN caught_up_how TEXT
  CHECK(caught_up_how IN ('created','saved','key_decisions','still_true','restored','imported','migrated'));
ALTER TABLE pages ADD COLUMN caught_up_by TEXT;
ALTER TABLE page_versions ADD COLUMN caught_up_at TEXT;
CREATE TABLE page_checks(
  page_id TEXT NOT NULL REFERENCES pages(id),
  checked_at TEXT NOT NULL,
  prev_at TEXT NOT NULL, prev_how TEXT NOT NULL, prev_by TEXT NOT NULL,
  undone_at TEXT,
  PRIMARY KEY(page_id, checked_at)
);
-- Unsaved imports (version 1 with an imported page_imports row) start from Outline's date, written as the app
-- writes times (milliseconds and Z), so string comparison with memories.created_at is exact.
UPDATE pages SET caught_up_at = (SELECT strftime('%Y-%m-%dT%H:%M:%fZ', MAX(i.outline_updated_at)) FROM page_imports i
    WHERE i.page_id = pages.id AND i.status = 'imported'),
  caught_up_how = 'imported', caught_up_by = updated_by
  WHERE version = 1 AND EXISTS (SELECT 1 FROM page_imports i WHERE i.page_id = pages.id AND i.status = 'imported');
UPDATE pages SET caught_up_at = updated_at, caught_up_how = 'migrated', caught_up_by = updated_by WHERE caught_up_at IS NULL;
`;

/** Forgetting that sticks (round 2 §17a): which deleted fact a held save matched, so the card can quote it. */
const MIGRATION_26 = `
ALTER TABLE profile_suggestions ADD COLUMN deleted_match TEXT REFERENCES memories(id);
`;

/** Guided setup (round 2 §17b): the setup text each connection reports, and the tools it last listed. */
const MIGRATION_27 = `
ALTER TABLE oauth_grants ADD COLUMN setup_version INTEGER;
ALTER TABLE oauth_grants ADD COLUMN setup_seen_at TEXT;
ALTER TABLE oauth_grants ADD COLUMN tool_names TEXT;
ALTER TABLE oauth_grants ADD COLUMN tools_seen_at TEXT;
`;

/** Shared skills (round 2 §17c): the owner's how-tos every assistant can load, Off until the owner turns them on. */
const MIGRATION_28 = `
CREATE TABLE skills(id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL, body TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0, origin TEXT NOT NULL, version INTEGER NOT NULL,
  created_at TEXT NOT NULL, created_by TEXT NOT NULL, updated_at TEXT NOT NULL, updated_by TEXT NOT NULL,
  last_loaded_at TEXT, last_loaded_by TEXT, deleted_at TEXT);
CREATE UNIQUE INDEX skills_live_name ON skills(name) WHERE deleted_at IS NULL;
CREATE TABLE skill_versions(skill_id TEXT NOT NULL REFERENCES skills(id), version INTEGER NOT NULL, name TEXT NOT NULL,
  description TEXT NOT NULL, body TEXT NOT NULL, files TEXT NOT NULL, saved_at TEXT NOT NULL, saved_by TEXT NOT NULL,
  PRIMARY KEY (skill_id, version));
CREATE TABLE skill_files(skill_id TEXT NOT NULL REFERENCES skills(id), path TEXT NOT NULL, text TEXT NOT NULL, PRIMARY KEY (skill_id, path));
CREATE TABLE skill_proposals(id TEXT PRIMARY KEY, skill_id TEXT REFERENCES skills(id), name TEXT NOT NULL, description TEXT NOT NULL,
  body TEXT NOT NULL, files TEXT NOT NULL, base_version INTEGER, proposed_by TEXT NOT NULL, proposed_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','added','applied','rejected')));
`;

/** The Mac skills sync (round 2 §17c): what each device reports, and each shared skill's agreed hashes per device. */
const MIGRATION_29 = `
CREATE TABLE device_skills(device_id TEXT NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL, hash TEXT NOT NULL,
  files INTEGER NOT NULL, bytes INTEGER NOT NULL, shareable TEXT, content TEXT, reported_at TEXT NOT NULL,
  PRIMARY KEY (device_id, name));
CREATE TABLE skill_links(skill_id TEXT NOT NULL REFERENCES skills(id), device_id TEXT NOT NULL, mac_name TEXT NOT NULL,
  mac_hash TEXT NOT NULL, brain_hash TEXT NOT NULL, force_write INTEGER NOT NULL DEFAULT 0, linked_at TEXT NOT NULL,
  PRIMARY KEY (skill_id, device_id));
`;

/** B1: two facts an assistant says can't both be true, until the owner settles them (src/memory/disagreements.ts). */
const MIGRATION_30 = `
CREATE TABLE disagreements(id TEXT PRIMARY KEY, a TEXT NOT NULL, b TEXT NOT NULL, pair TEXT NOT NULL UNIQUE,
  why TEXT NOT NULL, flagged_by TEXT NOT NULL, created_at TEXT NOT NULL, settled_at TEXT, settled_by TEXT,
  settled_how TEXT CHECK (settled_how IN ('a', 'b', 'both', 'gone', 'changed')), CHECK (a <> b));
`;

const MIGRATIONS: { version: number; sql: string; foreignKeysOff?: string[] }[] = [
  { version: 1, sql: MIGRATION_1 },
  { version: 2, sql: MIGRATION_2 },
  { version: 3, sql: MIGRATION_3 },
  { version: 4, sql: MIGRATION_4 },
  { version: 5, sql: MIGRATION_5 },
  { version: 6, sql: MIGRATION_6 },
  { version: 7, sql: MIGRATION_7 },
  { version: 8, sql: MIGRATION_8 },
  { version: 9, sql: MIGRATION_9 },
  { version: 10, sql: MIGRATION_10 },
  // The tables whose foreign keys point at the rebuilt one, checked after it.
  { version: 11, sql: MIGRATION_11, foreignKeysOff: ['memory_history', 'profile_suggestions'] },
  { version: 12, sql: MIGRATION_12 },
  { version: 13, sql: MIGRATION_13 },
  { version: 14, sql: MIGRATION_14 },
  { version: 15, sql: MIGRATION_15 },
  { version: 16, sql: MIGRATION_16 },
  { version: 17, sql: MIGRATION_17 },
  { version: 18, sql: MIGRATION_18 },
  { version: 19, sql: MIGRATION_19 },
  { version: 20, sql: MIGRATION_20 },
  { version: 21, sql: MIGRATION_21 },
  { version: 22, sql: MIGRATION_22 },
  { version: 23, sql: MIGRATION_23 },
  { version: 24, sql: MIGRATION_24 },
  { version: 25, sql: MIGRATION_25 },
  { version: 26, sql: MIGRATION_26 },
  { version: 27, sql: MIGRATION_27 },
  { version: 28, sql: MIGRATION_28 },
  { version: 29, sql: MIGRATION_29 },
  { version: 30, sql: MIGRATION_30 },
];

/** `upTo` stops at that schema version (tests of a migration start from the one before it). */
/** Copies kept in <data>/pre-migrate/: the newest few, one per update that changed the database. */
const PRE_MIGRATE_KEEP = 3;

/** VACUUM INTO <dir>/pre-migrate/pre-migrate-<from>-to-<to>-<stamp>.db, checked; throws (and nothing migrates) if it fails. */
function backupBeforeMigrating(db: DB, path: string, from: number, to: number): void {
  const dir = join(dirname(path), 'pre-migrate');
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const target = join(dir, `pre-migrate-${from}-to-${to}-${stamp}.db`);
  try {
    mkdirSync(dir, { recursive: true });
    if (existsSync(target)) rmSync(target);
    db.prepare('VACUUM INTO ?').run(target);
    const check = new Database(target, { readonly: true });
    try {
      if ((check.pragma('integrity_check', { simple: true }) as string) !== 'ok') throw new Error('the copy failed its integrity check');
    } finally { check.close(); }
  } catch (e) {
    // A partial or unchecked copy never stays under a good name.
    try { rmSync(target, { force: true }); } catch { /* the folder itself may be the problem */ }
    db.close();
    throw new Error(`Could not back up the database before migrating it (version ${from} to ${to}): ${e instanceof Error ? e.message : String(e)}. Nothing was changed.`);
  }
  // Oldest first: by the time in the name, then by the version it came from (several updates in one second).
  const key = (f: string) => { const m = /^pre-migrate-(\d+)-to-\d+-(\d{8}-\d{6})\.db$/.exec(f)!; return `${m[2]}:${m[1]!.padStart(6, '0')}`; };
  const copies = readdirSync(dir).filter((f) => /^pre-migrate-\d+-to-\d+-\d{8}-\d{6}\.db$/.test(f)).sort((a, b) => key(a).localeCompare(key(b)));
  for (const old of copies.slice(0, Math.max(0, copies.length - PRE_MIGRATE_KEEP))) rmSync(join(dir, old), { force: true });
}

export function openDb(path: string, opts: { upTo?: number } = {}): DB {
  const db = new Database(path);
  db.pragma('foreign_keys = ON');
  if (path !== ':memory:') db.pragma('journal_mode = WAL');

  db.exec('CREATE TABLE IF NOT EXISTS schema_version(version INTEGER NOT NULL)');
  db.exec('INSERT INTO schema_version(version) SELECT 0 WHERE NOT EXISTS (SELECT 1 FROM schema_version)');

  const current = (db.prepare('SELECT version FROM schema_version').get() as { version: number }).version;
  const pending = MIGRATIONS.filter((m) => m.version > current && m.version <= (opts.upTo ?? Infinity));
  // An update that changes the database first copies it next to itself, so a bad migration can always be undone.
  if (pending.length > 0 && current > 0 && path !== ':memory:') backupBeforeMigrating(db, path, current, pending.at(-1)!.version);
  for (const m of pending) {
    // A table rebuild runs with foreign keys off (the pragma does nothing inside a transaction), then checks them.
    if (m.foreignKeysOff) db.pragma('foreign_keys = OFF');
    try {
      db.transaction(() => {
        db.exec(m.sql);
        for (const table of m.foreignKeysOff ?? []) {
          if (db.prepare(`PRAGMA foreign_key_check(${table})`).all().length > 0) throw new Error(`Migration ${m.version} would break foreign keys in ${table}`);
        }
        db.prepare('UPDATE schema_version SET version = ?').run(m.version);
      })();
    } finally {
      if (m.foreignKeysOff) db.pragma('foreign_keys = ON');
    }
  }
  return db;
}

/** Rotated or revoked tokens are kept this long past expiry so reuse is still detected (and revokes the grant). */
export const TOKEN_RETENTION_DAYS = 30;
/** Dynamically registered clients that never got a grant are deleted after this long. */
export const UNUSED_CLIENT_DAYS = 7;

/**
 * Deletes rows nobody can use any more. Codes go once expired (used ones included): until then a used code
 * stays so a replay is detected. Grants are never deleted; they are the owner's audit trail. Registered (non-CIMD)
 * clients that never got a grant go after UNUSED_CLIENT_DAYS, so anonymous registrations cannot pile up.
 */
export function purgeExpired(db: DB, now: Date): void {
  const nowIso = now.toISOString();
  const tokenCutoff = new Date(now.getTime() - TOKEN_RETENTION_DAYS * 86_400_000).toISOString();
  const clientCutoff = new Date(now.getTime() - UNUSED_CLIENT_DAYS * 86_400_000).toISOString();
  db.transaction(() => {
    db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(nowIso);
    db.prepare('DELETE FROM known_devices WHERE last_used_at <= ?').run(new Date(now.getTime() - DEVICE_DAYS * 86_400_000).toISOString());
    db.prepare('DELETE FROM oauth_pending WHERE expires_at <= ?').run(nowIso);
    db.prepare('DELETE FROM oauth_codes WHERE expires_at <= ?').run(nowIso);
    db.prepare('DELETE FROM oauth_tokens WHERE expires_at <= ?').run(tokenCutoff);
    db.prepare(`DELETE FROM oauth_clients WHERE is_cimd = 0 AND created_at <= ?
      AND NOT EXISTS (SELECT 1 FROM oauth_grants g WHERE g.client_id = oauth_clients.client_id)`).run(clientCutoff);
  })();
}
