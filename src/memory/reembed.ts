/*
 * The brain records which embedding model made its vectors (migration 33). When the configured model differs, the
 * first start copies the database, embeds every fact, page section and observation again, and writes all of them,
 * the new stamp and an empty meaning index in ONE transaction: a crash or a model error leaves the brain entirely on
 * the old model, and the next start tries again. Runs before the server listens, so no save can race it.
 */
import { createHash } from 'node:crypto';
import { backupBeforeReembedding, type DB } from '../db.js';
import { EMBED_CHARS } from '../pages/types.js';
import type { Embedder } from './embedder.js';
import type { EmbeddingProfile } from './embeddingProfile.js';
import { embedText } from './keys.js';

const toBlob = (v: Float32Array) => Buffer.from(v.buffer, v.byteOffset, v.byteLength);

/** Vector lengths of the models that existed, for a brain stamped before it had a stamp. */
const MODEL_BY_DIM: Record<number, string> = { 384: 'e5', 768: 'gemma' };

/** The model that made the stored vectors, or null for a brain that has none yet. */
export function storedModel(db: DB): { model: string; dim: number } | null {
  return (db.prepare('SELECT model, dim FROM embedding_model WHERE id = 1').get() as { model: string; dim: number } | undefined) ?? null;
}

function stamp(db: DB, profile: EmbeddingProfile): void {
  db.prepare('INSERT OR REPLACE INTO embedding_model(id, model, dim, embedded_at) VALUES (1, ?, ?, ?)').run(profile.id, profile.dim, new Date().toISOString());
}

/** For a brain without a stamp: the model its vectors' length says made them, or null when it has no vectors. */
function inferred(db: DB): { model: string; dim: number } | null {
  const row = db.prepare(`SELECT length(embedding) / 4 AS dim FROM (
      SELECT embedding FROM memories UNION ALL SELECT embedding FROM page_sections UNION ALL SELECT embedding FROM observations
    ) LIMIT 1`).get() as { dim: number } | undefined;
  if (!row) return null;
  const model = MODEL_BY_DIM[row.dim];
  if (!model) throw new Error(`the stored vectors are ${row.dim} long, which no known search model makes`);
  return { model, dim: row.dim };
}

