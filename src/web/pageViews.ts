import { looksLikeInstruction } from '../memory/instructionLike.js';
import type { Memory } from '../memory/types.js';
import type { Flag } from '../pages/freshness.js';
import type { Note } from '../pages/notes.js';
import { decisionItems, diagramBlocks, isKeyDecisions, linkDefinitions, pictureRefs, renderInline, renderMarkdown, type LinkResolver, type PictureLookup } from '../pages/markdown.js';
import type { StoredSection } from '../pages/store.js';
import { PAGE_AREA_LABELS, PAGE_AREAS, type Page, type PageArea, type PageHeader } from '../pages/types.js';
import type { WaitingRow } from '../projects/service.js';
import { withFrom } from './back.js';
import { errorBlock, plural, writer } from './dashboardViews.js';
import { areaRing } from './projectsViews.js';
import { asset, html, raw, type SafeHtml } from './html.js';
import { pagesSubnav } from './skillViews.js';
import { metaLine } from './metaLine.js';
import { localDay } from '../timezone.js';
import { dueChip, timeAgo, viewNow } from './when.js';
import { checkedMeta, decidedSince, staleChip, staleFold, factPill, keyAnchorOf, replacedLabel, savedSinceHint, sectionHint, sectionMarks, staleLine, stillTrueLine } from './freshnessViews.js';

/** The notes panel's id. Section anchors are only ever letters, digits and dashes (splitSections), so the underscore never clashes with a heading such as "## Notes". */
export const NOTES_ID = 'ai_notes';

export interface NavEntry { id: string; title: string; area: PageArea | null }

const who = (by: string) => (by === 'owner' ? 'you' : by);
const day = (iso: string): SafeHtml => timeAgo(iso);
const panelHref = (name: string) => `/?project=${encodeURIComponent(name)}#panel`;
const areaLabel = (a: PageArea | null) => (a === null ? 'Unsorted' : PAGE_AREA_LABELS[a]);
const byTitle = (a: NavEntry, b: NavEntry) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' });

/** Areas and their pages down the left; Personal folded away, Unsorted last. */
export function pagesNav(entries: NavEntry[], current?: string): SafeHtml {
  const link = (e: NavEntry) => html`<li><a href="/pages/${e.id}"${e.id === current ? html` aria-current="page"` : ''}>${e.title}</a></li>`;
  const group = (area: PageArea | null) => entries.filter((e) => e.area === area).sort(byTitle);
  const open = PAGE_AREAS.filter((a) => a !== 'personal').map((a) => ({ a, list: group(a) })).filter((g) => g.list.length > 0);
  const personal = group('personal');
  const unsorted = group(null);
  return html`<nav class="pnav" aria-label="Pages">
${open.map((g) => html`<h2>${g.a === 'start' ? '' : html`<span class="ring a-${g.a}" aria-hidden="true"></span> `}${PAGE_AREA_LABELS[g.a]}</h2><ul>${g.list.map(link)}</ul>`)}
${personal.length > 0 ? html`<details class="private"${personal.some((e) => e.id === current) ? html` open` : ''}><summary><span class="ring a-personal" aria-hidden="true"></span>Personal<span class="n">${personal.length}</span><span class="chev"></span></summary><ul>${personal.map(link)}</ul></details>` : ''}
${unsorted.length > 0 ? html`<h2>Unsorted</h2><ul>${unsorted.map(link)}</ul>` : ''}
</nav>`;
}

/**
 * The page first, then its rail, then the Pages list: keyboard, screen reader and a phone's single column all meet the
 * page before every page title. On wider screens the grid draws the list in the left column (style.css).
 */
export const layout = (nav: SafeHtml, main: SafeHtml, aside?: SafeHtml, opts?: { onPage?: boolean }) =>
  html`<div class="pages-wrap${aside ? ' with-aside' : ''}${opts?.onPage ? ' on-page' : ''}"><div class="pmain">${main}</div>${aside ?? ''}${opts?.onPage ? '' : html`<h2 class="by-area">All pages by area</h2>`}${nav}</div>`;

