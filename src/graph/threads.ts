import { createHash } from 'node:crypto';
import { setImmediate as nextTurn } from 'node:timers/promises';
import type { Clock } from '../clock.js';
import type { DB } from '../db.js';
import { cosine } from '../memory/embedder.js';
import type { Kind } from '../memory/types.js';
import { isCurrentFactSql } from './current.js';
import { normalWords, sectionText, threadWords, WordCounts } from './words.js';

/**
 * Meaning links between projects (round 2 section 15). After a fact or page section is saved, its vector is compared
 * once with every other current item and its strongest neighbours in other projects are stored in meaning_links;
 * opening the graph only reads and groups those rows. No vector is compared on load.
 */

/**
 * Calibrated on the dry-run copy (2026-11-04, 468 items: 235 decisions and 233 page sections, 41 open projects), with
 * src/scripts/calibrateThreads.ts at 0.84 to 0.88, with and without statuses: floor 0.87 with decisions only gave a
 * median of 4 threads per open project, 0 with none, 6 over 6 (no floor reached 0 over 6; 0.88 left 2 with none).
 * Adding statuses did not lower the count with none, so they stay out. Every thread at 0.87 had words.
 */
export const THREAD_FLOOR = 0.87;
export const THREAD_KINDS: readonly Kind[] = ['decision'];
export const NEIGHBOURS = 5;
export const MIN_LINKS = 2;
export const THREADS_PER_PROJECT = 4;

export type ItemKind = 'm' | 's';
export interface ItemKey { kind: ItemKind; id: string; anchor: string }
export interface IndexItem extends ItemKey { project: string; vector: Float32Array; text: string }
export interface ThreadPair { a: string; b: string; links: number; raw: number; words: string[] }

/** What the memory and page services call right after a write commits. */
export interface MeaningHook {
  factsChanged(ids: readonly string[]): void;
  pageChanged(pageId: string): void;
  /** After a merge or an alias: everything that now resolves to `project` (pages and other names included). */
  projectChanged(project: string): void;
  /** After a replacement is undone: the facts brought back, re-indexed even though their vectors did not change. */
  factsBroughtBack(ids: readonly string[]): void;
}

type Near = { j: number; s: number }[];

/**
 * Offers item `j` at similarity `s` to `list`, which holds at most `k` entries, most similar first. An equal
 * similarity goes after the entries already there, so offers made in index order break ties as a stable sort would.
 */
export function keepNearest(list: Near, j: number, s: number, k: number): void {
  if (k <= 0 || (list.length >= k && list[k - 1]!.s >= s)) return;
  let at = list.length;
  while (at > 0 && list[at - 1]!.s < s) at--;
  list.splice(at, 0, { j, s });
  if (list.length > k) list.pop();
}

/**
 * Every item's `neighbours` nearest in other projects at or above `floor`, as pairs i < j. For a cross-check only: the
 * stored set always contains it, and may hold more (links others chose stay), so calibration uses the real index.
 */
export function chooseLinks(items: readonly IndexItem[], floor: number, neighbours = NEIGHBOURS): { i: number; j: number; s: number }[] {
  const near: Near[] = items.map(() => []);
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      if (items[i]!.project === items[j]!.project) continue;
      const s = cosine(items[i]!.vector, items[j]!.vector);
      if (s >= floor) { keepNearest(near[i]!, j, s, neighbours); keepNearest(near[j]!, i, s, neighbours); }
    }
  }
  const out = new Map<string, { i: number; j: number; s: number }>();
  near.forEach((list, i) => {
    for (const { j, s } of list) {
      const [a, b] = i < j ? [i, j] : [j, i];
      out.set(`${a}:${b}`, { i: a, j: b, s });
    }
  });
  return [...out.values()];
}

