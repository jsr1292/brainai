/*
 * The link picker (UI round, task 4): what a [[ link can point at. The editor asks this route for the pages and the
 * facts whose names match what has been typed, and puts back the text that makes the link.
 */
import { Router } from 'express';
import { PAGE_AREA_LABELS } from '../pages/types.js';
import type { AppDeps } from './app.js';
import { requireOwner } from './authRoutes.js';

/** One thing a link can point at: a page by its title, a fact by its id. */
export interface LinkTarget {
  kind: 'page' | 'fact';
  /** What the picker shows: the page's title, or the first words of the fact. */
  label: string;
  /** Where it lives: the project, or the area when the page has no project. */
  detail: string;
  /** The text that goes into the page: the whole link, brackets and all. */
  insert: string;
}

/** The link a title gets: [[title]], or nothing when the title cannot be written that way. */
export function linkInsert(title: string): string | null {
  return /\]\]|\[\[|\r|\n/.test(title) ? null : `[[${title}]]`;
}

/** At most this many things are offered, pages first and then facts. */
const MAX_TARGETS = 8;
/** A word shorter than this is not worth looking up. */
const MIN_WORD = 2;

/** The owner's pages and facts, for the editor's [[ picker. */
export function linkRoutes(d: AppDeps): Router {
  const router = Router();
  const owner = requireOwner(d.sessions);

  router.get('/pages/link-targets.json', owner, async (req, res) => {
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    res.set('Cache-Control', 'no-store');
    if (q.length < MIN_WORD) {
      res.json([]);
      return;
    }
    const targets: LinkTarget[] = [];
    for (const hit of d.pages.titlesMatching(q, 6)) {
      const insert = linkInsert(hit.title);
      if (!insert) continue; // a title with ]] or [[ in it cannot be written as a link
      const page = d.pages.get(hit.id);
      const detail = page
        ? page.project ? d.service.projectNamed(page.project) : page.area ? PAGE_AREA_LABELS[page.area] : ''
        : '';
      targets.push({ kind: 'page', label: hit.title, detail, insert });
    }
    // Facts come after the pages, and only for a word long enough to mean something.
    if (q.length >= 3) {
      const facts = await d.service.recall({ query: q, limit: 3, touch: false });
      for (const hit of facts) {
        if (hit.replaced) continue;
        targets.push({ kind: 'fact', label: hit.memory.content.slice(0, 80), detail: hit.memory.project ?? '', insert: `[[fact:${hit.memory.id}]]` });
      }
    }
    res.json(targets.slice(0, MAX_TARGETS));
  });

  return router;
}
