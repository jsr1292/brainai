/**
 * The LongMemEval recall benchmark (A3): how often BrainAI's search puts the session (and the turn) that holds the
 * answer among its first results, out of the ~50 sessions of one user's chat history. Retrieval only — no model writes
 * or judges an answer — so it is not comparable to end-to-end LongMemEval scores. The data (LongMemEval_S, cleaned,
 * Wu et al., MIT) is downloaded at run time by src/scripts/benchLongMemEval.ts and never kept in the repository.
 */
import { createHash } from 'node:crypto';
import { MemoryError, type MemoryService } from './service.js';

/** The one version of the data this benchmark scores: its revision in the Hugging Face dataset and its SHA-256. */
export const LME_REVISION = '98d7416c24c778c2fee6e6f3006e7a073259d48f';
export const LME_URL = `https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/${LME_REVISION}/longmemeval_s_cleaned.json`;
export const LME_SHA256 = 'd6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442';

export function checkLmePinned(bytes: Uint8Array, expected = LME_SHA256): void {
  const got = createHash('sha256').update(bytes).digest('hex');
  if (got !== expected) throw new Error(`The LongMemEval data does not match the pinned version (SHA-256 ${got}, expected ${expected}): delete the cached copy and run again.`);
}

export interface LmeTurn { role: string; content: string; hasAnswer: boolean }
export interface LmeQuestion {
  id: string; type: string; question: string; questionDate: string;
  answerSessions: string[]; sessionIds: string[]; dates: string[]; sessions: LmeTurn[][];
}
/** Hits as fractions; 8 is recall's default number of results and 20 its most. */
export interface LmeScore { questions: number; hit1: number; hit8: number; hit20: number; all8: number; all20: number; turn1: number; turn8: number; turn20: number; mrr: number; weak: number; empty: number }
export interface LmeResult {
  id: string; category: string;
  /** Rank of the first result in an answer session / holding an answer turn / when every answer session is covered. */
  rank: number | null; turnRank: number | null; allRank: number | null;
  /** Recall returned nothing, or its weak-match warning (the server's own cut-off) would have been shown. */
  empty: boolean; weak: boolean; facts: number;
}

/** The categories: LongMemEval's question types, with its abstention questions (ids ending _abs) as their own. */
export const LME_CATEGORIES = ['single-session-user', 'single-session-assistant', 'single-session-preference', 'multi-session', 'knowledge-update', 'temporal-reasoning', 'abstention'];
export const categoryOf = (q: { id: string; type: string }): string => (q.id.endsWith('_abs') ? 'abstention' : q.type);

export function parseLongMemEval(json: string): LmeQuestion[] {
  let data: unknown;
  try { data = JSON.parse(json); } catch { throw new Error('The LongMemEval file is not valid JSON'); }
  if (!Array.isArray(data) || !data.every((q) => q && typeof q === 'object' && 'haystack_sessions' in q && 'answer_session_ids' in q)) {
    throw new Error('This is not the LongMemEval data: expected a list of questions with "haystack_sessions" and "answer_session_ids"');
  }
  return data.map((q: any): LmeQuestion => ({
    id: String(q.question_id), type: String(q.question_type), question: String(q.question), questionDate: String(q.question_date ?? ''),
    answerSessions: (q.answer_session_ids ?? []).map(String), sessionIds: q.haystack_session_ids.map(String), dates: q.haystack_dates.map(String),
    sessions: q.haystack_sessions.map((s: any[]) => s.map((t) => ({ role: String(t.role), content: String(t.content), hasAnswer: t.has_answer === true }))),
  }));
}