/** Project pairs joined by at least MIN_LINKS links; raw = Σ (similarity − floor); strongest first. */
export function groupThreads(links: readonly { pa: string; pb: string; s: number }[], floor: number): { a: string; b: string; links: number; raw: number }[] {
  const pairs = new Map<string, { a: string; b: string; links: number; raw: number }>();
  for (const l of links) {
    if (l.pa === l.pb) continue;
    const [a, b] = l.pa < l.pb ? [l.pa, l.pb] : [l.pb, l.pa];
    const key = `${a}\u0000${b}`;
    const p = pairs.get(key) ?? { a, b, links: 0, raw: 0 };
    p.links++;
    p.raw += l.s - floor;
    pairs.set(key, p);
  }
  return [...pairs.values()].filter((p) => p.links >= MIN_LINKS).sort(byRaw);
}

const byRaw = (x: { a: string; b: string; raw: number }, y: { a: string; b: string; raw: number }) =>
  y.raw - x.raw || (x.a < y.a ? -1 : x.a > y.a ? 1 : x.b < y.b ? -1 : x.b > y.b ? 1 : 0);

/** Each project's `perProject` strongest pairs, united; strength against the strongest given, so it is 1. */
export function topThreads<T extends { a: string; b: string; raw: number }>(pairs: readonly T[], perProject = THREADS_PER_PROJECT): (T & { strength: number })[] {
  const sorted = [...pairs].sort(byRaw);
  const max = sorted[0]?.raw ?? 0;
  const taken = new Map<string, number>();
  const kept = new Set<T>();
  for (const p of sorted) {
    // Each pair is offered to both its ends in strength order; it is drawn when either still has room.
    const ta = taken.get(p.a) ?? 0;
    const tb = taken.get(p.b) ?? 0;
    if (ta < perProject || tb < perProject) kept.add(p);
    taken.set(p.a, ta + 1);
    taken.set(p.b, tb + 1);
  }
  return sorted.filter((p) => kept.has(p)).map((p) => ({ ...p, strength: max > 0 ? p.raw / max : 0 }));
}

const keyOf = (k: ItemKey) => `${k.kind}\u0000${k.id}\u0000${k.anchor}`;
const before = (x: ItemKey, y: ItemKey) => keyOf(x) < keyOf(y);
const fromBlob = (b: Buffer) => new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));

interface TextItem extends ItemKey { project: string; text: string }
type ItemRow = { kind: ItemKind; id: string; anchor: string; project: string; content: string | null; heading: string | null; embedding?: Buffer };

export class MeaningIndex implements MeaningHook {
  private counts: WordCounts | undefined;
  private readonly floor: number;
  private readonly kinds: readonly Kind[];
  private readonly neighbours: number;
  private readonly now: Clock;
  private readonly log: (line: string) => void;
  /** A catch-up is running, and a save hook wrote since its copy of the items was loaded. */
  private catching = 0;
  private stale = false;

  constructor(private db: DB, opts: { floor: number; kinds: readonly Kind[]; neighbours?: number; now: Clock; log?: (line: string) => void }) {
    this.floor = opts.floor;
    this.kinds = opts.kinds;
    this.neighbours = opts.neighbours ?? NEIGHBOURS;
    this.now = opts.now;
    this.log = opts.log ?? ((line) => console.log(line));
  }

  /** Current items with a project, its real name through aliases; `vectors` adds the embeddings (the costly part). */
  private rows(vectors: boolean): ItemRow[] {
    const kinds = this.kinds.length > 0 ? this.kinds : ['none'];
    const emb = vectors ? ', m.embedding' : '';
    const semb = vectors ? ', s.embedding' : '';
    // A decision tagged status is a status (isStatus in brief.ts), and statuses stay out unless summaries are asked for.
    const statuses = this.kinds.includes('summary') ? '' : " AND NOT EXISTS (SELECT 1 FROM json_each(m.tags) t WHERE t.value = 'status')";
    return this.db.prepare(`
      SELECT 'm' AS kind, m.id, '' AS anchor, COALESCE(a.project, m.project) AS project, m.content, NULL AS heading${emb}
        FROM memories m LEFT JOIN project_aliases a ON a.alias = m.project
        WHERE ${isCurrentFactSql('m')} AND m.project IS NOT NULL AND m.kind IN (${kinds.map(() => '?').join(', ')})${statuses}
      UNION ALL
      SELECT 's', s.page_id, s.anchor, COALESCE(a.project, p.project), s.text, s.heading${semb}
        FROM page_sections s JOIN pages p ON p.id = s.page_id LEFT JOIN project_aliases a ON a.alias = p.project
        WHERE p.deleted_at IS NULL AND p.project IS NOT NULL
      ORDER BY 1, 2, 3`).all(...kinds) as ItemRow[];
  }

