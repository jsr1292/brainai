import { EMBEDDING_DIM } from '../memory/embedder.js';
import type { Kind, Memory } from '../memory/types.js';
import type { Page } from '../pages/types.js';
import { ProjectStore } from '../projects/store.js';
import { makePages, makeService } from './helpers.js';

/**
 * The default fact vector: -1 at index 0 and 0 elsewhere. The fake embedder's section vectors have no negative
 * component, so this is never close in meaning to any section; a test that wants a match passes a section's own vector.
 */
export const FAR = (() => { const v = new Float32Array(EMBEDDING_DIM); v[0] = -1; return v; })();

/**
 * A brain on one mutable clock for working out which pages may be out of date: facts saved, changed, moved, removed
 * and replaced at given moments without going through the embedder, and pages created at given moments.
 */
export function freshnessWorld(startIso: string, opts: { sectionMatch?: number | null } = {}) {
  let t = Date.parse(startIso);
  const now = () => new Date(t);
  const { db, store, service } = makeService({ now });
  const registry = new ProjectStore(db, now);
  const pages = makePages({ db, store, service }, now, opts);
  const at = (iso: string): void => { t = Date.parse(iso); };
  const ensure = (project: string | null) => {
    if (project !== null && !registry.get(project) && store.list({ project, limit: 1, replaced: 'include' }).length === 0) registry.create(project, { state: 'open', area: 'apps' }, 'owner');
  };
  return {
    db, store, service, registry, pages, now, at,
    /** Saves a fact (a decision unless `kind` says otherwise) at `iso`. */
    decision(iso: string, text: string, project: string | null, o: { tags?: string[]; by?: string; embedding?: Float32Array; kind?: Kind } = {}): Memory {
      at(iso);
      return store.insert({ kind: o.kind ?? 'decision', content: text, project, tags: o.tags ?? [], embedding: o.embedding ?? FAR, by: o.by ?? 'Claude Code' });
    },
    /** Rewrites a fact's text at `iso`. */
    edit(iso: string, id: string, text: string): Memory {
      at(iso);
      const m = store.get(id)!;
      return store.update(id, { content: text, project: m.project, tags: m.tags, embedding: store.embeddingsOf([id]).get(id) ?? FAR, by: 'Claude Code' });
    },
    /** Moves a fact to another project or changes its tags at `iso`, as the owner's relabel does. */
    relabel(iso: string, id: string, f: { project?: string | null; tags?: string[] }): Memory {
      at(iso);
      const m = store.get(id)!;
      if (f.project !== undefined) ensure(f.project);
      return store.relabel(id, { project: f.project === undefined ? m.project : f.project, tags: f.tags ?? m.tags, by: 'owner' });
    },
    remove(iso: string, id: string): void {
      at(iso);
      store.softDelete(id, 'owner');
    },
    /** Undoes a fact's delete through its history, as the owner's Restore does. */
    bringBack(iso: string, id: string): Memory {
      at(iso);
      const h = store.history(id).find((e) => e.action === 'delete')!;
      return store.restore(h.id, 'owner', null);
    },
    /** `newId` replaces `oldId` at `iso`; returns the supersessions row id. */
    replace(iso: string, oldId: string, newId: string): number {
      at(iso);
      return store.supersessions.add(oldId, newId, 'owner').id;
    },
    undoReplace(iso: string, rowId: number): void {
      at(iso);
      store.supersessions.undo(rowId, 'owner');
    },
    /** Creates a page at `iso` (its project made first when it has no facts and no registry row yet). */
    async page(iso: string, title: string, project: string | null, body: string, by = 'Claude Code'): Promise<Page> {
      at(iso);
      ensure(project);
      return pages.create(project === null ? { title, area: 'start', body } : { title, project, body }, by);
    },
  };
}
export type FreshnessWorld = ReturnType<typeof freshnessWorld>;
