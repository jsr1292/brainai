/** A1/A2 as the dashboard shows them (the lines reuse the search-words line's style: style.css is the phone snapshot plus three desk edits): a fact's end date and where it came from. Display only; they never hide or rank a fact. */
import { isPastDate, MAX_SOURCE_NOTE, NO_META, sourceLabel, sourceText } from '../memory/factMeta.js';
import { SOURCES, type FactMeta, type Memory, type Suggestion } from '../memory/types.js';
import { html, type SafeHtml } from './html.js';
import { viewNow } from './when.js';

type Dated = { validUntil?: string | null };
type Sourced = { source?: Memory['source']; sourceNote?: string | null; sourceBy?: string | null };

/** "past its date" on a list or search row; nothing for a fact with no date or one still ahead. */
export const pastChip = (m: Dated, now: Date = viewNow()): SafeHtml =>
  (isPastDate(m.validUntil ?? null, now) ? html`<span class="chip soon">past its date</span>` : html``);

/** An assistant's owner_said: its label already quotes the note. */
const saysYouSaid = (source: string, by: string | null | undefined): boolean => source === 'owner_said' && by !== 'owner';

/** The fact page's line: "Valid until 2026-12-31" or "Past its date since 2026-11-01" (empty when it has no date). */
export function validLine(m: Dated, now: Date = viewNow()): SafeHtml {
  if (!m.validUntil) return html``;
  return isPastDate(m.validUntil, now)
    ? html`<p class="fact-keys fact-valid past">Past its date since <time datetime="${m.validUntil}">${m.validUntil}</time>. It is still in search and still shown; check it, then set a new date or clear it.</p>`
    : html`<p class="fact-keys fact-valid">Valid until <time datetime="${m.validUntil}">${m.validUntil}</time></p>`;
}

/** "You said this", "Claude Code says you said this", "Inferred by Codex", ... (empty when the fact has no source, as older facts do not). */
/** The same with the owner's words when an assistant says you said it, else the label and the note in quotes (for lists of facts). */
export const sourceWordsNote = (m: Sourced): SafeHtml =>
  !m.source ? html`` : html`${sourceText(m.source, m.sourceBy, m.sourceNote)}${m.sourceNote && !saysYouSaid(m.source, m.sourceBy) ? html` · “${m.sourceNote}”` : ''}`;
export const sourceWords = (m: Sourced): string => (m.source ? sourceLabel(m.source, m.sourceBy) : '');

/** The fact page's line: the source, and its note in quotes. */
export function sourceLine(m: Sourced): SafeHtml {
  if (!m.source) return html``;
  return html`<p class="fact-keys fact-source">Source: ${sourceText(m.source, m.sourceBy, m.sourceNote)}${m.sourceNote && !saysYouSaid(m.source, m.sourceBy) ? html` · “${m.sourceNote}”` : ''}</p>`;
}

/** The date and the source of one saved version, for History (so "Undo to this" says what it brings back). */
export function versionMeta(v: Dated & Sourced): SafeHtml {
  const parts = [v.validUntil ? `valid until ${v.validUntil}` : '', v.source ? `source: ${sourceLabel(v.source, v.sourceBy)}` : ''].filter((x) => x !== '');
  return parts.length === 0 ? html`` : html`<p class="meta">${parts.join(' · ')}</p>`;
}

/**
 * What a held card draws from the fact it lands on: that fact (looked up once) and what approving stores. A row whose
 * note or date no longer validates would throw here; the card then just shows no source line (approving still reports it).
 */
export function heldView(service: { heldTarget(s: Suggestion): Memory | undefined; heldOutcome(s: Suggestion, text?: string, known?: Memory | null): FactMeta }, s: Suggestion): { currentMeta: Memory | undefined; heldOutcome: FactMeta | undefined } {
  const currentMeta = service.heldTarget(s);
  try { return { currentMeta, heldOutcome: service.heldOutcome(s, undefined, currentMeta ?? null) }; } catch { return { currentMeta, heldOutcome: undefined }; }
}

/**
 * The date and the source a held save carries, for its approval card, so the owner never approves them blind: what it
 * sets, what it clears ("clears the date"), current → proposed when an update changes one, and "Changes only the date"
 * when the text stays the same. `current` is the fact now (an update, or the roadmap an add lands on); `textSame`: the
 * held text equals the fact's; `outcome`: what approving stores (MemoryService.heldOutcome), the only source rule here:
 * a source line shows only when it differs from the fact now.
 */