  private static text(r: ItemRow): string {
    return r.kind === 'm' ? r.content ?? '' : sectionText(r.heading ?? '', r.content ?? '');
  }

  /** The only method that reads vectors. With `keys`, only those items (still read in one pass). */
  loadItems(keys?: readonly ItemKey[]): IndexItem[] {
    const want = keys && new Set(keys.map(keyOf));
    return this.rows(true)
      .filter((r) => !want || want.has(keyOf(r)))
      .map((r) => ({ kind: r.kind, id: r.id, anchor: r.anchor, project: r.project, vector: fromBlob(r.embedding!), text: MeaningIndex.text(r) }));
  }

  private loadTexts(): TextItem[] {
    return this.rows(false).map((r) => ({ kind: r.kind, id: r.id, anchor: r.anchor, project: r.project, text: MeaningIndex.text(r) }));
  }

  fingerprint(item: IndexItem): string {
    const h = createHash('sha256');
    h.update(Buffer.from(item.vector.buffer, item.vector.byteOffset, item.vector.byteLength));
    h.update('\n');
    h.update(item.project);
    return h.digest('hex').slice(0, 16);
  }

  private stored(key: ItemKey): { fingerprint: string; indexed_at: string } | undefined {
    return this.db.prepare('SELECT fingerprint, indexed_at FROM meaning_indexed WHERE kind = ? AND id = ? AND anchor = ?')
      .get(key.kind, key.id, key.anchor) as { fingerprint: string; indexed_at: string } | undefined;
  }

  /** Re-indexes each key whose item exists and whose fingerprint changed (all of them with `force`); returns how many. */
  refresh(keys: readonly ItemKey[], opts: { force?: boolean } = {}): number {
    if (keys.length === 0) return 0;
    if (this.catching > 0) this.stale = true;
    const items = this.loadItems();
    const at = new Map(items.map((it, i) => [keyOf(it), i]));
    let n = 0;
    this.db.transaction(() => {
      for (const k of keys) {
        const i = at.get(keyOf(k));
        if (i === undefined) continue;
        const item = items[i]!;
        if (!opts.force && this.stored(item)?.fingerprint === this.fingerprint(item)) continue;
        this.reindex(items, i);
        n++;
      }
    })();
    return n;
  }

  factsChanged(ids: readonly string[]): void {
    this.refresh(ids.map((id) => ({ kind: 'm' as const, id, anchor: '' })));
  }

  factsBroughtBack(ids: readonly string[]): void {
    this.refresh(ids.map((id) => ({ kind: 'm' as const, id, anchor: '' })), { force: true });
  }

  /** Re-indexes every item whose real name is now `project`; the fingerprint check skips the ones that did not change. */
  projectChanged(project: string): void {
    this.refresh(this.rows(false).filter((r) => r.project === project));
  }

  pageChanged(pageId: string): void {
    const anchors = (this.db.prepare('SELECT anchor FROM page_sections WHERE page_id = ?').all(pageId) as { anchor: string }[]).map((r) => r.anchor);
    this.refresh(anchors.map((anchor) => ({ kind: 's' as const, id: pageId, anchor })));
    this.db.transaction(() => {
      this.db.prepare(`DELETE FROM meaning_links WHERE (a_kind = 's' AND a_id = ? AND a_anchor NOT IN (SELECT anchor FROM page_sections WHERE page_id = ?))
        OR (b_kind = 's' AND b_id = ? AND b_anchor NOT IN (SELECT anchor FROM page_sections WHERE page_id = ?))`).run(pageId, pageId, pageId, pageId);
      this.db.prepare(`DELETE FROM meaning_indexed WHERE kind = 's' AND id = ? AND anchor NOT IN (SELECT anchor FROM page_sections WHERE page_id = ?)`).run(pageId, pageId);
    })();
  }

