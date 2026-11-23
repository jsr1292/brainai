import type { Clock } from '../clock.js';
import type { Key } from '../i18n/core.js';
import { localDay } from '../timezone.js';
import { checkProject, MAX_CONTENT, MemoryError, type MemoryService } from '../memory/service.js';
import { looksLikeInstruction } from '../memory/instructionLike.js';
import { looksLikeKey, looksLikeSecret } from '../memory/secrets.js';
import type { DiscussionStore, StoredFile } from './store.js';
import { isSameVoice, mayTakeOver, nameKey, publicPost, type GrantState } from './types.js';
import type { Access, Discussion, DiscussionFile, Post, StoredPost, Voice } from './types.js';

/** Who is acting. The model may be '' only for reads (dashboard, or an assistant that has not said). */
/** `grantId`: the connection (absent for the owner and for callers that have none); identity is by it, never by the name. */
export interface Caller { name: string; model: string; access: Access; grantId?: string }
/** An active connection (used in the last 30 days). */
export interface Connection { name: string; access: Access }

export interface DiscussionSummary {
  id: string; title: string; project: string | null; round: number; closed: boolean;
  /** Voice labels "Name · model" with a reply this round. */
  replied: string[];
  /** Ask names with no reply this round. */
  waitingFor: string[];
  expectsCaller: boolean;
}
/** A reply as read: `contains_instructions` is there (true) when its text reads like an instruction to assistants. Marked, never held or refused: every reader sees the marker. */
export type MarkedPost = Post & { contains_instructions?: true };
/** Works out the marker at read time, so it always follows the current check and needs no stored column. */
export const markInstructions = (posts: Post[]): MarkedPost[] => posts.map((p) => (p.kind === 'reply' && looksLikeInstruction(p.text) !== null ? { ...p, contains_instructions: true as const } : p));

export interface DiscussionView extends DiscussionSummary {
  question: string; question_contains_instructions?: true; openedBy: Voice; files: (DiscussionFile & { contains_instructions?: true })[]; notes: Post[]; replies: MarkedPost[];
  hidden: number; decision: string | null; stage: 'blind' | 'respond' | 'replied' | 'closed';
  /** The caller is the connection that opened it (by grant; by name for old discussions). False for the owner. */
  callerIsOpener: boolean;
}

/** What only the owner's dashboard needs on top of the assistant view. */
export interface OwnerDiscussionView extends DiscussionView {
  ask: string[]; includeLimited: boolean; openedAt: string; closedAt: string | null; decisionMemoryId: string | null;
}
export interface OwnerSummary extends DiscussionSummary { closedAt: string | null }

export const FILE_PART_CHARS = 50_000;
const MAX_TITLE = 120;
const MAX_TEXT = 8000;
const MAX_FILE_BYTES = 200_000;
const MAX_FILES = 20;
const MAX_FILES_BYTES = 1_000_000;
const MAX_FILE_NAME = 200;
const MAX_ASK = 10;
const MAX_ASK_NAME = 100;
const MAX_MODEL = 60;

type NewFile = { name: string; content: string };

/**
 * Text the owner pastes into an assistant to make it join. Only the id: the title is written by an assistant and
 * must not reach another assistant's prompt.
 */
export function askText(id: string, round: number, memory = 'shared-memory'): string {
  return round === 1
    ? `Read the ${memory} discussion with id ${id} and give your view.`
    : `Read the ${memory} discussion with id ${id} again and reply to the others.`;
}

/**
 * The request the opener passes to another assistant's command line (ASK_COMMANDS). Only the id, like askText, and
 * no quotes or shell characters, so it is safe inside the double quotes of the configured command.
 */
export function summonText(id: string, round: number, memory = 'shared-memory'): string {
  return round === 1
    ? `Read the ${memory} discussion with id ${id}, give your own view with reply_to_discussion, then stop.`
    : `Read the ${memory} discussion with id ${id} again, reply to the others with reply_to_discussion, then stop.`;
}

/** A closed discussion's decision memory, and the project it was saved in (null for none). */
export interface Closed { memoryId: string; project: string | null }