/** At most `max` characters per piece, cut at a paragraph, line, sentence or word end where one is near the limit. */
export function splitText(text: string, max: number): string[] {
  const out: string[] = [];
  let rest = text.trim();
  while (rest.length > max) {
    const window = rest.slice(0, max);
    let cut = -1;
    for (const sep of ['\n\n', '\n', '. ', ' ']) {
      const at = window.lastIndexOf(sep);
      if (at > max * 0.5) { cut = at + sep.length; break; }
    }
    if (cut < 0) cut = max;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}

export interface LmeFact { text: string; sessionId: string; turn: number; hasAnswer: boolean; date: string }
/**
 * One fact per turn ("User on 2023/05/20 (Sat) 02:21: ..."), the way LoCoMo's turns are saved; a turn over the
 * 1,000-character fact limit is cut into several facts, each starting with the same speaker and date.
 */
export function factsOf(q: LmeQuestion, max = 1000): LmeFact[] {
  const facts: LmeFact[] = [];
  q.sessions.forEach((session, s) => {
    const sessionId = q.sessionIds[s]!, date = q.dates[s] ?? '';
    session.forEach((t, turn) => {
      const prefix = `${t.role === 'user' ? 'User' : t.role === 'assistant' ? 'Assistant' : t.role} on ${date}: `;
      for (const piece of splitText(t.content, max - prefix.length)) facts.push({ text: prefix + piece, sessionId, turn, hasAnswer: t.hasAnswer, date });
    });
  });
  return facts;
}

/** Ranks of one question from recall's results (each a fact index; null where the fact is not one of the question's). */
export function rankResults(hits: (LmeFact | undefined)[], answerSessions: string[]): { rank: number | null; turnRank: number | null; allRank: number | null } {
  const wanted = new Set(answerSessions);
  const first = (ok: (f: LmeFact) => boolean) => { const i = hits.findIndex((h) => h !== undefined && ok(h)); return i < 0 ? null : i + 1; };
  const covered = new Set<string>();
  let allRank: number | null = null;
  hits.forEach((h, i) => {
    if (allRank !== null || !h || !wanted.has(h.sessionId)) return;
    covered.add(h.sessionId);
    if (covered.size === wanted.size) allRank = i + 1;
  });
  return { rank: first((f) => wanted.has(f.sessionId)), turnRank: first((f) => f.hasAnswer), allRank };
}

/** Per category and overall: hits at 1, 8 and 20 by session, turn and (all answer sessions), MRR, and how often recall found nothing or only a weak match. */
export function scoreLme(results: LmeResult[]): { overall: LmeScore; byCategory: Record<string, LmeScore> } {
  const score = (rs: LmeResult[]): LmeScore => {
    const n = rs.length;
    const frac = (f: (r: LmeResult) => boolean) => (n === 0 ? 0 : rs.filter(f).length / n);
    const within = (pick: (r: LmeResult) => number | null, k: number) => frac((r) => { const x = pick(r); return x !== null && x <= k; });
    return {
      questions: n, hit1: within((r) => r.rank, 1), hit8: within((r) => r.rank, 8), hit20: within((r) => r.rank, 20),
      all8: within((r) => r.allRank, 8), all20: within((r) => r.allRank, 20),
      turn1: within((r) => r.turnRank, 1), turn8: within((r) => r.turnRank, 8), turn20: within((r) => r.turnRank, 20),
      mrr: n === 0 ? 0 : rs.reduce((a, r) => a + (r.rank === null ? 0 : 1 / r.rank), 0) / n,
      weak: frac((r) => r.weak), empty: frac((r) => r.empty),
    };
  };
  const byCategory: Record<string, LmeScore> = {};
  for (const c of LME_CATEGORIES) { const rs = results.filter((r) => r.category === c); if (rs.length) byCategory[c] = score(rs); }
  return { overall: score(results), byCategory };
}

/** A LongMemEval date ("2023/05/20 (Sat) 02:21") as that moment in UTC; null when it can't be read. */
export function lmeDate(s: string): Date | null {
  const m = /(\d{4})\/(\d{2})\/(\d{2}).*?(\d{2}):(\d{2})/.exec(s);
  return m ? new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!)) : null;
}

/** An evenly spread sample: `n` per category (all of it when smaller), the first of each in file order after a fixed stride. */
export function stratified(qs: LmeQuestion[], n: number): LmeQuestion[] {
  const out: LmeQuestion[] = [];
  for (const c of LME_CATEGORIES) {
    const of = qs.filter((q) => categoryOf(q) === c);
    const step = of.length / Math.min(n, of.length);
    for (let i = 0; i < Math.min(n, of.length); i++) out.push(of[Math.floor(i * step)]!);
  }
  return out;
}

/**
 * One question in a fresh brain: every turn of its history saved as a fact (by the owner, so no duplicate checks hold
 * it), then the question asked through recall with `limit` results and the server's weak-match cut-off `weakBelow`.
 * `dated`: the brain's clock is set to each session's time while saving and to the question's date while asking.
 */
export async function benchQuestion(q: LmeQuestion, service: MemoryService, opts: {
  limit?: number; weakBelow: number; dated?: (d: Date | null) => void; project?: string;
}): Promise<LmeResult & { unsaved: number }> {
  const limit = opts.limit ?? 20;
  const project = opts.project ?? 'lme';
  const byId = new Map<string, LmeFact>();
  let unsaved = 0;
  for (const f of factsOf(q)) {
    if (opts.dated) opts.dated(lmeDate(f.date));
    try {
      const r = await service.remember({ kind: 'decision', content: f.text, project, allowDuplicate: true, newProject: true }, { type: 'owner' });
      if (r.status === 'saved') byId.set(r.memory.id, f); else unsaved++;
    } catch (e) {
      if (!(e instanceof MemoryError)) throw e;
      unsaved++;
    }
  }
  if (opts.dated) opts.dated(lmeDate(q.questionDate));
  let best: number | null = null;
  const hits = await service.recall({ query: q.question, project, limit, touch: false, readTime: true, report: (r) => { best = r.bestScore; } });
  opts.dated?.(null);
  const ranks = rankResults(hits.map((h) => byId.get(h.memory.id)), q.answerSessions);
  return { id: q.id, category: categoryOf(q), ...ranks, empty: hits.length === 0, weak: hits.length > 0 && best !== null && best < opts.weakBelow, facts: byId.size, unsaved };
}