export function heldMetaLines(s: { action: string; validUntil?: string | null; source?: Memory['source'] | '' | null; sourceNote?: string | null; sourceBy?: string | null; suggestedBy: string },
  current: Sourced & Dated | undefined, textSame: boolean, outcome?: FactMeta): SafeHtml {
  const lines: SafeHtml[] = [];
  let dateShown = false;
  let sourceShown = false;
  const upd = s.action === 'update' && current !== undefined;
  const dateGiven = s.validUntil !== undefined && s.validUntil !== null;
  if (dateGiven) {
    const was = current?.validUntil ?? null;
    if (s.validUntil === '') { if (upd && was) { dateShown = true; lines.push(html`<p class="sg-meta">Clears the date (now ${was}).</p>`); } }
    else if (upd && was && was !== s.validUntil) { dateShown = true; lines.push(html`<p class="sg-meta">Valid until: ${was} → ${s.validUntil}</p>`); }
    else if (!(upd && was === s.validUntil)) { dateShown = true; lines.push(html`<p class="sg-meta">Valid until ${s.validUntil}</p>`); }
  }
  // The source is what approving stores (heldOutcome), shown only when it differs from the fact now.
  const before: FactMeta = current !== undefined ? { validUntil: null, source: current!.source ?? null, sourceNote: current!.sourceNote ?? null, sourceBy: current!.sourceBy ?? null } : NO_META;
  const srcDiffers = outcome !== undefined && (outcome.source !== before.source || outcome.sourceNote !== before.sourceNote || outcome.sourceBy !== before.sourceBy);
  if (outcome && srcDiffers) {
    sourceShown = true;
    const wasText = before.source ? sourceText(before.source, before.sourceBy, before.sourceNote) : null;
    if (outcome.source === null) lines.push(html`<p class="sg-meta">Clears the source (now “${sourceLabel(before.source!, before.sourceBy)}”).</p>`);
    else if (outcome.source === before.source && outcome.sourceBy === before.sourceBy) {
      lines.push(outcome.sourceNote ? html`<p class="sg-meta">Source note: “${outcome.sourceNote}”</p>` : html`<p class="sg-meta">Clears the source note.</p>`);
    } else {
      const proposed = sourceText(outcome.source, outcome.sourceBy, outcome.sourceNote);
      const note = outcome.sourceNote && !saysYouSaid(outcome.source, outcome.sourceBy) ? html` · “${outcome.sourceNote}”` : '';
      lines.push(wasText !== null ? html`<p class="sg-meta">Source: ${wasText} → ${proposed}${note}</p>` : html`<p class="sg-meta">Source: ${proposed}${note}</p>`);
    }
  }
  if (lines.length === 0) return html``;
  const only = upd && textSame ? [dateShown ? 'the date' : '', sourceShown ? 'the source' : ''].filter((x) => x !== '') : [];
  return html`${lines}${only.length > 0 ? html`<p class="sg-meta">Changes only ${only.join(' and ')}; the text stays as it is.</p>` : ''}`;
}

/** The edit form's three fields: date, source, note. An empty date or source clears it. */
export function metaFields(v: { validUntil?: string; source?: string; sourceBy?: string | null; sourceNote?: string; origValidUntil?: string; origSource?: string; origSourceNote?: string }): SafeHtml {
  // What the form was opened with: a field is saved only when the owner changed it, so a change an assistant made to
  // another field meanwhile is not put back.
  const orig = v.origValidUntil === undefined ? '' : html`<input type="hidden" name="orig_valid_until" value="${v.origValidUntil}"><input type="hidden" name="orig_source" value="${v.origSource ?? ''}"><input type="hidden" name="orig_source_note" value="${v.origSourceNote ?? ''}">`;
  // A source an assistant set shows its own label ("Cursor says you said this") as the selected option, so the form never
  // says "You said this" for it. "keep" leaves it alone; picking "You said this" on purpose makes it the owner's.
  const byAssistant = v.origSource !== undefined && v.origSource !== '' && !!v.sourceBy && v.sourceBy !== 'owner';
  const keep = byAssistant ? html`<option value="keep"${v.source === 'keep' || v.source === v.origSource ? ' selected' : ''}>${sourceLabel(v.origSource as NonNullable<Memory['source']>, v.sourceBy)}</option>` : '';
  return html`${orig}<div class="two">
    <label>Valid until (optional) <input type="date" name="valid_until" value="${v.validUntil ?? ''}"></label>
    <label>Where it came from <select name="source"><option value="">Not recorded</option>${keep}${SOURCES.map((s) => html`<option value="${s}"${!byAssistant && s === v.source ? ' selected' : ''}>${sourceLabel(s, 'owner')}</option>`)}</select></label>
  </div>
  <label>Source note (optional, one line) <input type="text" name="source_note" value="${v.sourceNote ?? ''}" maxlength="${MAX_SOURCE_NOTE}"></label>
  <p class="meta">After the date the fact is marked "past its date" and shows up under Tidy-ups; it stays in search.</p>`;
}
