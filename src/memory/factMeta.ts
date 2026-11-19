import { isDay, todayIn } from './timeRange.js';
import { looksLikeInstruction } from './instructionLike.js';
import { looksLikeSecret } from './secrets.js';
import { OWNER_LABEL, SOURCES, type FactMeta, type Source } from './types.js';

/*
 * A1 (valid_until) and A2 (source, source_note): optional fields of a fact. They are never embedded, never in the
 * keyword index, never hide a fact and never change ranking; views and tool results only show them.
 */

export const MAX_SOURCE_NOTE = 200;

/** What a writer gives: undefined keeps the stored value; null or '' clears it. */
export interface MetaInput { validUntil?: string | null; source?: string | null; sourceNote?: string | null }

export const NO_META: FactMeta = { validUntil: null, source: null, sourceNote: null, sourceBy: null };

export class MetaError extends Error {}

/** Past its date: strictly before today (the owner's calendar day, as everywhere else). The last day itself is still valid. */
export const isPastDate = (validUntil: string | null, now: Date): boolean => validUntil !== null && validUntil < todayIn(now);

export const MAX_SOURCE_BY = 100;
const asApp = (by: string | null | undefined): string => (by && by !== OWNER_LABEL ? by : 'an assistant');
const cap = (t: string): string => t.charAt(0).toUpperCase() + t.slice(1);

/**
 * Where a fact came from, in words, by who set the source (the owner, or an assistant's app name). Only the owner
 * saying so is "You said this"; an assistant's claim that the owner said it is always shown as the assistant's.
 */
export function sourceLabel(source: Source, by: string | null | undefined): string {
  if (by === OWNER_LABEL) return { owner_said: 'You said this', inferred: 'Inferred', imported: 'Imported', from_file: 'From a file' }[source];
  const app = asApp(by);
  switch (source) {
    case 'owner_said': return `${cap(app)} says you said this`;
    case 'inferred': return `Inferred by ${app}`;
    case 'imported': return `Imported by ${app}`;
    case 'from_file': return `From a file (${app})`;
  }
}

/** What the owner sees for a source, with the owner's words when an assistant says the owner said it: Claude Code says you said: “...”. */
export function sourceText(source: Source, by: string | null | undefined, note: string | null | undefined): string {
  if (source === 'owner_said' && by !== OWNER_LABEL && note) return `${cap(asApp(by))} says you said: “${note}”`;
  return sourceLabel(source, by);
}

export const isSource = (s: unknown): s is Source => typeof s === 'string' && (SOURCES as readonly string[]).includes(s);

/** Cleans one date: '' or null clears (null); anything else must be a real calendar day. */
function checkDate(v: string): string | null {
  const d = v.trim();
  if (d === '') return null;
  if (!isDay(d)) throw new MetaError(`valid_until must be a real date as YYYY-MM-DD, such as 2026-12-31 (you sent ${JSON.stringify(v.slice(0, 40))}); an empty string clears it.`);
  return d;
}

function checkSource(v: string): Source | null {
  const s = v.trim();
  if (s === '') return null;
  if (!isSource(s)) throw new MetaError(`source must be one of: ${SOURCES.join(', ')} (or null or "" to clear it).`);
  return s;
}

function checkNote(v: string, fromAi: boolean): string | null {
  if (/[\r\n\v\f\u0085]/.test(v) || v.includes(String.fromCharCode(0x2028)) || v.includes(String.fromCharCode(0x2029))) throw new MetaError('source_note must be one line of plain text (no line breaks).');
  const n = v.trim();
  if (n === '') return null;
  if (n.length > MAX_SOURCE_NOTE) throw new MetaError(`source_note is ${n.length} characters; the limit is ${MAX_SOURCE_NOTE}.`);
  const secret = looksLikeSecret(n);
  if (secret) throw new MetaError(`source_note looks like a secret (${secret}). Secrets are never stored in memory.`);
  if (fromAi) {
    const reason = looksLikeInstruction(n);
    if (reason) throw new MetaError(`source_note reads like an instruction to AI assistants (${reason}). Keep it to a short quote or a session label.`);
  }
  return n;
}

/**
 * The fact's fields after a change: `input` over `current`. Clearing the source clears its note, and a note needs a
 * source. A source given now is set by `by` (the actor); one left alone keeps who set it. Throws MetaError with a plain message.
 */
export function resolveMeta(current: FactMeta, input: MetaInput, fromAi: boolean, by: string | null = null): FactMeta {
  const validUntil = input.validUntil === undefined ? current.validUntil : input.validUntil === null ? null : checkDate(input.validUntil);
  const source = input.source === undefined ? current.source : input.source === null ? null : checkSource(input.source);
  let note = input.sourceNote === undefined ? current.sourceNote : input.sourceNote === null ? null : checkNote(input.sourceNote, fromAi);
  if (source === null) {
    if (input.sourceNote !== undefined && note !== null && input.source === undefined && current.source === null) {
      throw new MetaError('source_note needs a source: give source too.');
    }
    note = null;
  }
  const sourceBy = source === null ? null : input.source === undefined || input.source === null ? current.sourceBy : by;
  return { validUntil, source, sourceNote: note, sourceBy };
}