  /** Drops the rows of sections no longer on their page. */
  private dropRemovedSections(): void {
    const gone = (k: string, id: string, anchor: string) =>
      `${k} = 's' AND NOT EXISTS (SELECT 1 FROM page_sections s WHERE s.page_id = ${id} AND s.anchor = ${anchor})`;
    const l = 'meaning_links';
    const i = 'meaning_indexed';
    this.db.prepare(`DELETE FROM ${l} WHERE (${gone(`${l}.a_kind`, `${l}.a_id`, `${l}.a_anchor`)}) OR (${gone(`${l}.b_kind`, `${l}.b_id`, `${l}.b_anchor`)})`).run();
    this.db.prepare(`DELETE FROM ${i} WHERE ${gone(`${i}.kind`, `${i}.id`, `${i}.anchor`)}`).run();
  }

  /**
   * The safety net at startup: re-indexes every item that is missing or whose fingerprint changed, `chunk` at a time
   * with a turn of the event loop between chunks. An item a save hook re-indexed meanwhile is left as the hook wrote it,
   * and after any hook write the next chunk works from fresh items, so no link a hook made is dropped or made stale.
   */
  async catchUp(opts: { chunk?: number; onChunk?: () => void } = {}): Promise<{ checked: number; indexed: number; ms: number }> {
    const started = performance.now();
    const chunk = Math.max(1, opts.chunk ?? 200);
    this.catching++;
    try {
      let items = this.loadItems();
      const checked = items.length;
      const seen = new Map((this.db.prepare('SELECT kind, id, anchor, fingerprint, indexed_at FROM meaning_indexed').all() as
        (ItemKey & { fingerprint: string; indexed_at: string })[]).map((r) => [keyOf(r), `${r.fingerprint}@${r.indexed_at}`]));
      this.dropRemovedSections();
      const todo = items.filter((it) => seen.get(keyOf(it))?.split('@')[0] !== this.fingerprint(it)).map(keyOf);
      let at = new Map(items.map((it, i) => [keyOf(it), i]));
      let indexed = 0;
      for (let start = 0; start < todo.length; start += chunk) {
        if (this.stale) {
          this.stale = false;
          items = this.loadItems();
          at = new Map(items.map((it, i) => [keyOf(it), i]));
        }
        this.db.transaction(() => {
          for (const key of todo.slice(start, start + chunk)) {
            const i = at.get(key);
            if (i === undefined) continue;
            const now = this.stored(items[i]!);
            if ((now && `${now.fingerprint}@${now.indexed_at}`) !== seen.get(key)) continue;
            this.reindex(items, i);
            indexed++;
          }
        })();
        opts.onChunk?.();
        await nextTurn();
      }
      return { checked, indexed, ms: Math.round(performance.now() - started) };
    } finally {
      this.catching--;
    }
  }

  wordCounts(): WordCounts | undefined {
    return this.counts;
  }