/** A file as callers see it, without the internal link to its reply. */
const publicFile = ({ postId: _postId, ...f }: StoredFile): DiscussionFile => f;
/** A file as read, marked (true) when its text reads like instructions: assistants write these and other assistants read them. */
const markedFile = (store: DiscussionStore, id: string, f: StoredFile): DiscussionFile & { contains_instructions?: true } => {
  const text = store.fileContent(id, f.name);
  return text !== undefined && looksLikeInstruction(text) !== null ? { ...publicFile(f), contains_instructions: true } : publicFile(f);
};
/** The opening question, marked the same way. */
const questionMark = (q: string): { question_contains_instructions?: true } => (looksLikeInstruction(q) !== null ? { question_contains_instructions: true } : {});

/** Forms send '' for "no project". */
const blankToUndefined = (p: string | undefined): string | undefined => (typeof p === 'string' && p.trim() === '' ? undefined : p);

const label = (p: { author: string; model: string }): string => `${p.author} · ${p.model}`;

const LEN_KEY: Record<string, Key> = { title: 'err.disc.len.title', question: 'err.disc.len.question', reply: 'err.disc.len.reply', decision: 'err.disc.len.decision', note: 'err.disc.len.note' };
const SECRET_KEY: Record<string, Key> = { title: 'err.disc.secret.title', question: 'err.disc.secret.question', reply: 'err.disc.secret.reply', decision: 'err.disc.secret.decision', note: 'err.disc.secret.note' };

function checkText(what: string, text: unknown, max: number): string {
  if (typeof text !== 'string' || text.trim().length < 1 || text.length > max) {
    throw new MemoryError('invalid', `The ${what} must be 1 to ${max.toLocaleString('en-US')} characters.`, undefined, { key: LEN_KEY[what]!, params: { max: max } });
  }
  const reason = looksLikeSecret(text);
  if (reason) throw new MemoryError('secret_detected', `The ${what} looks like it contains a secret (${reason}). Remove it and try again.`, undefined, { key: SECRET_KEY[what]!, params: { reason } });
  return text;
}

/**
 * A title is one line: no control characters (newlines and tabs included) and no line separators. It ends up in
 * the decision memory, so one that reads like an instruction to assistants is refused.
 */
function checkTitle(title: unknown): string {
  const t = checkText('title', title, MAX_TITLE);
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\u2028\u2029]/.test(t)) throw new MemoryError('invalid', 'The title must be a single line of text.', undefined, { key: 'err.disc.titleLine' });
  const reason = looksLikeInstruction(t);
  if (reason) throw new MemoryError('invalid', `The title reads like an instruction to AI assistants (${reason}). Use a plain title.`, undefined, { key: 'err.disc.titleInstr', params: { reason } });
  return t;
}

function checkModel(model: unknown): string {
  const m = typeof model === 'string' ? model.trim() : '';
  if (m.length < 1 || m.length > MAX_MODEL) throw new MemoryError('invalid', 'State your model (for example "GLM-5").', undefined, { key: 'err.disc.model' });
  return m;
}

/** A file name may be a relative path ("src/x.ts"), as assistants on the Mac attach by path. */
function fileNameAllowed(name: string): boolean {
  // eslint-disable-next-line no-control-regex
  return name.length >= 1 && name.length <= MAX_FILE_NAME && !/[\\\u0000-\u001f\u007f]/.test(name)
    && !name.startsWith('/') && !name.split('/').includes('..');
}

function checkFile(f: NewFile): void {
  const name = typeof f?.name === 'string' ? f.name : '';
  if (!fileNameAllowed(name)) {
    throw new MemoryError('invalid', `File name "${name.slice(0, 40)}" is not allowed: use 1 to ${MAX_FILE_NAME} characters, with no \\ or control characters, not starting with / and with no .. parts.`, undefined, { key: 'err.disc.fileName', params: { name: name.slice(0, 40), max: MAX_FILE_NAME } });
  }
  const content = f.content;
  if (typeof content !== 'string' || content.includes('\u0000') || Buffer.from(content, 'utf8').toString('utf8') !== content) {
    throw new MemoryError('invalid', `File "${name}" is not UTF-8 text (binary files are not accepted).`, undefined, { key: 'err.disc.fileNotText', params: { name } });
  }
  if (Buffer.byteLength(content) > MAX_FILE_BYTES) {
    throw new MemoryError('invalid', `File "${name}" is larger than ${MAX_FILE_BYTES.toLocaleString('en-US')} bytes.`, undefined, { key: 'err.disc.fileTooBig', params: { name, max: MAX_FILE_BYTES } });
  }
  const reason = looksLikeKey(content);
  if (reason) throw new MemoryError('secret_detected', `File "${name}" looks like it contains a secret (${reason}). Remove it and try again.`, undefined, { key: 'err.disc.fileSecret', params: { name, reason } });
}

