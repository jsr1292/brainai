/** A1/A2 as the dashboard shows them (the lines reuse the search-words line's style: style.css is the phone snapshot plus three desk edits): a fact's end date and where it came from. Display only; they never hide or rank a fact. */
import { isPastDate, MAX_SOURCE_NOTE, sourceLabel } from '../memory/factMeta.js';
import { SOURCES, type Memory } from '../memory/types.js';
import { html, type SafeHtml } from './html.js';
import { viewNow } from './when.js';

type Dated = { validUntil?: string | null };
type Sourced = { source?: Memory['source']; sourceNote?: string | null; sourceBy?: string | null };

/** "past its date" on a list or search row; nothing for a fact with no date or one still ahead. */
export const pastChip = (m: Dated, now: Date = viewNow()): SafeHtml =>
  (isPastDate(m.validUntil ?? null, now) ? html`<span class="chip soon">past its date</span>` : html``);

/** The fact page's line: "Valid until 2026-12-31" or "Past its date since 2026-11-01" (empty when it has no date). */
export function validLine(m: Dated, now: Date = viewNow()): SafeHtml {
  if (!m.validUntil) return html``;
  return isPastDate(m.validUntil, now)
    ? html`<p class="fact-keys fact-valid past">Past its date since <time datetime="${m.validUntil}">${m.validUntil}</time>. It is still in search and still shown; check it, then set a new date or clear it.</p>`
    : html`<p class="fact-keys fact-valid">Valid until <time datetime="${m.validUntil}">${m.validUntil}</time></p>`;
}

/** "You said this", "Claude Code says you said this", "Inferred by Codex", ... (empty when the fact has no source, as older facts do not). */
export const sourceWords = (m: Sourced): string => (m.source ? sourceLabel(m.source, m.sourceBy) : '');

/** The fact page's line: the source, and its note in quotes. */
export function sourceLine(m: Sourced): SafeHtml {
  if (!m.source) return html``;
  return html`<p class="fact-keys fact-source">Source: ${sourceLabel(m.source, m.sourceBy)}${m.sourceNote ? html` · “${m.sourceNote}”` : ''}</p>`;
}

/** The date and the source of one saved version, for History (so "Undo to this" says what it brings back). */
export function versionMeta(v: Dated & Sourced): SafeHtml {
  const parts = [v.validUntil ? `valid until ${v.validUntil}` : '', v.source ? `source: ${sourceLabel(v.source, v.sourceBy)}` : ''].filter((x) => x !== '');
  return parts.length === 0 ? html`` : html`<p class="meta">${parts.join(' · ')}</p>`;
}

/**
 * The date and the source a held save carries, for its approval card, so the owner never approves them blind: what it
 * sets, what it clears ("clears the date"), current → proposed when an update changes one, and "Changes only the date"
 * when the text stays the same. `current` is the fact now (an update); `textSame`: the held text equals the fact's.
 */
export function heldMetaLines(s: { action: string; validUntil?: string | null; source?: Memory['source'] | '' | null; sourceNote?: string | null; sourceBy?: string | null; suggestedBy: string },
  current: Sourced & Dated | undefined, textSame: boolean): SafeHtml {
  const lines: SafeHtml[] = [];
  let dateShown = false;
  let sourceShown = false;
  const upd = s.action === 'update' && current !== undefined;
  const dateGiven = s.validUntil !== undefined && s.validUntil !== null;
  const sourceGiven = s.source !== undefined && s.source !== null;
  const noteGiven = s.sourceNote !== undefined && s.sourceNote !== null;
  if (dateGiven) {
    const was = current?.validUntil ?? null;
    if (s.validUntil === '') { if (upd && was) { dateShown = true; lines.push(html`<p class="sg-meta">Clears the date (now ${was}).</p>`); } }
    else if (upd && was && was !== s.validUntil) { dateShown = true; lines.push(html`<p class="sg-meta">Valid until: ${was} → ${s.validUntil}</p>`); }
    else if (!(upd && was === s.validUntil)) { dateShown = true; lines.push(html`<p class="sg-meta">Valid until ${s.validUntil}</p>`); }
  }
  if (sourceGiven) {
    const was = upd && current!.source ? sourceLabel(current!.source, current!.sourceBy) : null;
    if (s.source === '') { if (upd && was) { sourceShown = true; lines.push(html`<p class="sg-meta">Clears the source (now “${was}”).</p>`); } }
    else {
      sourceShown = true;
      const proposed = sourceLabel(s.source as NonNullable<Memory['source']>, s.sourceBy ?? s.suggestedBy);
      const note = s.sourceNote ? html` · “${s.sourceNote}”` : '';
      lines.push(was !== null && was !== proposed ? html`<p class="sg-meta">Source: ${was} → ${proposed}${note}</p>` : html`<p class="sg-meta">Source: ${proposed}${note}</p>`);
    }
  } else if (noteGiven && s.sourceNote) {
    sourceShown = true;
    lines.push(html`<p class="sg-meta">Source note: “${s.sourceNote}”</p>`);
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
