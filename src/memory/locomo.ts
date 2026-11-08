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
export interface Question { question: string; evidence: string[]; category: number }
export interface Conversation { id: string; turns: Turn[]; qa: Question[] }
export interface Score { questions: number; hit1: number; hit5: number; hit10: number; mrr: number }

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
    const qa = (s.qa as any[]).map((q): Question => ({ question: String(q.question), evidence: (q.evidence ?? []).map((e: unknown) => cleanId(String(e))), category: Number(q.category) }));
    return { id: String(s.sample_id), turns, qa };
  });
}

/** Hits at 1, 5 and 10 (as fractions) and the mean reciprocal rank, overall and per category. */
export function scoreRecall(results: { category: number; rank: number | null }[]): { overall: Score; byCategory: Record<number, Score> } {
  const score = (rs: { rank: number | null }[]): Score => {
    const n = rs.length;
    const frac = (k: number) => (n === 0 ? 0 : rs.filter((r) => r.rank !== null && r.rank <= k).length / n);
    return { questions: n, hit1: frac(1), hit5: frac(5), hit10: frac(10), mrr: n === 0 ? 0 : rs.reduce((a, r) => a + (r.rank === null ? 0 : 1 / r.rank), 0) / n };
  };
  const byCategory: Record<number, Score> = {};
  for (const c of [...new Set(results.map((r) => r.category))].sort()) byCategory[c] = score(results.filter((r) => r.category === c));
  return { overall: score(results), byCategory };
}

/**
 * One conversation in a fresh brain: each turn saved as one fact (by the owner, so no duplicate checks hold it), then
 * each answerable question recalled with `limit` results; rank is where the first turn of its evidence came (null: not
 * in the results). Adversarial questions and questions without evidence are counted and skipped.
 */
export async function benchConversation(c: Conversation, service: MemoryService, opts: { limit?: number; project?: string } = {}): Promise<{
  saved: number; skipped: { adversarial: number; noEvidence: number; unsaved: number }; results: { category: number; rank: number | null }[];
}> {
  const limit = opts.limit ?? 10;
  const project = opts.project ?? 'locomo';
  const diaOf = new Map<string, string>();
  let unsaved = 0;
  for (const t of c.turns) {
    try {
      const r = await service.remember({ kind: 'decision', content: t.text, project, allowDuplicate: true, newProject: true }, { type: 'owner' });
      if (r.status === 'saved') diaOf.set(r.memory.id, t.diaId); else unsaved++;
    } catch (e) {
      if (!(e instanceof MemoryError)) throw e;
      unsaved++; // too long, or it looks like a secret
    }
  }
  const skipped = { adversarial: 0, noEvidence: 0, unsaved };
  const results: { category: number; rank: number | null }[] = [];
  for (const q of c.qa) {
    if (q.category === 5) { skipped.adversarial++; continue; }
    if (q.evidence.length === 0) { skipped.noEvidence++; continue; }
    const wanted = new Set(q.evidence);
    const hits = await service.recall({ query: q.question, project, limit, touch: false });
    const at = hits.findIndex((h) => wanted.has(diaOf.get(h.memory.id) ?? ''));
    results.push({ category: q.category, rank: at < 0 ? null : at + 1 });
  }
  return { saved: diaOf.size, skipped, results };
}