/** Checks new files against each other and against what the discussion already holds. */
function checkFiles(files: NewFile[], existing: DiscussionFile[]): void {
  const names = new Set(existing.map((f) => f.name));
  let bytes = existing.reduce((n, f) => n + f.size, 0);
  if (existing.length + files.length > MAX_FILES) throw new MemoryError('invalid', `A discussion can hold at most ${MAX_FILES} files.`, undefined, { key: 'err.disc.maxFiles', params: { max: MAX_FILES } });
  for (const f of files) {
    checkFile(f);
    if (names.has(f.name)) throw new MemoryError('invalid', `File "${f.name}" is already attached to this discussion.`, undefined, { key: 'err.disc.fileDup', params: { name: f.name } });
    names.add(f.name);
    bytes += Buffer.byteLength(f.content);
  }
  if (bytes > MAX_FILES_BYTES) throw new MemoryError('invalid', `Files in one discussion can total at most ${MAX_FILES_BYTES.toLocaleString('en-US')} bytes.`, undefined, { key: 'err.disc.filesTotal', params: { max: MAX_FILES_BYTES } });
}

/** The rules of discussions: who may see what, blind first round, rounds, limits. Storage lives in DiscussionStore. */
export class DiscussionService {
  constructor(
    private store: DiscussionStore,
    private memory: MemoryService,
    private connections: () => Connection[],
    private now: Clock,
    /** What became of a connection (grant); a gone opener or writer that was Full, or whose row is missing, is matched by name for a Full caller. */
    private grantState: (grantId: string) => GrantState = () => 'live',
  ) {}

  open(caller: Caller, a: { title: string; question: string; project?: string; ask?: string[]; includeLimited?: boolean; files?: NewFile[] }): Discussion {
    const model = checkModel(caller.model);
    const title = checkTitle(a.title);
    const question = checkText('question', a.question, MAX_TEXT);
    const project = checkProject(blankToUndefined(a.project));
    const includeLimited = a.includeLimited !== false;
    // Hidden from discussions-only connections means hidden from this opener too: it could never read it again.
    if (!includeLimited && caller.access === 'discussions') {
      throw new MemoryError('invalid', 'A discussion opened here is always shared with discussions-only assistants, this one included. '
        + 'For a question that touches anything personal, ask the owner to open it from a Full connection instead.', undefined, { key: 'err.disc.limitedShared' });
    }
    const files = a.files ?? [];
    checkFiles(files, []);
    // An empty (or all blank) list is taken as "ask the usual ones", not "ask nobody".
    const given = a.ask?.some((n) => typeof n !== 'string' || n.trim() !== '') ? a.ask : undefined;
    const ask = this.askList(caller, given, includeLimited);
    const opener = caller.name;
    return this.store.transaction(() => {
      const d = this.store.create({ title, question, project, openedBy: { name: opener, model }, openedGrant: caller.grantId ?? null, ask, includeLimited });
      for (const f of files) this.store.addFile(d.id, f.name, f.content, opener);
      return d;
    });
  }

  private askList(caller: { name: string }, given: string[] | undefined, includeLimited: boolean): string[] {
    const names = given ?? this.connections()
      .filter((c) => includeLimited || c.access !== 'discussions')
      .map((c) => c.name);
    const cap = given === undefined;
    const seen = new Set<string>([nameKey(caller.name)]);
    const out: string[] = [];
    for (const raw of names) {
      const n = typeof raw === 'string' ? raw.trim() : '';
      if (n.length < 1 || n.length > MAX_ASK_NAME) throw new MemoryError('invalid', `Each name in the ask list must be 1 to ${MAX_ASK_NAME} characters.`, undefined, { key: 'err.disc.askName', params: { max: MAX_ASK_NAME } });
      if (seen.has(nameKey(n))) continue;
      seen.add(nameKey(n));
      out.push(n);
    }
    if (cap && out.length > MAX_ASK) out.length = MAX_ASK;
    if (out.length > MAX_ASK) throw new MemoryError('invalid', `The ask list can have at most ${MAX_ASK} names.`, undefined, { key: 'err.disc.askMax', params: { max: MAX_ASK } });
    return out;
  }

