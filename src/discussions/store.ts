import { randomInt } from 'node:crypto';
import type { Clock } from '../clock.js';
import type { DB } from '../db.js';
import { voiceKey } from './types.js';
import type { Discussion, DiscussionFile, Post } from './types.js';

interface DiscussionRow {
  id: string; title: string; question: string; project: string | null; opened_by: string; opened_model: string;
  opened_at: string; round: number; ask: string; include_limited: number; closed_at: string | null;
  decision: string | null; decision_memory_id: string | null;
}
interface PostRow {
  id: number; discussion_id: string; round: number; kind: Post['kind']; author: string; model: string;
  text: string; created_at: string;
}
interface FileRow { name: string; size: number; added_by: string; added_at: string; post_id: number | null }

/** A file with the reply it came with (null: attached when the discussion was opened). */
export type StoredFile = DiscussionFile & { postId: number | null };

const toDiscussion = (r: DiscussionRow): Discussion => ({
  id: r.id, title: r.title, question: r.question, project: r.project,
  openedBy: { name: r.opened_by, model: r.opened_model }, openedAt: r.opened_at, round: r.round,
  ask: JSON.parse(r.ask) as string[], includeLimited: r.include_limited === 1, closedAt: r.closed_at,
  decision: r.decision, decisionMemoryId: r.decision_memory_id,
});
const toPost = (r: PostRow): Post => ({
  id: r.id, discussionId: r.discussion_id, round: r.round, kind: r.kind, author: r.author, model: r.model,
  text: r.text, createdAt: r.created_at,
});

const ID_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789';
const newId = (): string => Array.from({ length: 8 }, () => ID_CHARS[randomInt(ID_CHARS.length)]).join('');

/** Storage for discussions, their posts and files. Only SQL and row mapping; the rules live in the service. */
export class DiscussionStore {
  constructor(private db: DB, private now: Clock) {}

  private ts(): string {
    return this.now().toISOString();
  }

  /** Runs fn in one SQLite transaction (nests safely with the store's own transactions). */
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  create(d: Omit<Discussion, 'id' | 'openedAt' | 'round' | 'closedAt' | 'decision' | 'decisionMemoryId'>): Discussion {
    const exists = this.db.prepare('SELECT 1 FROM discussions WHERE id = ?');
    let id = newId();
    while (exists.get(id)) id = newId();
    this.db.prepare(`INSERT INTO discussions(id, title, question, project, opened_by, opened_model, opened_at, ask, include_limited)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, d.title, d.question, d.project, d.openedBy.name, d.openedBy.model, this.ts(), JSON.stringify(d.ask), d.includeLimited ? 1 : 0);
    return this.get(id)!;
  }

  get(id: string): Discussion | undefined {
    const r = this.db.prepare('SELECT * FROM discussions WHERE id = ? AND deleted_at IS NULL').get(id) as DiscussionRow | undefined;
    return r && toDiscussion(r);
  }

  /** Open discussions first, then newest first. */
  list(f: { status: 'open' | 'closed' | 'all'; includeLimitedOnly: boolean }): Discussion[] {
    let sql = 'SELECT * FROM discussions WHERE deleted_at IS NULL';
    if (f.status === 'open') sql += ' AND closed_at IS NULL';
    if (f.status === 'closed') sql += ' AND closed_at IS NOT NULL';
    if (f.includeLimitedOnly) sql += ' AND include_limited = 1';
    sql += ' ORDER BY (closed_at IS NOT NULL), opened_at DESC';
    return (this.db.prepare(sql).all() as DiscussionRow[]).map(toDiscussion);
  }

  posts(id: string): Post[] {
    return (this.db.prepare('SELECT * FROM discussion_posts WHERE discussion_id = ? ORDER BY round, created_at, id')
      .all(id) as PostRow[]).map(toPost);
  }

  addPost(p: Omit<Post, 'id' | 'createdAt'>): Post {
    const createdAt = this.ts();
    const info = this.db.prepare(`INSERT INTO discussion_posts(discussion_id, round, kind, author, model, voice_key, text, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(p.discussionId, p.round, p.kind, p.author, p.model, voiceKey(p.author, p.model), p.text, createdAt);
    return { ...p, id: Number(info.lastInsertRowid), createdAt };
  }

  files(id: string): StoredFile[] {
    return (this.db.prepare('SELECT name, size, added_by, added_at, post_id FROM discussion_files WHERE discussion_id = ? ORDER BY name')
      .all(id) as FileRow[]).map((r) => ({ name: r.name, size: r.size, addedBy: r.added_by, addedAt: r.added_at, postId: r.post_id }));
  }

  fileContent(id: string, name: string): string | undefined {
    const r = this.db.prepare('SELECT content FROM discussion_files WHERE discussion_id = ? AND name = ?')
      .get(id, name) as { content: string } | undefined;
    return r?.content;
  }

  /** `postId` is the reply the file came with; leave it out for files attached when opening. */
  addFile(id: string, name: string, content: string, addedBy: string, postId: number | null = null): void {
    this.db.prepare('INSERT INTO discussion_files(discussion_id, name, content, size, added_by, added_at, post_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, name, content, Buffer.byteLength(content), addedBy, this.ts(), postId);
  }

  setRound(id: string, round: number): void {
    this.db.prepare('UPDATE discussions SET round = ? WHERE id = ?').run(round, id);
  }

  setAsk(id: string, ask: string[]): void {
    this.db.prepare('UPDATE discussions SET ask = ? WHERE id = ?').run(JSON.stringify(ask), id);
  }

  setIncludeLimited(id: string, v: boolean): void {
    this.db.prepare('UPDATE discussions SET include_limited = ? WHERE id = ?').run(v ? 1 : 0, id);
  }

  close(id: string, decision: string, memoryId: string | null): void {
    this.db.prepare('UPDATE discussions SET closed_at = ?, decision = ?, decision_memory_id = ? WHERE id = ?')
      .run(this.ts(), decision, memoryId, id);
  }

  softDelete(id: string): void {
    this.db.prepare('UPDATE discussions SET deleted_at = ? WHERE id = ?').run(this.ts(), id);
  }
}
