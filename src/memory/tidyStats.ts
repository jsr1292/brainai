import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Clock } from '../clock.js';
import type { DB } from '../db.js';
import { GrowthService } from '../growth/service.js';
import { GrowthStore } from '../growth/store.js';
import { buildMcpServer } from '../mcp/server.js';
import { BRIEF_BUDGET } from '../mcp/budget.js';
import { NoteService } from '../pages/notes.js';
import { PageService } from '../pages/service.js';
import { PageStore } from '../pages/store.js';
import { ProjectStore } from '../projects/store.js';
import { isStatus } from './brief.js';
import type { Embedder } from './embedder.js';
import { MemoryService } from './service.js';
import { MemoryStore } from './store.js';

/**
 * B2 measure helper (`cli tidy-stats <project>`): a project's facts, the size of the brief an assistant gets from
 * project_brief (the real tool, run in memory), and how many decisions and statuses that brief shortens or leaves
 * out, so a tidy session can be compared before and after.
 */
export interface TidyStats {
  project: string;
  facts: { current: number; decisions: number; statuses: number; roadmap: number; profile: number; replaced: number };
  briefChars: number; briefLimit: number;
  decisions: { total: number; full: number; excerpts: number; left_out: number };
  statuses: { total: number; full: number; excerpts: number; left_out: number };
}

/** Nothing here needs vectors: the brief is read from the facts as they are. */
const noEmbedder: Embedder = { async embed() { throw new Error('tidy-stats reads facts only; it needs no embeddings'); } };

export async function tidyStats(db: DB, project: string, now: Clock = () => new Date()): Promise<TidyStats> {
  const store = new MemoryStore(db, now);
  const service = new MemoryService(store, noEmbedder, { duplicateThreshold: 0.99, minRecallSimilarity: 0.2, recallConfidentSimilarity: 0.2 });
  // A measurement must not change the brain it measures: no "recalled just now" marks and no tool-call log.
  service.observeOnly = true;
  const name = service.projectNamed(project);
  const current = store.list({ project: name });
  if (current.length === 0) throw new Error(`No facts for project ${JSON.stringify(project)}.`);
  const registry = new ProjectStore(db, now);
  const pages = new PageService(new PageStore(db, now), noEmbedder, service, registry, store, now);
  const growth = new GrowthService(new GrowthStore(db, now), noEmbedder, service, registry, store, { duplicateThreshold: 0.99 }, now);
  const server = buildMcpServer(service, 'tidy-stats', { registry, growth, pages, notes: new NoteService(db, pages, now) });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: 'tidy-stats', version: '0' });
  await client.connect(ct);
  let text: string;
  try {
    const r = await client.callTool({ name: 'project_brief', arguments: { project: name } }) as { content: { text: string }[] };
    text = r.content[0]!.text;
  } finally {
    await client.close();
  }
  const json = /<memories>\n([\s\S]*)\n<\/memories>/.exec(text)?.[1];
  const brief = json ? JSON.parse(json) as { statuses: { excerpt?: boolean }[]; decisions: { excerpt?: boolean }[] } : { statuses: [], decisions: [] };
  const statuses = current.filter(isStatus);
  const decisions = current.filter((m) => m.kind === 'decision' && !isStatus(m));
  const part = (total: number, rows: { excerpt?: boolean }[]) => {
    const excerpts = rows.filter((r) => r.excerpt === true).length;
    return { total, full: rows.length - excerpts, excerpts, left_out: total - rows.length };
  };
  return {
    project: name,
    facts: {
      current: current.length, decisions: decisions.length, statuses: statuses.length, roadmap: current.filter((m) => m.kind === 'roadmap').length,
      profile: current.filter((m) => m.kind === 'profile').length, replaced: store.list({ project: name, replaced: 'only' }).length,
    },
    briefChars: text.length, briefLimit: BRIEF_BUDGET,
    decisions: part(decisions.length, brief.decisions), statuses: part(statuses.length, brief.statuses),
  };
}

export function formatTidyStats(s: TidyStats): string {
  const n = (x: number) => x.toLocaleString('en-US');
  return [
    `Project: ${s.project}`,
    `Facts: ${s.facts.current} current (${s.facts.decisions} decisions, ${s.facts.statuses} statuses, ${s.facts.roadmap} roadmap, ${s.facts.profile} profile), ${s.facts.replaced} replaced`,
    `Brief: ${n(s.briefChars)} characters (limit ${n(s.briefLimit)})`,
    `Decisions: ${s.decisions.total} in all; the brief shows ${s.decisions.full} in full, shortens ${s.decisions.excerpts} to excerpts and leaves out ${s.decisions.left_out}`,
    `Statuses: ${s.statuses.total} in all; the brief shows ${s.statuses.full} in full, shortens ${s.statuses.excerpts} to excerpts and leaves out ${s.statuses.left_out}`,
  ].join('\n');
}
