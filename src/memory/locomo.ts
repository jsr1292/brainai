/**
 * The LoCoMo recall benchmark (B1): how often BrainAI's search puts the part of a long conversation that answers a
 * question among its first results. Retrieval only — no model writes or judges an answer — so its numbers are not
 * comparable to end-to-end, model-judged LoCoMo scores. The data (snap-research/locomo, locomo10.json) is downloaded
 * at run time by src/scripts/benchLocomo.ts and never kept in the repository.
 */
import { createHash } from 'node:crypto';
import { MemoryError, type MemoryService } from './service.js';

/** The one version of the data this benchmark scores: its commit in snap-research/locomo and its SHA-256. */
export const LOCOMO_COMMIT = 'cbfbc1dba6bc53d00625212a0f22d55ffee7c1fc';
export const LOCOMO_URL = `https://raw.githubusercontent.com/snap-research/locomo/${LOCOMO_COMMIT}/data/locomo10.json`;
export const LOCOMO_SHA256 = '79fa87e90f04081343b8c8debecb80a9a6842b76a7aa537dc9fdf651ea698ff4';

/** Throws unless these bytes are exactly the pinned data: a changed download is refused, never scored. */
export function checkPinned(bytes: Uint8Array, expected = LOCOMO_SHA256): void {
  const got = createHash('sha256').update(bytes).digest('hex');
  if (got !== expected) throw new Error(`The LoCoMo data does not match the pinned version (SHA-256 ${got}, expected ${expected}): delete the cached copy and run again.`);
}

export interface Turn { diaId: string; speaker: string; date: string; text: string }
export interface Question { id: string; question: string; evidence: string[]; category: number }
export interface Conversation { id: string; turns: Turn[]; qa: Question[] }
/** Hits as fractions; 8 is recall's default number of results and 20 its most. */
export interface Score { questions: number; hit1: number; hit5: number; hit8: number; hit10: number; hit20: number; mrr: number }

/** LoCoMo's question categories, as its evaluation code numbers them; 5 (adversarial: no answer exists) is not scored. */
export const CATEGORY_NAMES: Record<number, string> = { 1: 'multi-hop', 2: 'temporal', 3: 'open-domain', 4: 'single-hop', 5: 'adversarial' };

const cleanId = (id: string) => id.replace(/\s+/g, '');

export function parseLocomo(json: string): Conversation[] {
  let data: unknown;
  try { data = JSON.parse(json); } catch { throw new Error('The LoCoMo file is not valid JSON'); }
  if (!Array.isArray(data) || !data.every((s) => s && typeof s === 'object' && 'conversation' in s && 'qa' in s)) {
    throw new Error('This is not the LoCoMo data: expected a list of samples with "conversation" and "qa"');
  }
  return data.map((s: any): Conversation => {
    const conv = s.conversation as Record<string, unknown>;
    const sessions = Object.keys(conv).map((k) => /^session_(\d+)$/.exec(k)).filter((m): m is RegExpExecArray => m !== null)
      .map((m) => Number(m[1])).sort((a, b) => a - b);
    const turns: Turn[] = [];
    for (const n of sessions) {
      const when = String(conv[`session_${n}_date_time`] ?? '');
      const date = when.includes(' on ') ? when.slice(when.indexOf(' on ') + 4) : when;
      for (const t of conv[`session_${n}`] as any[]) {
        const photo = t.blip_caption ? ` [shares a photo: ${t.blip_caption}]` : '';
        turns.push({ diaId: cleanId(String(t.dia_id)), speaker: String(t.speaker), date, text: `${t.speaker} on ${date}: ${t.text}${photo}` });
      }
    }
    const qa = (s.qa as any[]).map((q, i): Question => ({ id: `${String(s.sample_id)}:${i}`, question: String(q.question), evidence: (q.evidence ?? []).map((e: unknown) => cleanId(String(e))), category: Number(q.category) }));
    return { id: String(s.sample_id), turns, qa };
  });
}

/**
 * The LoCoMo audit (dial481/locomo-audit, CC BY-NC 4.0): 156 errors in the answer key, 57 of them evidence that points
 * at the wrong turn. Downloaded at run time like the data, pinned to one commit and its SHA-256, never kept here.
 */
export const LOCOMO_AUDIT_COMMIT = '9493fb4b4af4256ed17a18e8fd0b3cfdeec29539';
export const LOCOMO_AUDIT_URL = `https://raw.githubusercontent.com/dial481/locomo-audit/${LOCOMO_AUDIT_COMMIT}/errors.json`;
export const LOCOMO_AUDIT_SHA256 = 'f298ef46263fada20688a1d672be37d4f488c6da3b19343eea55ae5c1b5fe55e';

/**
 * Replaces the evidence of every question the audit marks WRONG_CITATION with its corrected evidence. Its ids are
 * `locomo_<conversation index>_qa<question index>`; the entry's question text must be the question it names, so a
 * different version of either file is refused rather than scored wrongly. Other error types concern the answer, not
 * which turn holds it, and are left alone.
 */
