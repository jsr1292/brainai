import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../db.js';
import { createFakeEmbedder } from './fakeEmbedder.js';
import { MemoryService } from './service.js';
import { MemoryStore } from './store.js';

/*
 * A held save records the assistant's claim (what it gave for source and source_note) and is judged again on the fact
 * as it is when the owner approves it. So a change made while it waited (by the owner or another assistant) gives the
 * same fact as the assistant's save made directly at that later moment.
 */

const claude = { type: 'ai', name: 'Claude Code' } as const;
const codex = { type: 'ai', name: 'Codex' } as const;
const owner = { type: 'owner' } as const;
type Actor = typeof claude | typeof codex | typeof owner;
const HOLD = { hold: 'saves wait' };

function make() {
  const store = new MemoryStore(openDb(':memory:'), () => new Date());
  const service = new MemoryService(store, createFakeEmbedder(), { duplicateThreshold: 0.9, minRecallSimilarity: 0.2, recallConfidentSimilarity: 0.2 });
  return { service, store };
}
const show = (m: any) => ({ source: m.source, note: m.sourceNote, by: m.sourceBy });
const dec = (content: string, meta: object = {}) => ({ kind: 'decision' as const, content, project: 'harbor', meta, newProject: true });
const B2 = 'Harbor backups go to Backblaze B2';
const settle = async (service: MemoryService, r: any) => {
  if (r.status === 'suggested') return show(await service.approveSuggestion(r.suggestion.id));
  assert.equal(r.status, 'updated');
  return show(r.memory);
};
/** An assistant's change on a profile entry waits for the owner: approve it at once. */
async function applyBy(service: MemoryService, id: string, actor: Actor, input: any) {
  const r = await service.update(id, input, actor) as any;
  if (r.status === 'suggested') await service.approveSuggestion(r.suggestion.id);
}

// ---- Reviewer probes ----

test('P1 another assistant\'s quote does not end up on a held rewrite', async () => {
  const { service } = make();
  const m = (await service.remember(dec(B2), owner) as any).memory;
  const cx = await service.update(m.id, { content: 'Harbor backups go to Wasabi Frankfurt' }, codex, HOLD) as any;
  await service.update(m.id, { content: 'Harbor backups go to Hetzner Storage Box', meta: { source: 'owner_said', sourceNote: 'use the storage box' } }, claude);
  assert.deepEqual(show(await service.approveSuggestion(cx.suggestion.id)), { source: 'inferred', note: null, by: 'Codex' });
});

test('P2 the owner\'s rewrite and quote while a no-meta rewrite waits: the owner_said does not carry over', async () => {
  const { service } = make();
  const m = (await service.remember(dec(B2), owner) as any).memory;
  const cx = await service.update(m.id, { content: 'Harbor backups go to Wasabi Frankfurt' }, codex, HOLD) as any;
  await service.update(m.id, { content: 'Harbor backups go to Backblaze B2 EU', meta: { source: 'owner_said', sourceNote: 'EU region please' } }, owner);
  assert.deepEqual(show(await service.approveSuggestion(cx.suggestion.id)), { source: null, note: null, by: null });
});

test('P3/P4/P5 a held note-only change on its own owner_said, after another party changed the fact', async () => {
  const setup = async () => {
    const { service } = make();
    const m = (await service.remember(dec(B2, { source: 'owner_said', sourceNote: 'B2 it is' }), claude) as any).memory;
    const cl = await service.update(m.id, { meta: { sourceNote: 'B2, final answer' } }, claude, HOLD) as any;
    return { service, m, cl };
  };
  let t = await setup();
  await t.service.update(t.m.id, { meta: { source: 'owner_said', sourceNote: 'codex heard this' } }, codex);
  assert.deepEqual(show(await t.service.approveSuggestion(t.cl.suggestion.id)), { source: 'inferred', note: 'B2, final answer', by: 'Claude Code' });
  t = await setup();
  await t.service.update(t.m.id, { content: 'Harbor backups go to Backblaze B2 EU', meta: { source: 'owner_said', sourceNote: 'my own words' } }, owner);
  // Held text is the old text: it is a rewrite now, and the owner's owner_said is not the assistant's to keep.
  const p4 = show(await t.service.approveSuggestion(t.cl.suggestion.id));
  assert.notEqual(p4.note, 'B2, final answer', 'the assistant\'s note is never put on the owner\'s source');
  t = await setup();
  await t.service.update(t.m.id, { meta: { source: 'owner_said', sourceNote: 'my own words' } }, owner);
  assert.deepEqual(show(await t.service.approveSuggestion(t.cl.suggestion.id)), { source: 'owner_said', note: 'my own words', by: 'owner' });
});