/** The Pages tab (mockup pages-home.html). */
export function pagesHomeView(v: {
  nav: NavEntry[]; recent: { page: Page; area: PageArea | null; summary: string; stale?: boolean }[]; start: Page[]; withoutPage: string[]; moved: { moved: number } | null;
  /** Pages that may be out of date, for their closed fold. */
  stale?: { page: PageHeader; flag: Flag; noteOpen: boolean }[];
}): SafeHtml {
  const subnav = pagesSubnav('/pages');
  const main = v.recent.length === 0
    ? html`<h1>Pages</h1><p class="lede">No pages yet. Assistants write them as you work; New page to start one.</p><p><a class="button primary" href="/pages/new">New page</a></p>`
    : html`<h1>Pages</h1>
<p class="lede">The whole picture of each project: what it is, how it runs, why it was built that way. Assistants write most of these; facts and live status stay in Projects.</p>
<div class="pg-home">
<section><div class="panel-head"><h2>Recently updated</h2><a class="button primary" href="/pages/new">New page</a></div>
<ul class="group">${v.recent.map((r) => html`<li><a class="row nolead" href="/pages/${r.page.id}"><span class="txt"><b>${r.page.title}</b>${metaLine([html`${areaRing(r.area)} ${areaLabel(r.area)}`, writer(r.page.updatedBy), day(r.page.updatedAt), r.summary, r.stale ? staleChip() : null])}</span><span class="chev"></span></a></li>`)}</ul></section>
<section><div class="panel-head"><h2>Start here</h2></div>
${v.start.length === 0 ? html`<p class="quiet">No Start here pages yet.</p>` : html`<ul class="group">${v.start.map((p) => html`<li><a class="row nolead" href="/pages/${p.id}"><span class="txt"><b>${p.title}</b></span><span class="chev"></span></a></li>`)}</ul>`}</section>
</div>`;
  const staleRow = staleFold(v.stale ?? []);
  const fold = v.withoutPage.length === 0 ? (v.stale?.length ? html`<ul class="group nopage-group">${staleRow}</ul>` : html``) : html`<ul class="group nopage-group">${staleRow}<li><details class="fold nopage"><summary class="row nolead">Projects without a page<span class="n">${v.withoutPage.length}</span><span class="chev"></span></summary>
<div class="fold-body"><p class="meta">Open projects that have facts but no page yet. Ask an assistant to write one, or start it yourself.</p>
<ul class="chips">${v.withoutPage.map((n) => html`<li><a href="/pages/new?project=${encodeURIComponent(n)}">${n}</a></li>`)}</ul></div></details></li></ul>`;
  const moved = v.moved && v.moved.moved > 0 ? html`<p class="foot-link"><a href="/pages/moved">Moved from Outline: ${v.moved.moved} ${v.moved.moved === 1 ? 'page' : 'pages'} came over</a></p>` : '';
  return layout(pagesNav(v.nav), html`${subnav}${main}${fold}${moved}`);
}

export interface Live { project: string; now: string | null; next: string[]; waiting: WaitingRow[] }

/** The live box's tick rows: the same rows as the panel, each sending the tick back to this page. */
function liveTicks(l: Live, pageId: string, today: string): SafeHtml {
  return l.waiting.length === 0 ? html`<p class="quiet">Nothing waiting on you.</p>` : html`<ul class="checks">${l.waiting.map((w) => html`<li><form method="post" action="/projects/${encodeURIComponent(l.project)}/waiting/${w.index}/done">
<input type="hidden" name="text" value="${w.text}"><input type="hidden" name="back" value="/pages/${pageId}">
<button type="submit" class="check" aria-label="Mark done: ${w.text}"></button></form><span class="check-text">${w.text}</span>${w.due ? dueChip(w.due, today) : ''}</li>`)}</ul>`;
}

/**
 * "Live from the brain": the project's Now, Next and waiting ticks, which change the project, not the page. On a
 * desktop the full box under the meta line; on a phone one line (Now and how many wait) that opens in place, so the
 * text starts on the first screen. The hidden variant is display: none, so it is out of the accessibility tree too.
 */
