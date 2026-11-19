/**
 * The Inbox page: one frame (list of everything that waits, the item beside it) behind four URLs. /approvals shows an
 * approval, a skill proposal or, by default, the first item; /disagreements and /facts/tidy keep their old addresses
 * and show their group inside the same frame (all of it, or one item with ?id= / ?item=).
 */
import type { Request, Response } from 'express';
import type { Memory, Suggestion } from '../memory/types.js';
import type { AppDeps } from './app.js';
import { heldView } from './factMetaViews.js';
import { suggestionCard, tidyView, writerName } from './dashboardViews.js';
import { disagreementsView, pairs, type OpenDisagreement } from './disagreeViews.js';
import { html, page, type SafeHtml } from './html.js';
import { t, tKey } from '../i18n/core.js';
import { inboxModel, tidyOnly, type InboxItem, type InboxModel } from './inboxModel.js';
import { primeSideStatus } from './sideStatus.js';
import { takeStatusLine } from './inboxUndo.js';
import { inboxView } from './approvalsViews.js';
import { proposalCard } from './skillViews.js';
import { tidyProposalCard } from './tidyProposalViews.js';
import { isFlagged } from '../memory/service.js';
import { factsOf, lineStyle, sectionTitle } from '../memory/tidyService.js';
import { splitSections } from '../pages/markdown.js';
import { makeTidyItems } from './tidyItems.js';

const one = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);

export type InboxPick = { batch: string } | { suggestion: string } | { proposal: string } | { tidyProposal: string } | { disagree: string } | { tidy: string } | { all: 'disagree' | 'tidy' } | null;

/** The item to open after this one is answered: the next one down the list that can be answered in the pane, else the one before; null when it is the only one. */
export function nextOf(model: InboxModel, item: InboxItem): string | null {
  const answerable = model.items.filter((i) => i.kind !== 'discussion');
  const at = answerable.findIndex((i) => i.key === item.key);
  const other = answerable[at + 1] ?? answerable[at - 1];
  return at < 0 || !other ? null : other.key;
}

/** The text of one section of a page body (its heading and lines), for reading how its lines are written. */
const sectionBody = (body: string, anchor: string): string => {
  const s = splitSections(body).find((x) => x.anchor === anchor);
  return s ? body.split('\n').slice(s.start, s.end).join('\n') : '';
};