test('N1 switching another setter\'s source drops their note, direct and held', async () => {
  for (const opts of [{}, HOLD]) {
    for (const src of ['inferred', 'from_file']) {
      const { service } = make();
      const m = (await service.remember(dec(B2, { source: 'owner_said', sourceNote: 'B2 it is, said the owner to Codex' }), codex) as any).memory;
      const r = await service.update(m.id, { meta: { source: src } }, claude, opts) as any;
      assert.deepEqual(await settle(service, r), { source: src, note: null, by: 'Claude Code' }, `${JSON.stringify(opts)} ${src}`);
    }
  }
  const { service } = make();
  const m = (await service.remember(dec(B2, { source: 'inferred', sourceNote: 'Codex session 2026-11-10' }), codex) as any).memory;
  const r = await service.update(m.id, { content: 'Harbor backups go to Wasabi', meta: { source: 'inferred' } }, claude) as any;
  assert.deepEqual(show(r.memory), { source: 'inferred', note: null, by: 'Claude Code' });
  // Its own earlier note may stay when it switches its own source.
  const m2 = (await service.remember(dec('Harbor runs on Hetzner', { source: 'inferred', sourceNote: 'my session' }), claude) as any).memory;
  const r2 = await service.update(m2.id, { meta: { source: 'from_file' } }, claude) as any;
  assert.deepEqual(show(r2.memory), { source: 'from_file', note: 'my session', by: 'Claude Code' });
});

test('M1 a held text that carries the assistant\'s suggestion is not owner_said on approval, even if the fact changed meanwhile', async () => {
  const { service } = make();
  const m = (await service.remember(dec(B2), owner) as any).memory;
  const cx = await service.update(m.id, { content: 'Harbor backups go to B2. I suggest restic nightly.', meta: { source: 'owner_said', sourceNote: 'B2 it is' } }, codex, HOLD) as any;
  await service.update(m.id, { meta: { source: 'owner_said', sourceNote: 'B2 it is' } }, claude);
  assert.deepEqual(show(await service.approveSuggestion(cx.suggestion.id)), { source: 'inferred', note: null, by: 'Codex' });
});

test('L1 a re-stated quote is recorded as given, even when it was a no-op at hold time', async () => {
  const { service } = make();
  const m = (await service.remember(dec(B2, { source: 'owner_said', sourceNote: 'B2 it is' }), claude) as any).memory;
  const r = await service.update(m.id, { keys: 'backup', meta: { source: 'owner_said', sourceNote: 'B2 it is' } }, claude, HOLD) as any;
  assert.equal(r.suggestion.source, 'owner_said');
  assert.equal(r.suggestion.sourceNote, 'B2 it is');
  await service.update(m.id, { meta: { source: 'inferred' } }, codex);
  assert.deepEqual(show(await service.approveSuggestion(r.suggestion.id)), { source: 'owner_said', note: 'B2 it is', by: 'Claude Code' });
});

test('the held row stores the claim: not given is null, given \'\' is \'\', a value is the value', async () => {
  const { service } = make();
  const m = (await service.remember(dec(B2, { source: 'owner_said', sourceNote: 'B2 it is' }), claude) as any).memory;
  const cases: [any, any, any][] = [
    [{ keys: 'a' }, null, null],
    [{ keys: 'b', meta: { source: 'inferred' } }, 'inferred', null],
    [{ keys: 'c', meta: { sourceNote: 'x' } }, null, 'x'],
    [{ keys: 'd', meta: { sourceNote: '' } }, null, ''],
    [{ keys: 'e', meta: { source: null } }, '', null],
    [{ keys: 'f', meta: { source: 'owner_said', sourceNote: 'q' } }, 'owner_said', 'q'],
  ];
  for (const [input, source, note] of cases) {
    const r = await service.update(m.id, input, claude, HOLD) as any;
    assert.equal(r.suggestion.source, source, JSON.stringify(input));
    assert.equal(r.suggestion.sourceNote, note, JSON.stringify(input));
  }
});