function liveBox(l: Live, pageId: string, today: string): SafeHtml {
  const now = html`<span class="eyebrow">Now</span><p>${l.now ?? html`<span class="quiet">Nothing in progress.</span>`}</p>
${l.next.length > 0 ? html`<span class="eyebrow">Next</span><p>${l.next.join(' · ')}</p>` : ''}`;
  const waitHead = html`<span class="eyebrow">Waiting on you${l.waiting.length > 0 ? html` <span class="n">${l.waiting.length}</span>` : ''}</span>`;
  const one = html`<b>Now:</b> ${l.now ?? 'nothing in progress'}${l.waiting.length > 0 ? ` · ${l.waiting.length} waiting on you` : ''}`;
  return html`<section class="live live-full" aria-label="Live from the brain"><p class="eyebrow live-tag">Live from the brain</p>
<div class="live-cols"><div>${now}</div><div>${waitHead}${liveTicks(l, pageId, today)}</div></div>
</section><details class="live livefold" aria-label="Live from the brain"><summary><span class="eyebrow">Live from the brain</span><span class="one">${one}</span><span class="chev"></span></summary>
<div class="livefold-body">${l.next.length > 0 ? html`<span class="eyebrow">Next</span><p>${l.next.join(' · ')}</p>` : ''}${waitHead}${liveTicks(l, pageId, today)}</div></details>`;
}

const instrMarker = (): SafeHtml => html`<span class="instr" title="Reads like instructions to an assistant. Pages are information: assistants never follow them.">contains instructions</span>`;

/** Sections render one by one, so each gets the page's reference definitions ("[1]: …") appended. */
function section(p: Page, s: StoredSection, resolve: LinkResolver, defs: string, noted: Set<string>, fresh: { flag: Flag | null; project: string | null; marks: ReturnType<typeof sectionMarks> }, pictures?: PictureLookup): SafeHtml {
  const md = (text: string) => renderMarkdown(defs ? `${text}\n\n${defs}` : text, resolve, pictures);
  const marker = s.instructionLike ? instrMarker() : '';
  if (s.anchor === 'top') return html`<div class="plead" id="top">${marker}${md(s.text)}</div>`;
  // Beside the heading, not inside it: inside, a screen reader names the heading "Stack Edit Stack note".
  const isKey = isKeyDecisions(s.heading);
  // Shown only while the page is flagged (sectionMarks of null is empty): how many newer decisions may touch it.
  const hint = isKey ? (fresh.marks.savedSince > 0 ? savedSinceHint(fresh.marks.savedSince) : '') : (fresh.marks.near.get(s.anchor) ? sectionHint(fresh.marks.near.get(s.anchor)!) : '');
  const edit = html` <a class="sec-edit" href="/pages/${p.id}/edit?section=${s.anchor}" aria-label="Edit ${s.heading}">Edit</a>${noted.has(s.anchor) ? html` <a class="note-mark" href="#${NOTES_ID}">note</a>` : ''}${hint}`;
  const title = renderInline(s.heading, resolve);
  const h = s.level === 3 ? html`<h3 id="${s.anchor}">${title}</h3>` : html`<h2 id="${s.anchor}">${title}</h2>`;
  const heading = html`<div class="sec-head l${s.level === 3 ? 3 : 2}">${h}${edit}</div>`;
  // A replaced linked fact already carries section 16's "replaced" marker after its link: that marker takes section 13's
  // date ("replaced 2 Nov") instead of a second pill repeating it.
  const dated = new Set<string>();
  const keyResolve: LinkResolver = (target) => {
    const r = resolve(target);
    const c = r?.replacedHref !== undefined && target.startsWith('fact:') ? fresh.marks.linked.get(target.slice(5).trim()) : undefined;
    if (!r || c?.why !== 'replaced') return r;
    dated.add(c.id);
    return { ...r, replacedLabel: replacedLabel(c) };
  };
  const items = isKey ? decisionItems(s.text, keyResolve) : null;
  const pills = (ids: string[]) => ids.filter((id) => !dated.has(id)).map((id) => fresh.marks.linked.get(id)).filter((c) => c !== undefined).map((c) => factPill(c));
  const since = (timeline: boolean) => (isKey && fresh.flag ? decidedSince(fresh.flag, fresh.project, timeline) : '');
  const content = items
    ? html`<ol class="timeline">${items.map((i) => html`<li><time class="day" datetime="${i.date}">${i.date}</time><div>${i.html}${i.factLinked ? html` <span class="linked-fact">linked fact</span>` : ''}${pills(i.factIds)}</div></li>`)}${since(true)}</ol>`
    : html`${md(s.text)}${since(false)}`;
  return html`${heading}${marker}${content}`;
}

