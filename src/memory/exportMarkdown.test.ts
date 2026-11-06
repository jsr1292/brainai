import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../db.js';
import { EMBEDDING_DIM } from './embedder.js';
import { exportMarkdown } from './exportMarkdown.js';
import { MemoryStore } from './store.js';

test('exportMarkdown lists the profile, then each project, then memories with no project; deleted ones are left out', () => {
  let t = Date.parse('2026-10-01T00:00:00Z');
  const store = new MemoryStore(openDb(':memory:'), () => new Date((t += 60_000)));
  const add = (kind: 'profile' | 'decision' | 'summary', content: string, project: string | null = null, tags: string[] = []) =>
    store.insert({ kind, content, project, tags, embedding: new Float32Array(EMBEDDING_DIM), by: 'Codex' });
  add('profile', 'Works as a librarian.');
  add('decision', 'Use pnpm.', 'drafting-tool', ['tooling']);
  add('summary', 'Old status.', 'drafting-tool');
  add('decision', 'Report template v2.\nApproved by Sam.', 'drafting-tool');
  add('summary', 'New status.', 'drafting-tool');
  add('decision', 'Newsletter every Friday.');
  store.softDelete(add('decision', 'Gone.', 'drafting-tool').id, 'owner');

  assert.equal(exportMarkdown(store, 'Work memory', new Date('2026-10-20T09:00:00Z')), [
    '# Work memory', '', 'Exported 2026-10-20: 6 memories.', '',
    '## Profile', '', '- Works as a librarian. (2026-10-01, Codex)', '',
    '## drafting-tool', '',
    '### Statuses', '', '- New status. (2026-10-01, Codex)', '- Old status. (2026-10-01, Codex)', '',
    '### Decisions', '', '- Use pnpm. [tooling] (2026-10-01, Codex)', '- Report template v2. Approved by Sam. (2026-10-01, Codex)', '',
    '## No project', '',
    '### Decisions', '', '- Newsletter every Friday. (2026-10-01, Codex)', '',
  ].join('\n'));
});

test('each project lists its replaced facts under ### Replaced', () => {
  let t = Date.parse('2026-10-01T00:00:00Z');
  const store = new MemoryStore(openDb(':memory:'), () => new Date((t += 60_000)));
  const add = (content: string, project: string | null) =>
    store.insert({ kind: 'decision', content, project, tags: [], embedding: new Float32Array(EMBEDDING_DIM), by: 'Codex' });
  const a = add('Use npm.', 'drafting-tool');
  const b = add('Use pnpm.', 'drafting-tool');
  store.supersessions.add(a.id, b.id, 'owner');
  const x = add('Labels in Futura.', 'labels');
  const y = add('Labels in Avenir.', 'labels');
  store.supersessions.add(x.id, y.id, 'owner');
  store.update(y.id, { content: 'Labels in Avenir.', project: 'drafting-tool', tags: [], embedding: new Float32Array(EMBEDDING_DIM), by: 'owner' });
  const out = exportMarkdown(store, 'Work memory', new Date('2026-10-20T09:00:00Z'));
  assert.match(out, new RegExp(`## drafting-tool\\n\\n### Decisions\\n\\n- Use pnpm\\. \\(2026-10-01, Codex\\)\\n- Labels in Avenir\\. \\(2026-10-01, owner\\)\\n\\n### Replaced\\n\\n- Use npm\\. \\(2026-10-01, Codex\\) \\(replaced by ${b.id}\\)\\n`));
  assert.match(out, new RegExp(`## labels\\n\\n### Replaced\\n\\n- Labels in Futura\\. \\(2026-10-01, Codex\\) \\(replaced by ${y.id}\\)\\n`));
});