test('R1/R2 a held roadmap add that lands on a roadmap saved meanwhile is judged on that roadmap', async () => {
  const RM1 = 'Now: set up restic\nNext: pick a bucket';
  const RM2 = 'Now: set up borg\nNext: pick a bucket in the EU';
  const { service } = make();
  await service.remember(dec('Harbor exists'), owner);
  const cl = await service.remember({ kind: 'roadmap', content: RM1, project: 'harbor', hold: 'saves wait' }, claude) as any;
  await service.remember({ kind: 'roadmap', content: RM2, project: 'harbor', meta: { source: 'owner_said', sourceNote: 'borg and EU please' } }, codex);
  assert.deepEqual(show(await service.approveSuggestion(cl.suggestion.id)), { source: 'inferred', note: null, by: 'Claude Code' });
  const { service: s2 } = make();
  await s2.remember(dec('Harbor exists'), owner);
  const cl2 = await s2.remember({ kind: 'roadmap', content: RM1, project: 'harbor', hold: 'saves wait' }, claude) as any;
  await s2.remember({ kind: 'roadmap', content: RM2, project: 'harbor', meta: { source: 'owner_said', sourceNote: 'my plan' } }, owner);
  assert.deepEqual(show(await s2.approveSuggestion(cl2.suggestion.id)), { source: null, note: null, by: null });
});

// ---- The table: direct at T2 after a change equals held at T1, the change, approved at T2 ----

interface KindSpec { kind: 'decision' | 'profile' | 'roadmap'; base: string; ownerText: string; codexText: string; rewrite: string; mixed: string }
const KINDS: KindSpec[] = [
  { kind: 'decision', base: B2, ownerText: 'Harbor backups go to Backblaze B2 EU', codexText: 'Harbor backups go to Hetzner Storage Box', rewrite: 'Harbor backups go to Wasabi', mixed: 'Harbor backups go to B2. I suggest restic nightly.' },
  { kind: 'profile', base: 'The owner lives in Valencia', ownerText: 'The owner lives in Valencia, Spain', codexText: 'The owner lives in Valencia and works remotely', rewrite: 'The owner lives in Valencia and likes paella', mixed: 'The owner lives in Valencia. I suggest adding that they like paella.' },
  { kind: 'roadmap', base: 'Now: set up restic\nNext: pick a bucket', ownerText: 'Now: set up restic EU\nNext: pick a bucket', codexText: 'Now: set up borg\nNext: pick a bucket', rewrite: 'Now: set up rclone\nNext: pick a bucket', mixed: 'Now: set up restic\nNext: I suggest picking Wasabi' },
];
const SETUPS: { name: string; by: Actor; meta: object }[] = [
  { name: 'no source', by: owner, meta: {} },
  { name: 'owner-set owner_said', by: owner, meta: { source: 'owner_said', sourceNote: 'B2 please' } },
];
const CODEX_SETUP = { name: 'codex owner_said', by: codex, meta: { source: 'owner_said', sourceNote: 'B2 it is' } };
const CHANGES: { name: string; actor: Actor | null; input: (k: KindSpec) => object; textChanges: boolean }[] = [
  { name: 'nothing', actor: null, input: () => ({}), textChanges: false },
  { name: 'owner rewrites with owner_said + note', actor: owner, input: (k) => ({ content: k.ownerText, meta: { source: 'owner_said', sourceNote: 'EU please' } }), textChanges: true },
  { name: 'owner sets owner_said + note', actor: owner, input: () => ({ meta: { source: 'owner_said', sourceNote: 'my own words' } }), textChanges: false },
  { name: 'codex sets owner_said + quote', actor: codex, input: (k) => ({ content: k.codexText, meta: { source: 'owner_said', sourceNote: 'codex heard this' } }), textChanges: true },
  { name: 'codex switches to inferred', actor: codex, input: () => ({ meta: { source: 'inferred', sourceNote: 'codex session' } }), textChanges: false },
];
const INPUTS: { name: string; input: (k: KindSpec) => any; needsText: boolean }[] = [
  { name: 'rewrite, no meta', input: (k) => ({ content: k.rewrite }), needsText: false },
  { name: 'rewrite + fresh quote', input: (k) => ({ content: k.rewrite, meta: { source: 'owner_said', sourceNote: 'use it' } }), needsText: false },
  { name: 'rewrite + owner_said, no note', input: (k) => ({ content: k.rewrite, meta: { source: 'owner_said' } }), needsText: false },
  { name: 'rewrite + note only', input: (k) => ({ content: k.rewrite, meta: { sourceNote: 'a note' } }), needsText: false },
  { name: 'rewrite with its own suggestion + quote', input: (k) => ({ content: k.mixed, meta: { source: 'owner_said', sourceNote: 'B2 it is' } }), needsText: false },
  { name: 'meta only: owner_said + quote', input: () => ({ meta: { source: 'owner_said', sourceNote: 'a quote' } }), needsText: true },
  { name: 'meta only: note only', input: () => ({ meta: { sourceNote: 'a note' } }), needsText: true },
  { name: 'meta only: switch to inferred', input: () => ({ meta: { source: 'inferred' } }), needsText: true },
  { name: 'meta only: clear source', input: () => ({ meta: { source: null } }), needsText: true },
  // Text left out: the held row carries the text read at T1, so a change of text meanwhile is a different save (not compared).
  { name: 'keys only', input: () => ({ keys: 'k' }), needsText: true },
  { name: 'keys + restate owner_said + quote', input: () => ({ keys: 'k', meta: { source: 'owner_said', sourceNote: 'a quote' } }), needsText: true },
];