/**
 * Numbers the page's diagrams in body order (data-block, as diagramBlocks counts them): the first gets id="diagram-1",
 * which the meta line's count links to, and one with a current problem is marked, so the page reports when it draws.
 */
function numberDiagrams(sections: SafeHtml[], problems: Set<number>): SafeHtml[] {
  let n = 0;
  return sections.map((s) => (s.value.includes('<div class="diagram">')
    ? raw(s.value.replace(/<div class="diagram">/g, () => {
      const i = n++;
      return `<div class="diagram"${i === 0 ? ' id="diagram-1"' : ''} data-block="${i}"${problems.has(i) ? ' data-problem=""' : ''}>`;
    }))
    : s));
}

const RESOLVED_SHOWN = 5;
/** Related facts in the rail: the first three, then "N more" folded in place. */
const RELATED_SHOWN = 3;

/**
 * The rest fold in place rather than linking to the project's facts: some were found by meaning in other projects,
 * and a page with no project has no list to link to, so only the rail itself can reach every one. Each fact carries
 * the page's own address, so its back link returns here.
 */
function relatedFacts(related: Memory[], from: string): SafeHtml {
  if (related.length === 0) return html``;
  const list = (ms: Memory[]) => html`<ul class="rel plain-list">${ms.map((m) => html`<li><a href="${withFrom(`/memories/${m.id}`, from)}">${m.content}</a>${metaLine([m.kind, day(m.updatedAt)])}</li>`)}</ul>`;
  const rest = related.slice(RELATED_SHOWN);
  return html`<h2>Related facts <span class="n">${related.length}</span></h2>${list(related.slice(0, RELATED_SHOWN))}${rest.length > 0 ? html`<details class="fold rel-more"><summary class="row nolead">${rest.length} more<span class="chev"></span></summary>${list(rest)}</details>` : ''}`;
}

/** A note's start, for naming its Withdraw button: up to 72 characters, cut at a space. */
const clip = (s: string): string => (s.length <= 72 ? s : `${s.slice(0, s.lastIndexOf(' ', 72) > 40 ? s.lastIndexOf(' ', 72) : 72)}…`);

/** Notes for the AIs: open ones (with Withdraw), then the newest resolved ones with the assistant's reply. */
function notesPanel(p: Page, notes: Note[], headings: Map<string, string>): SafeHtml {
  const open = notes.filter((n) => n.status === 'open');
  const done = notes.filter((n) => n.status === 'resolved').slice(0, RESOLVED_SHOWN);
  if (open.length === 0 && done.length === 0) return html``;
  const where = (n: Note) => (n.anchor !== null && headings.has(n.anchor) ? html`<a href="#${n.anchor}">${headings.get(n.anchor)}</a>` : html`The whole page`);
  return html`<section class="pnotes" id="${NOTES_ID}"><h2>Notes for the AIs</h2><ul>
${open.map((n) => html`<li class="open">${metaLine([where(n), 'waiting for an assistant'])}<p>${n.text}</p><form method="post" action="/pages/${p.id}/notes/${n.id}/withdraw"><button type="submit" class="ghost small" aria-label="Withdraw note: ${clip(n.text)}">Withdraw</button></form></li>`)}
${done.map((n) => html`<li class="done">${metaLine([where(n), day(n.resolvedAt ?? n.createdAt)])}<p>${n.text}</p><p class="note-reply">${n.resolvedBy}: ${n.reply}</p></li>`)}
</ul></section>`;
}

/** What the owner typed in a refused note, shown again with the reason. */
export interface NoteDraft { text: string; section: string; error: string }

/** The note form's id; underscored like NOTES_ID, so it never clashes with a section anchor. */
const ASK_ID = 'ask_ai';

/**
 * "Ask an AI to update": a short note on the page or one section, for the next assistant that works on it.
 * The form posts to #ask_ai, so a refused note comes back scrolled to the form and its reason (on a phone or tablet
 * the rail sits far below the article); a saved note's redirect carries its own #ai_notes instead.
 */