export function applyAudit(convs: Conversation[], errorsJson: string): { fixed: number } {
  const entries = JSON.parse(errorsJson) as { question_id: string; question: string; error_type: string; correct_evidence?: string[] }[];
  let fixed = 0;
  for (const e of entries) {
    if (e.error_type !== 'WRONG_CITATION') continue;
    const m = /^locomo_(\d+)_qa(\d+)$/.exec(e.question_id);
    const q = m ? convs[Number(m[1])]?.qa[Number(m[2])] : undefined;
    if (!q || q.question.trim() !== e.question.trim() || !Array.isArray(e.correct_evidence)) {
      throw new Error(`The LoCoMo audit entry ${e.question_id} does not match the data's question: check the pinned versions.`);
    }
    q.evidence = e.correct_evidence.map((x) => cleanId(String(x)));
    fixed++;
  }
  return { fixed };
}

/** Hits at 1, 5, 8, 10 and 20 (as fractions) and the mean reciprocal rank, overall and per category. */
export function scoreRecall(results: { category: number; rank: number | null }[]): { overall: Score; byCategory: Record<number, Score> } {
  const score = (rs: { rank: number | null }[]): Score => {
    const n = rs.length;
    const frac = (k: number) => (n === 0 ? 0 : rs.filter((r) => r.rank !== null && r.rank <= k).length / n);
    return { questions: n, hit1: frac(1), hit5: frac(5), hit8: frac(8), hit10: frac(10), hit20: frac(20), mrr: n === 0 ? 0 : rs.reduce((a, r) => a + (r.rank === null ? 0 : 1 / r.rank), 0) / n };
  };
  const byCategory: Record<number, Score> = {};
  for (const c of [...new Set(results.map((r) => r.category))].sort()) byCategory[c] = score(results.filter((r) => r.category === c));
  return { overall: score(results), byCategory };
}

/**
 * The turns as facts: one per turn, or with `pack`, consecutive turns of one session joined by line breaks while
 * they fit in `pack` characters (long facts about several things, like a person's own notes).
 */
export function packTurns(turns: Turn[], pack = 0): { text: string; diaIds: string[] }[] {
  if (pack <= 0) return turns.map((t) => ({ text: t.text, diaIds: [t.diaId] }));
  const session = (t: Turn) => t.diaId.split(':')[0];
  const out: { text: string; diaIds: string[]; session: string | undefined }[] = [];
  for (const t of turns) {
    const last = out[out.length - 1];
    if (last && last.session === session(t) && last.text.length + 1 + t.text.length <= pack) {
      last.text += `\n${t.text}`;
      last.diaIds.push(t.diaId);
    } else out.push({ text: t.text, diaIds: [t.diaId], session: session(t) });
  }
  return out.map(({ text, diaIds }) => ({ text, diaIds }));
}

/**
 * One conversation in a fresh brain: each turn (or, with `pack`, each run of turns) saved as one fact (by the owner,
 * so no duplicate checks hold it), then each answerable question recalled with `limit` results; rank is where the first
 * fact holding a turn of its evidence came (null: not in the results). Adversarial questions and questions without evidence are counted and skipped.
 */
const EN_MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

/** A LoCoMo session date ("8 May, 2023") as that day at noon UTC; null when it can't be read. */
export function sessionDay(date: string): Date | null {
  const m = /(\d{1,2}) ([A-Za-z]+),? (\d{4})/.exec(date);
  const month = m ? EN_MONTHS.indexOf(m[2]!.toLowerCase()) : -1;
  return m && month >= 0 ? new Date(Date.UTC(+m[3]!, month, +m[1]!, 12)) : null;
}

/**
 * `dated` (B10): sets the brain's clock, so each turn is saved on its session's day and the questions are asked the
 * day after the last session, as if the conversation had just happened (time words then mean what they would).
 */
export async function benchConversation(c: Conversation, service: MemoryService, opts: { limit?: number; project?: string; pack?: number; dated?: (d: Date | null) => void } = {}): Promise<{
  saved: number; skipped: { adversarial: number; noEvidence: number; unsaved: number }; results: { id: string; category: number; rank: number | null }[];
}> {
  const limit = opts.limit ?? 10;
  const project = opts.project ?? 'locomo';
  const diaOf = new Map<string, string[]>();
  let unsaved = 0;
  const dayOf = new Map(c.turns.map((t) => [t.diaId, sessionDay(t.date)]));
  let last: Date | null = null;
  for (const t of packTurns(c.turns, opts.pack)) {
    if (opts.dated) { const d = dayOf.get(t.diaIds[0]!) ?? null; if (d) last = d; opts.dated(d ?? last); }
    try {
      const r = await service.remember({ kind: 'decision', content: t.text, project, allowDuplicate: true, newProject: true }, { type: 'owner' });
      if (r.status === 'saved') diaOf.set(r.memory.id, t.diaIds); else unsaved++;
    } catch (e) {
      if (!(e instanceof MemoryError)) throw e;
      unsaved++; // too long, or it looks like a secret
    }
  }
  if (opts.dated && last) opts.dated(new Date(last.getTime() + 86_400_000));
  const skipped = { adversarial: 0, noEvidence: 0, unsaved };
  const results: { id: string; category: number; rank: number | null }[] = [];
  for (const q of c.qa) {
    if (q.category === 5) { skipped.adversarial++; continue; }
    if (q.evidence.length === 0) { skipped.noEvidence++; continue; }
    const wanted = new Set(q.evidence);
    const hits = await service.recall({ query: q.question, project, limit, touch: false, readTime: true });
    const at = hits.findIndex((h) => (diaOf.get(h.memory.id) ?? []).some((d) => wanted.has(d)));
    results.push({ id: q.id, category: q.category, rank: at < 0 ? null : at + 1 });
  }
  opts.dated?.(null);
  return { saved: diaOf.size, skipped, results };
}