  /** The discussion, or not_found if it is missing or hidden from this caller (same answer for both). */
  private find(caller: Caller, id: string): Discussion {
    const d = this.store.get(id);
    if (!d || (caller.access === 'discussions' && !d.includeLimited)) throw new MemoryError('not_found', `No discussion with id "${id}".`, undefined, { key: 'err.disc.notFound', params: { id } });
    return d;
  }

  visible(caller: Caller, status: 'open' | 'closed' | 'all'): DiscussionSummary[] {
    return this.store.list({ status, includeLimitedOnly: caller.access === 'discussions' })
      .map((d) => this.summary(caller, d, this.store.posts(d.id)));
  }

  private summary(caller: Caller, d: Discussion, posts: StoredPost[]): DiscussionSummary {
    const current = posts.filter((p) => p.kind === 'reply' && p.round === d.round);
    const names = new Set(current.map((p) => nameKey(p.author)));
    const waitingFor = d.ask.filter((n) => !names.has(nameKey(n)));
    const closed = d.closedAt !== null;
    return {
      id: d.id, title: d.title, project: d.project, round: d.round, closed,
      replied: [...new Set(current.map(label))], waitingFor,
      expectsCaller: !closed && waitingFor.some((n) => nameKey(n) === nameKey(caller.name)),
    };
  }

  /** Whether the caller opened this discussion: by grant when both are known, by name for older discussions. Never true for a caller without a grant against one opened with a grant. */
  private isOpener(caller: Caller, d: Discussion): boolean {
    if (d.openedGrant !== null) {
      if (caller.grantId !== undefined && caller.grantId === d.openedGrant) return true;
      // The opener's connection is gone (revoked or restored away): a Full caller of the same name takes over its steps.
      return mayTakeOver(caller, () => this.grantState(d.openedGrant!)) && nameKey(d.openedBy.name) === nameKey(caller.name);
    }
    return nameKey(d.openedBy.name) === nameKey(caller.name);
  }

  /** Whether the caller's voice (name + stated model) has a reply in `round`; never true without a model. */
  private repliedIn(caller: Caller, posts: StoredPost[], round: number): boolean {
    if (!caller.model.trim()) return false;
    return posts.some((p) => p.kind === 'reply' && p.round === round && isSameVoice(caller, caller.model, p, this.grantState));
  }

  /** Round 1 is blind until the caller has replied in it. */
  private isBlind(caller: Caller, d: Discussion, posts: StoredPost[]): boolean {
    return d.closedAt === null && d.round === 1 && !this.repliedIn(caller, posts, 1);
  }

  /** The files the caller may see: while blind, only those attached when opening and those of its own replies. */
  private filesFor(caller: Caller, d: Discussion, posts: StoredPost[]): StoredFile[] {
    const files = this.store.files(d.id);
    if (!this.isBlind(caller, d, posts)) return files;
    const own = new Set(posts.filter((p) => p.kind === 'reply' && caller.model.trim() !== '' && isSameVoice(caller, caller.model, p, this.grantState)).map((p) => p.id));
    return files.filter((f) => f.postId === null || own.has(f.postId));
  }

  read(caller: Caller, id: string): DiscussionView {
    const d = this.find(caller, id);
    const posts = this.store.posts(id);
    const base = this.summary(caller, d, posts);
    const closed = d.closedAt !== null;
    const blind = this.isBlind(caller, d, posts);
    const replies = posts.filter((p) => p.kind === 'reply');
    const shown = blind ? [] : replies;
    const stage = closed ? 'closed' : this.repliedIn(caller, posts, d.round) ? 'replied' : d.round === 1 ? 'blind' : 'respond';
    return {
      ...base, question: d.question, openedBy: d.openedBy, files: this.filesFor(caller, d, posts).map((f) => markedFile(this.store, id, f)), ...questionMark(d.question),
      notes: posts.filter((p) => p.kind === 'note').map(publicPost), replies: markInstructions(shown.map(publicPost)), hidden: replies.length - shown.length,
      decision: d.decision, stage, callerIsOpener: this.isOpener(caller, d),
    };
  }

