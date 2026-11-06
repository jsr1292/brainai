import type { MemoryStore } from './store.js';
import type { Supersession } from './supersessions.js';
import type { Memory } from './types.js';

const day = (iso: string) => iso.slice(0, 10);

function line(m: Memory): string {
  const tags = m.tags.length > 0 ? ` [${m.tags.join(', ')}]` : '';
  // One memory per bullet: line breaks inside a memory are folded so the list stays readable.
  return `- ${m.content.replace(/\s*\n\s*/g, ' ')}${tags} (${day(m.updatedAt)}, ${m.updatedBy})`;
}

/**
 * Every active memory as one readable Markdown file: the profile, then each project's statuses (newest first) and
 * decisions (oldest first), then memories with no project. For handing over or keeping a copy when leaving a job.
 */
export function exportMarkdown(store: MemoryStore, title: string, now: Date): string {
  // Replaced facts are kept too (section 16), under "### Replaced" in their project, each naming what replaced it.
  const everything = store.list({ replaced: 'include' });
  const replacedBy = new Map(everything.map((m) => [m.id, store.supersessions.liveFor(m.id)] as const).filter((e): e is [string, Supersession] => e[1] !== undefined));
  const all = everything.filter((m) => !replacedBy.has(m.id));
  const out = [`# ${title}`, '', `Exported ${day(now.toISOString())}: ${everything.length} memories.`, ''];
  const section = (heading: string, memories: Memory[]) => {
    if (memories.length === 0) return;
    out.push(heading, '', ...memories.map(line), '');
  };
  const byOldest = (a: Memory, b: Memory) => a.createdAt.localeCompare(b.createdAt);
  section('## Profile', all.filter((m) => m.kind === 'profile').sort(byOldest));
  const group = (ms: Memory[], replaced: Memory[], name: string) => {
    if (ms.length === 0 && replaced.length === 0) return;
    out.push(`## ${name}`, '');
    section('### Roadmap', ms.filter((m) => m.kind === 'roadmap'));
    section('### Statuses', ms.filter((m) => m.kind === 'summary'));
    section('### Decisions', ms.filter((m) => m.kind === 'decision').sort(byOldest));
    if (replaced.length === 0) return;
    const rowOf = (m: Memory) => replacedBy.get(m.id)!;
    const olds = [...replaced].sort((a, b) => rowOf(a).createdAt.localeCompare(rowOf(b).createdAt) || rowOf(a).id - rowOf(b).id);
    out.push('### Replaced', '', ...olds.map((m) => `${line(m)} (replaced by ${rowOf(m).newId})`), '');
  };
  const replaced = everything.filter((m) => replacedBy.has(m.id));
  for (const { project } of store.listProjects({ replaced: 'include' })) {
    group(all.filter((m) => m.kind !== 'profile' && m.project === project), replaced.filter((m) => m.project === project), project);
  }
  group(all.filter((m) => m.kind !== 'profile' && m.project === null), replaced.filter((m) => m.project === null), 'No project');
  return out.join('\n');
}
