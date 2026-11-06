import { DeviceService } from '../folders/devices.js';
import { FolderService } from '../folders/match.js';
import type { Kind, Memory } from '../memory/types.js';
import type { FolderSource } from '../projects/service.js';
import { ProjectStore } from '../projects/store.js';
import type { BuildSources } from '../review/build.js';
import { ReviewStore } from '../review/store.js';
import { makeGrowth, makePages, makeService } from './helpers.js';

const EMB = new Float32Array(4);

/**
 * A brain on one mutable clock for building weekly reviews: every store, and helpers that save or change a memory at
 * a given moment without going through the embedder.
 */
export function reviewWorld(startIso: string) {
  let t = Date.parse(startIso);
  const now = () => new Date(t);
  const { db, store, service } = makeService({ now });
  const registry = new ProjectStore(db, now);
  const pages = makePages({ db, store, service }, now);
  const growth = makeGrowth({ db, store, service }, now);
  const devices = new DeviceService(db, now);
  const folders = new FolderService(devices, registry, service, now);
  const reviews = new ReviewStore(db);
  const grants: { clientName: string; createdAt: string }[] = [];
  const at = (iso: string): void => { t = Date.parse(iso); };
  return {
    db, store, service, registry, pages, growth, devices, folders, reviews, grants, now, at,
    /** Saves a memory at `iso`. */
    save(iso: string, m: { kind?: Kind; content: string; project: string | null; by?: string }): Memory {
      at(iso);
      return store.insert({ kind: m.kind ?? 'decision', content: m.content, project: m.project, tags: [], embedding: EMB, by: m.by ?? 'Claude Code' });
    },
    /** Rewrites a memory's text at `iso`. */
    edit(iso: string, id: string, content: string, by = 'Claude Code'): Memory {
      at(iso);
      const m = store.get(id)!;
      return store.update(id, { content, project: m.project, tags: m.tags, embedding: EMB, by });
    },
    sources(opts: { growth?: boolean; folders?: FolderSource } = {}): BuildSources {
      return { reviews, memories: store, registry, folders: opts.folders ?? folders, grants: () => grants, growth: opts.growth ?? true };
    },
  };
}
export type ReviewWorld = ReturnType<typeof reviewWorld>;
