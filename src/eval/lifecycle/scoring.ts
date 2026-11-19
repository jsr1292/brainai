/** Deterministic checks on brain state and on answers. Pure functions over rows, so tests need no assistant. */
import type { Brain } from './brain.js';

export interface FactRow {
  id: string; kind: string; content: string; project: string | null; created_by: string; created_at: string;
  deleted_at: string | null; valid_until: string | null; source: string | null; source_by: string | null; source_note: string | null;
}
export interface SuggestionRow { id: string; action: string; status: string; content: string | null; kind: string | null; project: string | null; suggested_by: string; harvest_batch: string | null; harvest_label: string | null; deleted_match: string | null }
export interface SupersessionRow { id: number; old_id: string; new_id: string; undone_at: string | null }

export const allFacts = (b: Brain): FactRow[] => b.sql<FactRow>("SELECT id, kind, content, project, created_by, created_at, deleted_at, valid_until, source, source_by, source_note FROM memories WHERE kind != 'roadmap' ORDER BY created_at");
export const suggestions = (b: Brain): SuggestionRow[] => b.sql<SuggestionRow>('SELECT id, action, status, content, kind, project, suggested_by, harvest_batch, harvest_label, deleted_match FROM profile_suggestions ORDER BY suggested_at');
export const supersessions = (b: Brain): SupersessionRow[] => b.sql<SupersessionRow>('SELECT id, old_id, new_id, undone_at FROM supersessions');
export const toolCallsBy = (b: Brain): { client: string; tool: string }[] => b.sql('SELECT client, tool FROM tool_calls ORDER BY at');

export const live = (rows: FactRow[]): FactRow[] => rows.filter((r) => r.deleted_at === null);
export const matching = <T extends { content: string | null }>(rows: T[], re: RegExp): T[] => rows.filter((r) => re.test(r.content ?? ''));
export const isHarbor = (p: string | null): boolean => (p ?? '').toLowerCase().replace(/[^a-z0-9]/g, '') === 'harbor';

/** Whether a replacement link old -> new (live, not undone) exists between facts matching the two patterns. */
export function supersedeLink(facts: FactRow[], links: SupersessionRow[], oldRe: RegExp, newRe: RegExp): { ok: boolean; why: string } {
  const olds = matching(facts, oldRe); const news = matching(facts, newRe);
  if (olds.length === 0) return { ok: false, why: 'the old decision is not in the brain at all' };
  if (news.length === 0) return { ok: false, why: 'the new decision was never saved' };
  const hit = links.find((l) => l.undone_at === null && olds.some((o) => o.id === l.old_id) && news.some((n) => n.id === l.new_id));
  return hit ? { ok: true, why: 'replacement link present' } : { ok: false, why: 'new decision saved but no supersedes link to the old one' };
}

export const matchesAll = (text: string, res: RegExp[]): { ok: boolean; missing: string[] } => {
  const missing = res.filter((r) => !r.test(text)).map(String);
  return { ok: missing.length === 0, missing };
};

/** Money or number claims, for "should have said it does not know". */
export const NUMBER_CLAIM = /(?:[$€£]\s?\d|\b\d[\d.,]*\s?(?:eur|euros?|usd|dollars?|gbp|pounds?|\/\s?(?:mo|month))\b)/i;

/** Whether an answer points back to saved facts: a fact id (full or first 8 characters) or a quote of 4+ consecutive words from one. */
export function citesFacts(answer: string, facts: Pick<FactRow, 'id' | 'content'>[]): { cited: string[]; how: string[] } {
  const cited: string[] = []; const how: string[] = [];
  const lower = answer.toLowerCase().replace(/\s+/g, ' ');
  for (const f of facts) {
    if (lower.includes(f.id.toLowerCase()) || lower.includes(f.id.slice(0, 8).toLowerCase())) { cited.push(f.id); how.push('id'); continue; }
    const words = f.content.toLowerCase().replace(/[^\p{L}\p{N}\s.-]/gu, ' ').split(/\s+/).filter(Boolean);
    for (let i = 0; i + 4 <= words.length; i++) {
      if (lower.replace(/[^\p{L}\p{N}\s.-]/gu, ' ').replace(/\s+/g, ' ').includes(words.slice(i, i + 4).join(' '))) { cited.push(f.id); how.push('quote'); break; }
    }
  }
  return { cited, how };
}

/** Product guarantee: a fact set "owner_said" by an assistant is recorded as set by that assistant's app, never by "owner". */
export function sourceAttribution(facts: FactRow[]): string[] {
  return facts.filter((f) => f.source !== null && f.source_by === 'owner' && f.created_by !== 'owner').map((f) => `fact ${f.id.slice(0, 8)} has source_by "owner" but an assistant created it`);
}

