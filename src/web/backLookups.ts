import { MemoryError } from '../memory/service.js';
import type { AppDeps } from './app.js';
import type { BackLookups } from './back.js';

/**
 * The live lookups `backFrom` needs, so a back link can name what it returns to: a live page's title, a project's
 * current name (a merged project's old name is followed), and a discussion that still exists.
 */
export function backLookups(d: AppDeps): BackLookups {
  return {
    pageTitle: (id) => {
      const p = d.pages.get(id);
      return p && p.deletedAt === null ? p.title : undefined;
    },
    projectName: (name) => {
      const current = d.service.projectNamed(name);
      return d.service.listProjects().some((p) => p.project === current) || d.registry.get(current) ? current : undefined;
    },
    discussionTitle: (id) => {
      try {
        return d.discussions.ownerView(id).title;
      } catch (e) {
        if (e instanceof MemoryError && e.code === 'not_found') return undefined;
        throw e;
      }
    },
  };
}