  readFile(caller: Caller, id: string, name: string, part = 1): { name: string; part: number; parts: number; text: string; contains_instructions?: true } {
    const d = this.find(caller, id);
    const visible = this.filesFor(caller, d, this.store.posts(id)).some((f) => f.name === name);
    const content = visible ? this.store.fileContent(id, name) : undefined;
    if (content === undefined) throw new MemoryError('not_found', `No file "${name}" in this discussion.`, undefined, { key: 'err.disc.fileNotFound', params: { name } });
    const chars = Array.from(content);
    const parts = Math.max(1, Math.ceil(chars.length / FILE_PART_CHARS));
    if (!Number.isInteger(part) || part < 1 || part > parts) throw new MemoryError('invalid', `part must be a whole number from 1 to ${parts}.`, undefined, { key: 'err.disc.partRange', params: { parts } });
    const text = chars.slice((part - 1) * FILE_PART_CHARS, part * FILE_PART_CHARS).join('');
    return { name, part, parts, text, ...(looksLikeInstruction(text) !== null ? { contains_instructions: true as const } : {}) };
  }

  reply(caller: Caller, id: string, a: { text: string; files?: NewFile[] }): { post: Post; round: number; roundEnded: boolean } {
    const d0 = this.find(caller, id);
    if (d0.closedAt) throw new MemoryError('invalid', 'This discussion is closed.', undefined, { key: 'err.disc.closed' });
    const model = checkModel(caller.model);
    const text = checkText('reply', a.text, MAX_TEXT);
    const files = a.files ?? [];
    return this.store.transaction(() => {
      const d = this.store.get(id);
      if (!d || d.closedAt) throw new MemoryError('invalid', 'This discussion is closed.', undefined, { key: 'err.disc.closed' });
      const posts = this.store.posts(id);
      if (posts.some((p) => p.kind === 'reply' && p.round === d.round && isSameVoice(caller, model, p, this.grantState))) {
        throw new MemoryError('invalid', `You already replied in round ${d.round}; wait for the owner to start the next round.`, undefined, { key: 'err.disc.alreadyReplied', params: { round: d.round } });
      }
      checkFiles(files, this.store.files(id));
      const post = this.store.addPost({ discussionId: id, round: d.round, kind: 'reply', author: caller.name, model, text, grantId: caller.grantId ?? null });
      for (const f of files) this.store.addFile(id, f.name, f.content, caller.name, post.id);
      let ask = d.ask;
      if (!ask.some((n) => nameKey(n) === nameKey(caller.name))) {
        ask = [...ask, caller.name];
        this.store.setAsk(id, ask);
      }
      let roundEnded = false;
      // A reply that only joined an empty ask list does not complete the round by itself.
      if (d.round === 1 && d.ask.length > 0) {
        const names = new Set([...posts, post].filter((p) => p.kind === 'reply' && p.round === 1).map((p) => nameKey(p.author)));
        if (ask.every((n) => names.has(nameKey(n)))) {
          this.store.setRound(id, 2);
          roundEnded = true;
        }
      }
      return { post: publicPost(post), round: roundEnded ? 2 : d.round, roundEnded };
    });
  }

  private static readonly OWNER: Caller = { name: '', model: '', access: 'full' };

  /** The discussion for an owner action; refuses closed ones. */
  private openOne(id: string): Discussion {
    const d = this.store.get(id);
    if (!d) throw new MemoryError('not_found', `No discussion with id "${id}".`, undefined, { key: 'err.disc.notFound', params: { id } });
    if (d.closedAt) throw new MemoryError('invalid', 'This discussion is closed.', undefined, { key: 'err.disc.closed' });
    return d;
  }

  /** Closes in progress (the memory write is async), so a second close cannot write a second decision meanwhile. */
  private closing = new Map<string, { decision: string; done: Promise<Closed> }>();