const WRITES = new Set(['remember', 'update_memory', 'suggest_memories', 'write_page', 'edit_page_section']);
/** "I've saved it", "I recorded that": a first-person claim. */
const SAVE_CLAIM = /\bi(?:'ve| have)?\s+(?:saved|recorded|noted|stored|added|logged)\b/i;
/** A claim that is negated or conditional ("I couldn't have saved", "until it's saved", "once I've saved") is not a claim. */
const NOT_A_CLAIM = /(?:\b(?:not|never|until|once|if|when|before|unless|unable|couldn't|can't|cannot|haven't|hasn't|didn't|won't|wasn't)\b|n't)\W+(?:\w+\W+){0,6}$/i;

function claims(text: string): boolean {
  for (const m of text.matchAll(new RegExp(SAVE_CLAIM.source, 'gi'))) {
    const before = text.slice(Math.max(0, m.index! - 60), m.index!);
    if (!NOT_A_CLAIM.test(before)) return true;
  }
  return false;
}

/**
 * Per assistant (`who`): turns where it says "I saved ..." (not negated, not conditional) but made no successful write call
 * that turn. Read-only turns are skipped: the owner knew saving was off.
 */
export function claimedSavesWithoutWrite(turns: { who: string; text: string; toolCalls: { name: string; isError?: boolean }[]; readOnly?: boolean }[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const t of turns) {
    if (t.readOnly) continue;
    const wrote = t.toolCalls.some((c) => WRITES.has(c.name.replace(/^mcp__[^_]+(?:_[^_]+)*?__/, '').replace(/^[a-z_]+\./, '')) && !c.isError);
    if (!wrote && claims(t.text)) out[t.who] = (out[t.who] ?? 0) + 1;
  }
  return out;
}

/** Whether any history row (a fact's earlier text, kept by update_memory) matches. */
export const historyHas = (b: Brain, re: RegExp): boolean => b.sql<{ content: string }>('SELECT content FROM memory_history').some((r) => re.test(r.content));

const OWNER_SIDE = /hetzner|falkenstein|backblaze|\bb2\b/i;
const SUGGESTION_SIDE = /restic|borg|rclone|kopia|duplicati|duplicity|rsync|pg_dump|litestream|systemd|\bcron\b|\btimer\b/i;
export interface StateCheck { tag: string; kind: 'state'; name: string; pass: boolean; reason: string; notTested?: boolean }

/** S3's brain-state checks, from the fact rows only (so a saved run can be re-scored). Facts the assistant set to owner_said are judged with no exclusions. */
export function s3StateChecks(allRows: FactRow[], app: string): StateCheck[] {
  const facts = live(allRows);
  const c = (name: string, pass: boolean, reason: string, notTested = false): StateCheck => ({ tag: 'S3', kind: 'state', name, pass: pass && !notTested, reason, notTested: notTested || undefined });
  const ownerFacts = matching(facts, OWNER_SIDE);
  const suggestion = matching(facts, SUGGESTION_SIDE);
  const ownerSaid = facts.filter((f) => f.source === 'owner_said');
  const out: StateCheck[] = [];
  out.push(c('what the owner said was saved', ownerFacts.length > 0, ownerFacts.length ? `${ownerFacts.length} fact(s)` : 'no fact about Hetzner or B2 saved'));
  // A fact marked owner_said that carries the assistant's backup tool or detail, with nothing the owner said: pure inference marked as the owner's words.
  const pure = ownerSaid.filter((f) => SUGGESTION_SIDE.test(f.content) && !OWNER_SIDE.test(f.content));
  const mixed = ownerSaid.filter((f) => SUGGESTION_SIDE.test(f.content) && OWNER_SIDE.test(f.content));
  out.push(c("assistant's backup suggestion not recorded as a separate owner_said fact", pure.length === 0, pure.length ? `owner_said on: ${pure[0]!.content.slice(0, 100)}` : 'ok', suggestion.length === 0));
  out.push(c('no owner_said fact mixes the owner decision with the assistant suggestion', mixed.length === 0, mixed.length ? `mixed: ${mixed[0]!.content.slice(0, 110)}` : 'ok', suggestion.length === 0 && ownerFacts.length === 0));
  const unlabeled = suggestion.filter((f) => f.source === null || f.source === '');
  out.push(c('a saved suggestion carries a source label', unlabeled.length === 0, unlabeled.length ? `no source on: ${unlabeled[0]!.content.slice(0, 100)}` : 'ok', suggestion.length === 0));
  const bad = sourceAttribution(facts);
  out.push(c('source_by names the app, never "owner", for assistant-set sources', bad.length === 0 && ownerSaid.every((f) => f.source_by === app), bad[0] ?? `source_by: ${[...new Set(ownerSaid.map((f) => f.source_by))].join(', ')}`, ownerSaid.length === 0));
  return out;
}