function askForm(p: Page, sections: StoredSection[], draft?: NoteDraft, opts: { id?: string; label?: string; prefill?: { section: string; text: string } } = {}): SafeHtml {
  const picked = draft?.section ?? opts.prefill?.section;
  const chosen = (anchor: string) => (picked === anchor ? html` selected` : '');
  // A second form (the out-of-date line's) has its own id and is a button, set and filled in by the server; it posts
  // to the same route, so a refused note comes back in the rail's form.
  const summary = opts.label === undefined ? html`<summary class="link">Ask an AI to update</summary>` : html`<summary class="button">${opts.label}</summary>`;
  const id = opts.id ?? ASK_ID;
  return html`<details class="asknote${id === ASK_ID ? '' : ' ask-line'}" id="${id}"${draft ? html` open` : ''}>${summary}
<form method="post" action="/pages/${p.id}/notes#${ASK_ID}" class="stack">
${draft ? html`<p class="error" id="note_error" role="alert">${draft.error}</p>` : ''}
<label>Where <select name="section"><option value=""${chosen('')}>The whole page</option>${sections.map((s) => html`<option value="${s.anchor}"${chosen(s.anchor)}>${s.heading}</option>`)}</select></label>
<label>Note <textarea name="text" maxlength="500" required placeholder="What should change? e.g. the port changed to 8443"${draft ? html` aria-describedby="note_error"` : ''}>${draft?.text ?? opts.prefill?.text ?? ''}</textarea></label>
<button type="submit">Leave the note</button>
</form></details>`;
}

