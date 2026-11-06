import { DeviceService } from '../folders/devices.js';
import { FolderService } from '../folders/match.js';
import { GraphService } from '../graph/data.js';
import { MeaningIndex } from '../graph/threads.js';
import type { Kind } from '../memory/types.js';
import { ProjectsService } from '../projects/service.js';
import { ProjectStore } from '../projects/store.js';
import { makePages, makeService } from './helpers.js';

/**
 * A brain on one mutable clock for the graph: the memory, page and project services and a meaning index with a test
 * floor (default 0.5, since the fake embedder's similarities are not e5's) and kinds (default decisions only).
 */
export function graphWorld(opts: { floor?: number; kinds?: Kind[]; start?: string } = {}) {
  let t = Date.parse(opts.start ?? '2026-11-04T10:00:00Z');
  const now = () => new Date(t);
  const { db, store, service } = makeService({ now });
  const registry = new ProjectStore(db, now);
  const pages = makePages({ db, store, service }, now);
  const folders = new FolderService(new DeviceService(db, now), registry, service, now);
  const projects = new ProjectsService(registry, service, store, undefined, pages, folders);
  const meaning = new MeaningIndex(db, { floor: opts.floor ?? 0.5, kinds: opts.kinds ?? ['decision'], now });
  service.setMeaningHook(meaning);
  pages.setMeaningHook(meaning);
  const graph = new GraphService({ db, projects, registry, service, pages, meaning, now });
  return {
    db, store, service, pages, registry, projects, meaning, graph, now,
    advance(ms: number): void { t += ms; },
    owner: { type: 'owner' } as const,
    ai: { type: 'ai', name: 'Claude Code' } as const,
  };
}
export type GraphWorld = ReturnType<typeof graphWorld>;