/** The model that made this brain's vectors: its stamp, else what their length says; null when it has none. */
export function modelOf(db: DB): { model: string; dim: number } | null {
  return storedModel(db) ?? inferred(db);
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Staged vectors are written this many at a time: a stop loses at most one batch. */
const BATCH = 32;
/** A progress line every this many texts (and at the end of each batch that crosses it). */
const PROGRESS_EVERY = 100;

type Item = { tbl: 'm' | 's' | 'o'; key: string; text: string; hash: string };
const hashOf = (text: string) => createHash('sha256').update(text).digest('hex');

/** Every text whose vector the model makes: facts (all of them, deleted included), page sections, observations. */
function items(db: DB): Item[] {
  const out: Item[] = [];
  const add = (tbl: Item['tbl'], key: string, text: string) => out.push({ tbl, key, text, hash: hashOf(text) });
  for (const f of db.prepare('SELECT id, content, keys FROM memories').all() as { id: string; content: string; keys: string }[]) add('m', f.id, embedText(f.content, f.keys));
  // As the page service embeds a section (pages/service.ts): the page title, the heading, then the text.
  for (const s of db.prepare('SELECT s.page_id, s.anchor, s.heading, s.text, p.title FROM page_sections s JOIN pages p ON p.id = s.page_id')
    .all() as { page_id: string; anchor: string; heading: string; text: string; title: string }[]) {
    add('s', `${s.page_id}\n${s.anchor}`, `${s.title} — ${s.heading || s.title}\n${s.text}`.slice(0, EMBED_CHARS));
  }
  for (const o of db.prepare('SELECT id, summary FROM observations').all() as { id: string; summary: string }[]) add('o', o.id, o.summary);
  return out;
}

export async function ensureEmbeddings(
  db: DB, dbPath: string, embedder: Embedder, profile: EmbeddingProfile, log: (line: string) => void = console.log,
  opts: { batch?: number; progressEvery?: number } = {},
): Promise<{ reembedded: false } | { reembedded: true; from: string; facts: number; sections: number; observations: number; ms: number }> {
  const current = modelOf(db);
  if (current === null) { stamp(db, profile); return { reembedded: false }; }
  if (!storedModel(db)) db.prepare('INSERT INTO embedding_model(id, model, dim, embedded_at) VALUES (1, ?, ?, ?)').run(current.model, current.dim, new Date().toISOString());
  if (current.model === profile.id) return { reembedded: false };

  const started = Date.now();
  const all = items(db);
  const count = (tbl: Item['tbl']) => all.filter((i) => i.tbl === tbl).length;
  const [facts, sections, observations] = [count('m'), count('s'), count('o')];
  // Vectors staged by an earlier, stopped attempt for this model, still for the same text, are kept.
  db.prepare('DELETE FROM embedding_staging WHERE model != ?').run(profile.id);
  const staged = new Set((db.prepare('SELECT tbl, key, text_hash FROM embedding_staging WHERE model = ?').all(profile.id) as { tbl: string; key: string; text_hash: string }[])
    .map((r) => `${r.tbl}\n${r.key}\n${r.text_hash}`));
  const todo = all.filter((i) => !staged.has(`${i.tbl}\n${i.key}\n${i.hash}`));
  log(`search model changed (${current.model} → ${profile.id}): re-embedding ${plural(facts, 'fact')}, ${plural(sections, 'page section')} and ${plural(observations, 'observation')}…`
    + (todo.length < all.length ? ` (${all.length - todo.length} already done by an earlier start)` : ''));

  const put = db.prepare('INSERT OR REPLACE INTO embedding_staging(model, tbl, key, text_hash, embedding) VALUES (?, ?, ?, ?, ?)');
  const flush = db.transaction((rows: { i: Item; v: Float32Array }[]) => { for (const { i, v } of rows) put.run(profile.id, i.tbl, i.key, i.hash, toBlob(v)); });
  const size = opts.batch ?? BATCH;
  let pending: { i: Item; v: Float32Array }[] = [];
  let done = all.length - todo.length;
  for (const i of todo) {
    const v = await embedder.embed(i.text, 'passage');
    if (v.length !== profile.dim) throw new Error(`the ${profile.id} model made a ${v.length}-long vector, expected ${profile.dim}: nothing was changed`);
    pending.push({ i, v });
    if (pending.length >= size) {
      flush(pending); done += pending.length; pending = [];
      const every = opts.progressEvery ?? PROGRESS_EVERY;
      if (Math.floor(done / every) > Math.floor((done - size) / every) || done === all.length) log(`re-embedding: ${done} of ${all.length}`);
    }
  }
  if (pending.length > 0) { flush(pending); done += pending.length; log(`re-embedding: ${done} of ${all.length}`); }

  if (dbPath !== ':memory:') backupBeforeReembedding(db, dbPath, current.model, profile.id);
  db.transaction(() => {
    db.exec(`UPDATE memories SET embedding = (SELECT embedding FROM embedding_staging WHERE model = '${profile.id}' AND tbl = 'm' AND key = memories.id)
        WHERE id IN (SELECT key FROM embedding_staging WHERE model = '${profile.id}' AND tbl = 'm');
      UPDATE page_sections SET embedding = (SELECT embedding FROM embedding_staging WHERE model = '${profile.id}' AND tbl = 's' AND key = page_sections.page_id || char(10) || page_sections.anchor)
        WHERE page_id || char(10) || anchor IN (SELECT key FROM embedding_staging WHERE model = '${profile.id}' AND tbl = 's');
      UPDATE observations SET embedding = (SELECT embedding FROM embedding_staging WHERE model = '${profile.id}' AND tbl = 'o' AND key = observations.id)
        WHERE id IN (SELECT key FROM embedding_staging WHERE model = '${profile.id}' AND tbl = 'o');`);
    // Never two sizes: a row saved with the old model while this computed (another process) rolls the switch back,
    // and the next start embeds it too.
    const wrong = db.prepare(`SELECT COUNT(*) AS n FROM (
        SELECT embedding FROM memories UNION ALL SELECT embedding FROM page_sections UNION ALL SELECT embedding FROM observations
      ) WHERE length(embedding) != ?`).get(profile.dim * 4) as { n: number };
    if (wrong.n > 0) throw new Error(`the brain changed while it was being re-embedded (${plural(wrong.n, 'vector')} of the old size): the next start finishes the switch`);
    // The graph's links were measured with the old vectors; the catch-up after listen rebuilds them.
    db.exec('DELETE FROM meaning_links; DELETE FROM meaning_indexed;');
    db.prepare('DELETE FROM embedding_staging WHERE model = ?').run(profile.id);
    stamp(db, profile);
  })();
  const ms = Date.now() - started;
  log(`re-embedding done in ${(ms / 1000).toFixed(1)} s`);
  return { reembedded: true, from: current.model, facts, sections, observations, ms };
}

/** Recall settings set in the environment, which were tuned for `from` and may not suit the new model. */
const TUNED = ['DUPLICATE_THRESHOLD', 'MIN_RECALL_SIMILARITY', 'RECALL_WINDOW', 'RECALL_CONFIDENT_SIMILARITY'] as const;

export function staleOverrides(env: NodeJS.ProcessEnv, from: string): string[] {
  return TUNED.filter((name) => env[name] !== undefined && env[name] !== '').map((name) => `warning: ${name} is set and was tuned for ${from}; check it`);
}