/** The reading view (mockup page-view.html). */
export function pageView(v: {
  page: Page; nav: NavEntry[]; area: PageArea | null; versions: number; sections: StoredSection[]; resolve: LinkResolver;
  /** The page's project under its real name (a merged project's old name is followed). */
  project: string | null;
  live: Live | null; related: Memory[]; linkedFrom: Page[];
  /** The owner's notes on this page, open ones first (NoteService.forPage). */
  notes: Note[];
  error?: string;
  /** A refused note: the form opens again with it. */
  noteDraft?: NoteDraft;
  /** Why the page may be out of date (worked out with section hints), or null. */
  flag?: Flag | null;
  /** The page's pictures (PageService.pictures), for their real size. */
  pictures?: PictureLookup;
  /** The diagrams (by block) that couldn't be drawn when last viewed, while their text is unchanged. */
  diagramProblems?: number[];
}): SafeHtml {
  const p = v.page;
  if (p.deletedAt !== null) {
    return layout(pagesNav(v.nav), html`<h1>${p.title}</h1><p class="lede">This page was deleted ${day(p.deletedAt)}. Its versions are kept.</p>
<form method="post" action="/pages/${p.id}/undelete"><button type="submit" class="primary">Undelete</button></form>`, undefined, { onPage: true });
  }
  const crumb = html`<p class="crumb">${areaLabel(v.area)}${v.project ? html` › <a href="${panelHref(v.project)}">${v.project}</a>` : ''}</p>`;
  // Pictures that show (live, the right extension) and diagrams: counted in the meta line, listed in the rail.
  const pics = pictureRefs(p.body).map((r) => ({ r, img: v.pictures?.(r.id) })).filter((x) => x.img !== undefined && x.img.removedAt === null && x.img.ext === x.r.ext);
  const diagrams = diagramBlocks(p.body).length;
  const counts = diagrams + pics.length > 0
    ? html`<span class="media-counts">${[
      diagrams > 0 ? html`<a href="#diagram-1">${plural(diagrams, 'diagram', 'diagrams')}</a>` : null,
      pics.length > 0 ? html`<a href="#pic-${pics[0]!.r.id}">${plural(pics.length, 'picture', 'pictures')}</a>` : null,
    ].filter((x) => x !== null).map((x, i) => (i === 0 ? x : html` · ${x}`))}</span>`
    : null;
  const meta = metaLine([html`Written by ${writer(p.createdBy)}`, html`Updated ${day(p.updatedAt)}${p.updatedBy !== p.createdBy ? html` by ${writer(p.updatedBy)}` : ''}`, plural(v.versions, 'version', 'versions'), checkedMeta(p), counts]);
  const picsRail = pics.length > 0
    ? html`<section class="pics-rail"><h2 class="toc-h">Pictures on this page</h2><ul>${pics.map(({ r, img }) => html`<li><a href="#pic-${r.id}"><img src="/images/${r.id}.${r.ext}" alt="" width="${img!.width}" height="${img!.height}" loading="lazy" decoding="async"><span>${r.title ?? r.alt}</span></a></li>`)}</ul></section>`
    : html``;
  const toc = v.sections.filter((s) => s.anchor !== 'top');
  const headings = new Map(toc.map((s) => [s.anchor, s.heading]));
  const flag = v.flag ?? null;
  const marks = sectionMarks(flag);
  // In "On this page": a dot on sections newer decisions may touch, and +N on Key decisions (only while flagged).
  const tocMark = (s: StoredSection): SafeHtml | '' => (isKeyDecisions(s.heading)
    ? (marks.savedSince > 0 ? html`<span class="hintn">+${marks.savedSince}</span>` : '')
    : (marks.near.has(s.anchor) ? html`<span class="hint" role="img" aria-label="newer decisions may touch this"></span>` : ''));
  const tocItems = toc.map((s) => html`<li class="l${s.level}"><a href="#${s.anchor}">${renderInline(s.heading, v.resolve)}${tocMark(s)}</a></li>`);
  const tocList = toc.length > 0 ? html`<h2 class="toc-h">On this page</h2><ul class="toc">${tocItems}</ul>` : html``;
  const noted = new Set(v.notes.filter((n) => n.status === 'open' && n.anchor !== null).map((n) => n.anchor!));
  // The rail sticks and is capped at the window's height, so what sits low in it is hidden until the rail itself is
  // scrolled. The controls (and a refused note's reason) therefore come first, where they are always in view.
  const aside = html`<aside class="paside"><div class="sticky">
<a class="button primary" href="/pages/${p.id}/edit">Edit</a>
<p class="rail-link"><a href="/pages/${p.id}/history">History</a><span class="n">${plural(v.versions, 'version', 'versions')}</span></p>
${askForm(p, toc, v.noteDraft)}
${tocList}${picsRail}
${relatedFacts(v.related, `/pages/${p.id}`)}
${v.linkedFrom.length > 0 ? html`<h2>Linked from</h2><ul class="lk">${v.linkedFrom.map((x) => html`<li><a href="/pages/${x.id}">${x.title}</a></li>`)}</ul>` : ''}
${notesPanel(p, v.notes, headings)}
</div></aside>`;
  // The lead's marker covers the title (it is checked with it); without a flagged lead the title gets its own.
  const titleMarker = looksLikeInstruction(p.title) !== null && !v.sections.some((s) => s.anchor === 'top' && s.instructionLike) ? instrMarker() : '';
  // On a phone (and below 1101px, where the rail's list hides) "On this page" folds under the meta line.
  const tocFold = toc.length > 0 ? html`<details class="fold toc-fold"><summary class="row nolead">On this page<span class="n">${toc.length}</span><span class="chev"></span></summary><ul class="toc">${tocItems}</ul></details>` : html``;
  // Under the meta line: the one closed out-of-date line, or, on the day of a Still true, its line with Undo.
  const freshness = flag
    ? staleLine({ page: p, flag, project: v.project, noteOpen: v.notes.some((n) => n.status === 'open'), keyAnchor: keyAnchorOf(v.sections), sections: toc, askForm: (o) => askForm(p, toc, undefined, o) })
    : stillTrueLine(p, localDay(viewNow()));
  const main = html`${crumb}<h1>${p.title}</h1>${titleMarker}${meta}${freshness}${tocFold}${errorBlock(v.error)}${v.live ? liveBox(v.live, p.id, localDay(viewNow())) : ''}
<article class="art"${pics.length + diagrams > 0 ? html` data-viewer="${asset('viewer.js')}"` : ''}${diagrams > 0 ? html` data-diagrams="${asset('diagrams.js')}" data-renderer="${asset('diagram-frame.js')}" data-page="${p.id}" data-version="${p.version}"` : ''}>${numberDiagrams(v.sections.map((s) => section(p, s, v.resolve, linkDefinitions(p.body), noted, { flag, project: v.project, marks }, v.pictures)), new Set(v.diagramProblems ?? []))}</article>`;
  return layout(pagesNav(v.nav, p.id), main, aside, { onPage: true });
}