  /**
   * Re-indexes item i: its rows go, its top neighbours in other projects come back, and so does any pair in which X
   * would rank among the other item's top `neighbours`.
   */
  private reindex(items: readonly IndexItem[], i: number): void {
    const x = items[i]!;
    this.db.prepare(`DELETE FROM meaning_links WHERE (a_kind = ? AND a_id = ? AND a_anchor = ?) OR (b_kind = ? AND b_id = ? AND b_anchor = ?)`)
      .run(x.kind, x.id, x.anchor, x.kind, x.id, x.anchor);
    const top: Near = [];
    const above: { j: number; s: number }[] = [];
    for (let j = 0; j < items.length; j++) {
      if (j === i || items[j]!.project === x.project) continue;
      const s = cosine(x.vector, items[j]!.vector);
      if (s < this.floor) continue;
      above.push({ j, s });
      keepNearest(top, j, s, this.neighbours);
    }
    const insert = this.db.prepare('INSERT OR REPLACE INTO meaning_links(a_kind, a_id, a_anchor, b_kind, b_id, b_anchor, similarity) VALUES (?, ?, ?, ?, ?, ?, ?)');
    const link = (y: IndexItem, s: number) => {
      const [a, b] = before(x, y) ? [x, y] : [y, x];
      insert.run(a.kind, a.id, a.anchor, b.kind, b.id, b.anchor, s);
    };
    const chosen = new Set(top.map((t) => t.j));
    for (const t of top) link(items[t.j]!, t.s);
    // X would rank in Y's top `neighbours`: fewer than that many of Y's stored rows are stronger. (With Y holding at most
    // `neighbours` rows this is "Y has room, or X beats Y's weakest"; counting stronger rows keeps the links others chose
    // from lowering the bar until every pair above the floor is kept.)
    const stronger = this.db.prepare(`SELECT COUNT(*) AS n FROM meaning_links
      WHERE ((a_kind = ? AND a_id = ? AND a_anchor = ?) OR (b_kind = ? AND b_id = ? AND b_anchor = ?)) AND similarity > ?`);
    for (const { j, s } of above) {
      if (chosen.has(j)) continue;
      const y = items[j]!;
      if ((stronger.get(y.kind, y.id, y.anchor, y.kind, y.id, y.anchor, s) as { n: number }).n < this.neighbours) link(y, s);
    }
    this.db.prepare('INSERT OR REPLACE INTO meaning_indexed(kind, id, anchor, fingerprint, indexed_at) VALUES (?, ?, ?, ?, ?)')
      .run(x.kind, x.id, x.anchor, this.fingerprint(x), this.now().toISOString());
    this.counts?.add(x.text);
  }

  /**
   * Project-to-project threads from the stored links between current items (forgotten facts, deleted pages, removed
   * sections and pairs now in one project drop out), each with up to two words. Reads no vector.
   */
  threadPairs(): ThreadPair[] {
    const items = this.loadTexts();
    if (!this.counts) {
      this.counts = new WordCounts();
      for (const it of items) this.counts.add(it.text);
    }
    const byKey = new Map(items.map((it) => [keyOf(it), it]));
    const links = this.db.prepare('SELECT a_kind, a_id, a_anchor, b_kind, b_id, b_anchor, similarity FROM meaning_links WHERE similarity >= ?')
      .all(this.floor) as { a_kind: ItemKind; a_id: string; a_anchor: string; b_kind: ItemKind; b_id: string; b_anchor: string; similarity: number }[];
    const joined: { x: TextItem; y: TextItem; s: number }[] = [];
    for (const l of links) {
      const x = byKey.get(keyOf({ kind: l.a_kind, id: l.a_id, anchor: l.a_anchor }));
      const y = byKey.get(keyOf({ kind: l.b_kind, id: l.b_id, anchor: l.b_anchor }));
      if (x && y && x.project !== y.project) joined.push({ x, y, s: l.similarity });
    }
    const groups = groupThreads(joined.map((l) => ({ pa: l.x.project, pb: l.y.project, s: l.s })), this.floor);
    const sides = new Map<string, { a: Map<string, string>; b: Map<string, string> }>();
    for (const { x, y } of joined) {
      const [ea, eb] = x.project < y.project ? [x, y] : [y, x];
      const key = `${ea.project}\u0000${eb.project}`;
      const s = sides.get(key) ?? { a: new Map(), b: new Map() };
      s.a.set(keyOf(ea), ea.text);
      s.b.set(keyOf(eb), eb.text);
      sides.set(key, s);
    }
    return groups.map((g) => {
      const s = sides.get(`${g.a}\u0000${g.b}`)!;
      const exclude = new Set([...normalWords(g.a).split(' '), ...normalWords(g.b).split(' ')]);
      return { ...g, words: threadWords([...s.a.values()], [...s.b.values()], this.counts!, exclude) };
    });
  }
}