/** What an assistant's change decided: the fields after it, and whether the source (with who set it) and the note really changed. */
export interface AiMetaResult { meta: FactMeta; changedSource: boolean; changedNote: boolean }

/**
 * The quote invariant, for an assistant's change (`input` over `current`, `by` = its app). `current` is the fact as
 * stored (for a held follow-up: the base the change applies to); `contentChanged`: the text differs from that base;
 * a claim is made now when source or source_note is given in this call.
 * A. A source the owner set, on unchanged text: the assistant cannot change its note, and re-stating the same source
 *    is a no-op (note and who set it stay the owner's). Another explicit source, or clearing it, goes through.
 *    On new text, an owner_said the owner set is cleared unless the assistant gives its own source (and quote); the
 *    owner's note is never changed by an assistant that leaves the source alone.
 * B. When a claim is made now or the text changed, and the result is an owner_said the owner did not set: it holds
 *    only with a non-empty source_note given in this call (and the source given now, or already this assistant's own).
 *    Else it is 'inferred' by this assistant with the note given now, or none: never an older quote.
 * C. No claim and unchanged text: the existing source (anyone's) is left alone.
 * The caller (a held save) records only what changed here, so approval gives the same fact as the direct path.
 */
export function resolveAiMeta(current: FactMeta, input: MetaInput, by: string | null, contentChanged: boolean): AiMetaResult {
  const inp: MetaInput = { ...input };
  const given = typeof inp.source === 'string' ? inp.source.trim() : inp.source;
  const sameSource = typeof given === 'string' && given === current.source;
  const ownerSet = current.source !== null && current.sourceBy === OWNER_LABEL;
  if (ownerSet) {
    if (inp.source === undefined) {
      inp.sourceNote = undefined;
      if (contentChanged && current.source === 'owner_said') inp.source = null;
    } else if (sameSource && !contentChanged) {
      inp.source = undefined;
      inp.sourceNote = undefined;
    }
  } else if (sameSource && !contentChanged && current.sourceBy === by && inp.sourceNote === undefined) {
    inp.source = undefined;
  }
  // Taking over a source another setter (the owner, or another assistant) set: their note is not carried under this label.
  if (typeof inp.source === 'string' && inp.source.trim() !== '' && current.source !== null && current.sourceBy !== by && inp.sourceNote === undefined) {
    inp.sourceNote = '';
  }
  // A note alone on a source another assistant set (the owner's is protected above) is this assistant's note: it carries its own label.
  if (inp.source === undefined && typeof inp.sourceNote === 'string' && inp.sourceNote.trim() !== '' && current.source !== null && current.source !== 'owner_said' && !ownerSet && current.sourceBy !== by) {
    inp.source = current.source;
  }
  let meta = resolveMeta(current, inp, true, by);
  if (meta.source === 'owner_said' && meta.sourceBy !== OWNER_LABEL) {
    const claimedNow = inp.source !== undefined || inp.sourceNote !== undefined;
    if (claimedNow || contentChanged) {
      const noteNow = typeof inp.sourceNote === 'string' && inp.sourceNote.trim() !== '';
      const sourceNow = typeof inp.source === 'string' && inp.source.trim() !== '';
      const ownEarlier = current.source === 'owner_said' && current.sourceBy === by;
      if (!(noteNow && (sourceNow || ownEarlier))) {
        meta = { ...meta, source: 'inferred', sourceBy: by, sourceNote: noteNow ? meta.sourceNote : null };
      }
    }
  }
  return {
    meta,
    changedSource: meta.source !== current.source || meta.sourceBy !== current.sourceBy,
    changedNote: meta.sourceNote !== current.sourceNote,
  };
}

export const metaChanged = (a: FactMeta, b: FactMeta): boolean =>
  a.validUntil !== b.validUntil || a.source !== b.source || a.sourceNote !== b.sourceNote || a.sourceBy !== b.sourceBy;

export const metaOf = (m: { validUntil?: string | null; source?: Source | null; sourceNote?: string | null; sourceBy?: string | null }): FactMeta =>
  ({ validUntil: m.validUntil ?? null, source: m.source ?? null, sourceNote: m.sourceNote ?? null, sourceBy: m.sourceBy ?? null });

/** "valid until 2026-12-31", or "past its date since 2026-11-01". */
export const validText = (validUntil: string, now: Date): string =>
  isPastDate(validUntil, now) ? `past its date since ${validUntil}` : `valid until ${validUntil}`;

/**
 * The date and source as one plain line for an export ("valid until 2026-12-31; source: owner_said (set by Claude Code) (a note)"), or ''
 * for a fact with neither. Never says "past": an export must not change from one night to the next without an edit.
 */
export function metaExportText(m: { validUntil?: string | null; source?: Source | null; sourceNote?: string | null; sourceBy?: string | null }): string {
  const parts = [
    m.validUntil ? `valid until ${m.validUntil}` : '',
    m.source ? `source: ${m.source}${m.sourceBy ? ` (set by ${m.sourceBy})` : ''}${m.sourceNote ? ` (${m.sourceNote})` : ''}` : '',
  ].filter((x) => x !== '');
  return parts.join('; ');
}