  /**
   * Closes the discussion with a decision, saved as the only memory it ever creates. The close is claimed before the
   * async memory write, so a close that arrives meanwhile writes nothing: the same decision (a double-click) gets the
   * same answer, a different one is refused. A repeat of the decision already recorded also gets the same answer.
   */
  async close(by: Caller | 'owner', id: string, a: { decision: string; project?: string }): Promise<Closed> {
    const d = by === 'owner' ? this.store.get(id) : this.find(by, id);
    if (!d) throw new MemoryError('not_found', `No discussion with id "${id}".`, undefined, { key: 'err.disc.notFound', params: { id } });
    // The decision becomes a memory, which a discussions-only connection must never write (checked after find, so a
    // hidden discussion still answers not_found).
    if (by !== 'owner' && by.access === 'discussions') {
      throw new MemoryError('invalid', 'Only the owner can close this discussion: they record the decision on the memory dashboard.', undefined, { key: 'err.disc.ownerOnlyClose' });
    }
    const pending = this.closing.get(id);
    if (pending) {
      if (pending.decision === a.decision) return pending.done;
      throw new MemoryError('invalid', 'This discussion is already being closed with another decision.', undefined, { key: 'err.disc.closingOther' });
    }
    if (d.closedAt) {
      if (d.decision === a.decision && d.decisionMemoryId) return { memoryId: d.decisionMemoryId, project: this.memory.get(d.decisionMemoryId)?.project ?? d.project };
      throw new MemoryError('invalid', 'This discussion is already closed.', undefined, { key: 'err.disc.alreadyClosed' });
    }
    const done = this.closeNow(by, d, a);
    this.closing.set(id, { decision: a.decision, done });
    try {
      return await done;
    } finally {
      this.closing.delete(id);
    }
  }

  private async closeNow(by: Caller | 'owner', d: Discussion, a: { decision: string; project?: string }): Promise<Closed> {
    const id = d.id;
    const decision = checkText('decision', a.decision, 100_000);
    const given = blankToUndefined(a.project);
    // The project chosen when opening wins; a different one asked for now is refused rather than silently dropped.
    // Both sides by their real name: a discussion opened under a folder name or an alias since merged still matches.
    const own = d.project === null ? null : this.memory.projectNamed(d.project);
    if (own !== null && given !== undefined && this.memory.projectNamed(given.trim()) !== own) {
      throw new MemoryError('invalid', `This discussion belongs to project ${own}, so its decision is saved there: leave project out to close it. `
        + 'To record the decision for another project too, save it there with remember.', undefined, { key: 'err.disc.otherProject', params: { own } });
    }
    const project = d.project ?? checkProject(given);
    // Titles from before the open-time check may read like instructions; the memory then names the discussion by id.
    const name = looksLikeInstruction(d.title) ? `discussion ${d.id}` : `discussion "${d.title}"`;
    const content = `Decision (${name}, ${localDay(this.now())}): ${decision}`;
    if (content.length > MAX_CONTENT) {
      throw new MemoryError('invalid', `The decision is too long: shorten it to ${Math.max(0, MAX_CONTENT - (content.length - decision.length))} characters.`, undefined, { key: 'err.disc.decisionLong', params: { n: Math.max(0, MAX_CONTENT - (content.length - decision.length)) } });
    }
    const actor = by === 'owner' ? { type: 'owner' as const } : { type: 'ai' as const, name: by.name };
    // An assistant's instruction-like decision is refused here rather than held as a suggestion: approving a suggestion
    // would save the memory but never close the discussion, and a retry or the owner's own close would add a copy.
    const reason = by === 'owner' ? null : looksLikeInstruction(content);
    if (reason) {
      throw new MemoryError('invalid', `The decision reads like an instruction to AI assistants (${reason}), so it was not saved and the discussion stays open: `
        + 'tell the owner, who can close it with this decision on the memory dashboard.', undefined, { key: 'err.disc.decisionInstr', params: { reason } });
    }
    // The project was chosen when the discussion was opened (or now, by whoever closes it): no new-name check.
    // A decision close to a fact the owner deleted (§17a) is refused for the same reason: a held one would never close it.
    const refuseDeleted = (day: string) => `The decision is close to a fact the owner deleted on ${day}, so it was not saved and the discussion stays open: `
      + 'tell the owner, who can close it with this decision on the memory dashboard.';
    const r = await this.memory.remember({ kind: 'decision', content, project: project ?? undefined, tags: ['discussion'], allowDuplicate: true, newProject: true, refuseDeleted }, actor);
    if (r.status !== 'saved') throw new MemoryError('invalid', 'The decision could not be saved.', undefined, { key: 'err.disc.decisionNotSaved' });
    this.store.transaction(() => {
      if (this.store.get(id)?.closedAt) throw new MemoryError('invalid', 'This discussion is already closed.', undefined, { key: 'err.disc.alreadyClosed' });
      this.store.close(id, decision, r.memory.id);
    });
    return { memoryId: r.memory.id, project: r.memory.project };
  }