async function create(service: MemoryService, k: KindSpec, s: { by: Actor; meta: object }): Promise<string> {
  if (k.kind === 'decision') return ((await service.remember(dec(k.base, s.meta), s.by) as any).memory).id;
  await service.remember(dec('Harbor exists'), owner);
  const meta = s.by === owner ? s.meta : {};
  return ((await service.remember({ kind: k.kind, content: k.base, project: k.kind === 'roadmap' ? 'harbor' : undefined, meta }, owner) as any).memory).id;
}

const fullShow = (m: any) => ({ ...show(m) });
for (const k of KINDS) {
  for (const s of k.kind === 'decision' ? [...SETUPS, CODEX_SETUP] : SETUPS) {
    for (const ch of CHANGES) {
      for (const inp of INPUTS) {
        if (inp.needsText && ch.textChanges) continue;
        // A profile or roadmap has no Codex-owned setup; the owner-set cases stand for it.
        test(`direct at T2 equals held at T1 then approved: ${k.kind} / ${s.name} / ${ch.name} / ${inp.name}`, async () => {
          const run = async (held: boolean) => {
            const { service } = make();
            const id = await create(service, k, s);
            let r: any;
            // A note with no source to hang on is refused when it is saved: at T1 that ends the held case (nothing waits).
            if (held) { try { r = await service.update(id, inp.input(k), claude, HOLD); } catch { return null; } }
            if (ch.actor) await applyBy(service, id, ch.actor, ch.input(k));
            if (!held) r = await service.update(id, inp.input(k), claude);
            return fullShow(await (async () => {
              if (r.status === 'suggested') return service.approveSuggestion(r.suggestion.id);
              assert.equal(r.status, 'updated');
              return r.memory;
            })());
          };
          const heldRun = await run(true);
          if (heldRun === null) return;
          assert.deepEqual(heldRun, await run(false));
        });
      }
    }
  }
}

/** A held add that lands on a roadmap saved meanwhile (one per project). */
const ROAD_ADD: { name: string; apply: ((service: MemoryService) => Promise<unknown>) | null }[] = [
  { name: 'nothing', apply: null },
  { name: 'owner saves it with owner_said', apply: (s) => s.remember({ kind: 'roadmap', content: 'Now: set up borg\nNext: pick a bucket', project: 'harbor', meta: { source: 'owner_said', sourceNote: 'my plan' } }, owner) },
  { name: 'codex saves it with a quote', apply: (s) => s.remember({ kind: 'roadmap', content: 'Now: set up borg\nNext: pick a bucket', project: 'harbor', meta: { source: 'owner_said', sourceNote: 'borg please' } }, codex) },
  { name: 'codex saves it as inferred', apply: (s) => s.remember({ kind: 'roadmap', content: 'Now: set up borg\nNext: pick a bucket', project: 'harbor', meta: { source: 'inferred', sourceNote: 'codex session' } }, codex) },
];
const ROAD_META: { name: string; meta: object }[] = [
  { name: 'no meta', meta: {} },
  { name: 'owner_said + quote', meta: { source: 'owner_said', sourceNote: 'a quote' } },
  { name: 'owner_said, no note', meta: { source: 'owner_said' } },
  { name: 'inferred + note', meta: { source: 'inferred', sourceNote: 'session' } },
];
for (const ra of ROAD_ADD) {
  for (const rm of ROAD_META) {
    test(`roadmap add: direct at T2 equals held at T1 then approved: ${ra.name} / ${rm.name}`, async () => {
      const add = (service: MemoryService, opts: object) =>
        service.remember({ kind: 'roadmap', content: 'Now: set up restic\nNext: pick a bucket', project: 'harbor', meta: rm.meta, ...opts }, claude) as Promise<any>;
      const run = async (held: boolean) => {
        const { service } = make();
        await service.remember(dec('Harbor exists'), owner);
        let r: any;
        if (held) r = await add(service, HOLD);
        if (ra.apply) await ra.apply(service);
        if (!held) r = await add(service, {});
        if (r.status === 'suggested') return show(await service.approveSuggestion(r.suggestion.id));
        return show(r.memory);
      };
      assert.deepEqual(await run(true), await run(false));
    });
  }
}