export function makeInbox(d: AppDeps) {
  const tidyItems = makeTidyItems(d);

  const pendingCards = () => d.service.pendingSuggestions().map((suggestion) => ({
    suggestion,
    current: suggestion.memoryId ? d.store.get(suggestion.memoryId)?.content : undefined,
    ...heldView(d.service, suggestion),
    replaces: suggestion.supersedes.map((id) => d.store.get(id)).filter((m): m is Memory => m !== undefined && m.deletedAt === null),
    deleted: suggestion.deletedMatch ? d.store.get(suggestion.deletedMatch) : undefined,
    similar: suggestion.similarId ? d.store.get(suggestion.similarId) : undefined,
  }));

  /** Every open pair, grouped by project as /disagreements always did. */
  const disagreeGroups = (only?: string) => {
    const groups = new Map<string | null, OpenDisagreement[]>();
    for (const x of d.service.openDisagreements()) {
      if (only !== undefined && x.id !== only) continue;
      const raw = x.factA.project ?? x.factB.project;
      const key = raw === null ? null : d.service.projectNamed(raw);
      groups.set(key, [...(groups.get(key) ?? []), x]);
    }
    return [...groups].sort(([a], [b]) => (a === null ? 1 : b === null ? -1 : a.localeCompare(b))).map(([project, list]) => ({ project, list }));
  };

  /** B1: one harvest, whole: Approve all / Reject all, then every waiting item with its own buttons. */
  const harvestPane = (batch: string, items: Suggestion[], cards: ReturnType<typeof pendingCards>): SafeHtml => {
    const h = items[0]!;
    // What Approve all will save: the items without a warning. The others wait for their own answer.
    const plain = items.filter((s) => !isFlagged(s)).length;
    return html`<div class="approvals harvest">
<h2>${t('inbox.row.harvest', { who: writerName(h.suggestedBy), label: h.harvest!.label })}</h2>
<p class="lede">${t('inbox.harvest.lede', { who: writerName(h.suggestedBy), count: items.length })}${plain < items.length ? ` ${items.length - plain === 1 ? t('inbox.harvest.warnOne', { approve: plain === 0 ? t('inbox.harvest.all') : plain }) : t('inbox.harvest.warnMany', { approve: plain === 0 ? t('inbox.harvest.all') : plain, count: items.length - plain })}` : ''}</p>
<p class="meta">${t('inbox.harvest.hint')}</p>
<form method="post" class="actions">${plain > 0 ? html`<button type="submit" class="primary" formaction="/harvest/${batch}/approve">${t('inbox.harvest.approve', { count: plain })}</button> ` : ''}<button type="submit" class="ghost" formaction="/harvest/${batch}/reject" formnovalidate>${t('inbox.harvest.rejectAll')}</button></form>
${cards.map((c) => suggestionCard(c.suggestion, c.current, { back: '/approvals', next: `batch:${batch}`, currentMeta: c.currentMeta, heldOutcome: c.heldOutcome, replaces: c.replaces, deleted: c.deleted, similar: c.similar, inBatch: true }))}
</div>`;
  };

  /** B2: a tidy proposal's card, with the facts as they are now. */
  const tidyProposalPane = (id: string, next: string | null): SafeHtml => {
    const p = d.tidy.get(id);
    if (!p || p.status !== 'pending') return html``;
    const ids = factsOf(p.body);
    const facts = new Map(ids.map((fid) => [fid, d.store.get(fid)] as const));
    const page = p.body.type === 'move_to_page' ? d.pages.get(p.body.pageId) : undefined;
    const anchor = p.body.type === 'move_to_page' ? p.body.section : '';
    const staleSay = d.tidy.staleSay(p);
    const stale = staleSay === null ? null : tKey(staleSay.key, staleSay.params);
    const staleView = stale === null ? {} : {
      asProposed: new Map(ids.map((fid) => [fid, d.tidy.textAtProposal(p, fid)] as const).filter((x): x is [string, string] => x[1] !== null)),
      now: new Map(ids.map((fid) => [fid, d.tidy.factNow(p, fid)] as const)),
    };
    return html`<div class="approvals">${tidyProposalCard({ p, facts, stale, page: page ? { title: page.title, section: sectionTitle(page.body, anchor), style: lineStyle(sectionBody(page.body, anchor)) } : null, next, ...staleView })}</div>`;
  };

  function render(res: Response, o: { status?: number; error?: string; notice?: string; pick?: InboxPick }): void {
    const model = inboxModel(d);
    // The badge shares this page's own count: no second computation.
    primeSideStatus(model.total);
    const pick = o.pick ?? null;
    const first = model.items[0] ?? null;
    let item: InboxItem | null = null;
    if (pick && 'suggestion' in pick) item = model.items.find((i) => i.key === `suggestion:${pick.suggestion}`) ?? null;
    else if (pick && 'proposal' in pick) item = model.items.find((i) => i.key === `proposal:${pick.proposal}`) ?? null;
    else if (pick && 'tidyProposal' in pick) item = model.items.find((i) => i.key === `tidyProposal:${pick.tidyProposal}`) ?? null;
    else if (pick && 'disagree' in pick) item = model.items.find((i) => i.key === `disagree:${pick.disagree}`) ?? null;
    else if (pick && 'tidy' in pick) item = model.items.find((i) => i.key === `tidy:${pick.tidy}`) ?? null;
    const batch = pick && 'batch' in pick ? pick.batch : null;
    const batchItems = batch === null ? [] : d.service.harvestBatch(batch);
    const explicit = item !== null || (pick !== null && 'all' in pick) || batchItems.length > 0;
    if (!item && !(pick && 'all' in pick) && batchItems.length === 0) item = first;

    let pane: SafeHtml = html``;
    let crumb = t('shell.nav.inbox');
    let selectedKey: string | null = null;
    let pos: string | null = null;
    if (batchItems.length > 0) {
      crumb = t('inbox.group.approvals');
      pos = t('inbox.pos.suggestions', { count: batchItems.length });
      pane = harvestPane(batch!, batchItems, pendingCards().filter((c) => c.suggestion.harvest?.batch === batch));
    } else if (pick && 'all' in pick) {
      const now = d.now();
      if (pick.all === 'disagree') { crumb = t('inbox.group.disagree'); pane = disagreementsView(disagreeGroups(), now); { const n = model.groups.find((g) => g.kind === 'disagree')?.items.length ?? 0; pos = t('inbox.pos.pairs', { count: n }); } }
      else { crumb = t('inbox.group.tidy'); pane = tidyView(tidyItems(), undefined, now); }
    } else if (item) {
      selectedKey = item.key;
      const tidyRow = item.kind === 'tidy';
      const ofKind = model.items.filter((i) => (i.kind === 'tidy') === tidyRow);
      pos = t(tidyRow ? 'inbox.pos.tidyOf' : 'inbox.pos.of', { n: ofKind.indexOf(item) + 1, total: ofKind.length });
      const next = nextOf(model, item);
      if (item.kind === 'suggestion') {
        crumb = t('inbox.group.approvals');
        const p = pendingCards().find((c) => c.suggestion.id === item!.id);
        if (p) pane = html`<div class="approvals">${suggestionCard(p.suggestion, p.current, { back: '/approvals', next, currentMeta: p.currentMeta, heldOutcome: p.heldOutcome, replaces: p.replaces, deleted: p.deleted, similar: p.similar })}</div>`;
      } else if (item.kind === 'proposal') {
        crumb = t('inbox.group.approvals');
        const p = d.skills.pendingProposals().find((x) => x.id === item!.id);
        if (p) pane = html`<div class="approvals">${proposalCard(p, p.skillId ? d.skills.get(p.skillId) : undefined, { back: '/approvals', next })}</div>`;
      } else if (item.kind === 'tidyProposal') {
        crumb = t('inbox.group.tidyProposals');
        pane = tidyProposalPane(item.id, next);
      } else if (item.kind === 'disagree') {
        crumb = t('inbox.group.disagree');
        const g = disagreeGroups(item.id)[0];
        pane = g ? html`<div class="narrow"><p class="lede">${t('inbox.disagree.ledeOne')}</p>${pairs(g.list, d.now(), '/approvals', g.project, next)}</div>` : html``;
      } else if (item.kind === 'tidy') {
        crumb = t('inbox.group.tidy');
        const only = tidyOnly(tidyItems(), item.id);
        pane = only ? tidyView(only, undefined, d.now(), 'inbox') : html``;
      } else {
        // A discussion opens on its own page; the list only counts it.
        crumb = t('inbox.group.discussions');
        pane = html`<p class="quiet">${t('inbox.discussionsWait', { count: model.groups.find((g) => g.kind === 'discussions')?.items.length ?? 0 })}</p>`;
        pos = null;
        selectedKey = null;
      }
    }
    res.status(o.status ?? 200).type('html').send(page(t('shell.nav.inbox'), inboxView({ model, selectedKey, explicit, crumb, pos, pane, notice: o.notice, error: o.error, status: takeStatusLine(d.service, d.now().getTime()) }), { nav: true, tab: 'inbox', sideTab: 'inbox', back: explicit && model.items.length > 0 ? { href: '/approvals', labelKey: 'shell.nav.inbox' } : { href: '/', labelKey: 'shell.nav.projects' }, crumb: false }));
  }

  /** /approvals?id= or ?proposal=, else the first item. */
  const fromQuery = (req: Request): InboxPick => {
    const id = one(req.query.id);
    const proposal = one(req.query.proposal);
    const batch = one(req.query.batch);
    const tidyProposal = one(req.query.tidyproposal);
    return batch ? { batch } : id ? { suggestion: id } : proposal ? { proposal } : tidyProposal ? { tidyProposal } : null;
  };

  return {
    render,
    approvals: (res: Response, status = 200, error?: string, notice?: string) => render(res, { status, error, notice }),
    approvalsPage: (req: Request, res: Response) => render(res, { pick: fromQuery(req) }),
    disagreements: (req: Request, res: Response, status = 200, error?: string) => {
      const id = one(req.query.id);
      render(res, { status, error, pick: id ? { disagree: id } : { all: 'disagree' } });
    },
    tidy: (res: Response, status = 200, error?: string, item?: string) => render(res, { status, error, pick: item ? { tidy: item } : { all: 'tidy' } }),
  };
}