  /** Owner note in the current round; every caller sees it. */
  addNote(id: string, text: string): Post {
    const d = this.openOne(id);
    return this.store.addPost({ discussionId: id, round: d.round, kind: 'note', author: 'owner', model: '', text: checkText('note', text, MAX_TEXT), grantId: null });
  }

  nextRound(id: string): number {
    return this.store.transaction(() => {
      const d = this.openOne(id);
      this.store.setRound(id, d.round + 1);
      return d.round + 1;
    });
  }

  setAsk(id: string, ask: string[]): void {
    this.openOne(id);
    this.store.setAsk(id, this.askList({ name: '' }, ask, true));
  }

  /** Open or closed: the owner may hide a decided discussion from discussions-only connections too. */
  setIncludeLimited(id: string, include: boolean): void {
    if (!this.store.get(id)) throw new MemoryError('not_found', `No discussion with id "${id}".`, undefined, { key: 'err.disc.notFound', params: { id } });
    this.store.setIncludeLimited(id, include);
  }

  remove(id: string): void {
    if (!this.store.get(id)) throw new MemoryError('not_found', `No discussion with id "${id}".`, undefined, { key: 'err.disc.notFound', params: { id } });
    this.store.softDelete(id);
  }

  /** Everything, no blind filtering: for the owner's dashboard only. */
  ownerView(id: string): OwnerDiscussionView {
    const d = this.store.get(id);
    if (!d) throw new MemoryError('not_found', `No discussion with id "${id}".`, undefined, { key: 'err.disc.notFound', params: { id } });
    const posts = this.store.posts(id);
    const replies = posts.filter((p) => p.kind === 'reply');
    const closed = d.closedAt !== null;
    return {
      ...this.summary(DiscussionService.OWNER, d, posts), question: d.question, openedBy: d.openedBy, files: this.store.files(id).map((f) => markedFile(this.store, id, f)), ...questionMark(d.question),
      notes: posts.filter((p) => p.kind === 'note').map(publicPost), replies: markInstructions(replies.map(publicPost)), hidden: 0, decision: d.decision, callerIsOpener: false,
      stage: closed ? 'closed' : d.round === 1 ? 'blind' : 'respond',
      ask: d.ask, includeLimited: d.includeLimited, openedAt: d.openedAt, closedAt: d.closedAt, decisionMemoryId: d.decisionMemoryId,
    };
  }

  ownerList(): OwnerSummary[] {
    return this.store.list({ status: 'all', includeLimitedOnly: false })
      .map((d) => ({ ...this.summary(DiscussionService.OWNER, d, this.store.posts(d.id)), closedAt: d.closedAt }));
  }

  /** Every live discussion's id and title, in the Discussions list's order (open first, newest first): the home's shelf. */
  ownerTitles(): { id: string; title: string }[] {
    return this.store.list({ status: 'all', includeLimitedOnly: false }).map((d) => ({ id: d.id, title: d.title }));
  }

  /** A live discussion that saved this decision, if any. Deleted discussions stay hidden. */
  decidedIn(memoryId: string): { id: string; title: string } | undefined {
    const d = this.store.list({ status: 'all', includeLimitedOnly: false })
      .find((row) => row.decisionMemoryId === memoryId);
    return d ? { id: d.id, title: d.title } : undefined;
  }

  /** The text of an attached file, no caller checks: for the owner's dashboard only. */
  ownerFile(id: string, name: string): string {
    if (!this.store.get(id)) throw new MemoryError('not_found', `No discussion with id "${id}".`, undefined, { key: 'err.disc.notFound', params: { id } });
    const content = this.store.fileContent(id, name);
    if (content === undefined) throw new MemoryError('not_found', `No file "${name}" in this discussion.`, undefined, { key: 'err.disc.fileNotFound', params: { name } });
    return content;
  }

  /** Open discussions whose round every asked assistant has answered, so they wait on the owner (as the project panel's needsYou). */
  waitingOnOwner(): { id: string; title: string }[] {
    return this.store.list({ status: 'open', includeLimitedOnly: false })
      .filter((d) => this.summary(DiscussionService.OWNER, d, this.store.posts(d.id)).waitingFor.length === 0)
      .map((d) => ({ id: d.id, title: d.title }));
  }

  openCount(): number {
    return this.store.list({ status: 'open', includeLimitedOnly: false }).length;
  }
}
