/**
 * Adversarial: do "Pause all saves" and "Saves wait for me" cover EVERY write an assistant can reach?
 * The list of write tools is read from the live tool registry, so a tool added later is covered (or fails the
 * classification test below until someone decides what it is).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WRITE_TOOLS, SAVES_PAUSED } from '../mcp/server.js';
import { connectClient, loggedIn, startTestApp } from '../testing/helpers.js';
import { callTool, changedTables, fingerprint, seedWorld, toolNames, writeCalls } from './support.js';

/** Tools that only read. A new tool must be added here or to WRITE_TOOLS in src/mcp/server.ts. */
const READ_TOOLS = new Set([
  'list_discussions', 'list_pages', 'list_projects', 'list_skills', 'load_profile', 'load_skill', 'project_brief', 'read_discussion', 'read_page',
  'recall', 'recent_work', 'tidy_session', 'view_image', 'weekly_review', 'whats_left',
]);

async function world() {
  const app = await startTestApp();
  try { return await seededWorld(app); } catch (e) { await app.close(); throw e; }
}

async function seededWorld(app: Awaited<ReturnType<typeof startTestApp>>) {
  const f = await loggedIn(app);
  const { accessToken } = await connectClient(app.baseUrl, f);
  const w = await seedWorld(app);
  const grantId = app.deps.provider.listGrants()[0]!.id;
  return { app, f, token: accessToken, w, grantId };
}

test('every tool a full connection is offered is classified as a read or a write (a new tool cannot skip the pause switch)', async () => {
  const { app, token } = await world();
  try {
    const offered = await toolNames(app.baseUrl, token);
    const unclassified = offered.filter((n) => !WRITE_TOOLS.has(n) && !READ_TOOLS.has(n));
    assert.deepEqual(unclassified, [], 'classify each new tool in WRITE_TOOLS (src/mcp/server.ts) or READ_TOOLS (this file)');
    for (const n of WRITE_TOOLS) assert.ok(offered.includes(n), `WRITE_TOOLS names ${n}, which no connection is offered`);
    for (const n of READ_TOOLS) assert.ok(offered.includes(n), `READ_TOOLS names ${n}, which no connection is offered`);
  } finally { await app.close(); }
});

test('every write tool has a test call here, so the pause test below cannot skip one', async () => {
  const { app, w } = await world();
  try { assert.deepEqual(Object.keys(writeCalls(w)).sort(), [...WRITE_TOOLS].sort()); } finally { await app.close(); }
});

test('Pause all saves: every write tool is refused and writes nothing; the same call works once saving is resumed', async () => {
  const { app, token, w } = await world();
  const calls = writeCalls(w);
  try {
    for (const tool of WRITE_TOOLS) {
      app.deps.service.setSavesPaused(true);
      const before = fingerprint(app.deps.db!);
      const paused = await callTool(app.baseUrl, token, tool, calls[tool]);
      assert.equal(paused.result?.isError, true, `${tool} should be refused while paused: ${paused.text}`);
      assert.equal(paused.text, SAVES_PAUSED, `${tool}: ${paused.text}`);
      assert.deepEqual(changedTables(before, fingerprint(app.deps.db!)), [], `${tool} wrote while paused`);
      // Not vacuous: the very same call changes something once saving is on again.
      app.deps.service.setSavesPaused(false);
      const live = await callTool(app.baseUrl, token, tool, calls[tool]);
      assert.notEqual(live.result?.isError, true, `${tool} should work when not paused: ${live.text}`);
      assert.notDeepEqual(changedTables(before, fingerprint(app.deps.db!)), [], `${tool} changed nothing even when saving is on: the test call is not exercising it`);
    }
  } finally { await app.close(); }
});

/** What "Saves wait for me" does to each write tool: refused outright, held in the Inbox, or left to the owner's approval anyway. */
const REFUSED = ['write_page', 'edit_page_section', 'begin_image_upload', 'add_page_image', 'resolve_note', 'set_project_info', 'set_project_area', 'record_lesson', 'close_discussion', 'flag_disagreement', 'note_observation'];
const HELD = ['remember', 'update_memory', 'forget', 'suggest_memories'];
/** Proposals and discussion posts: they never become live memory by themselves (the owner approves or reads them). */
const APPROVAL_GATED = ['propose_skill', 'propose_tidy', 'open_discussion', 'reply_to_discussion'];

test('Saves wait for me: every write tool is refused, held or approval-gated, and none changes live memory, pages or projects', async () => {
  assert.deepEqual([...REFUSED, ...HELD, ...APPROVAL_GATED].sort(), [...WRITE_TOOLS].sort(), 'classify each write tool for the saves-wait test');
  const { app, token, w, grantId } = await world();
  const calls = writeCalls(w);
  const LIVE = ['memories', 'memory_history', 'supersessions', 'disagreements', 'projects', 'project_checks', 'handbook_topics', 'observations', 'pages', 'page_versions', 'page_sections', 'images', 'image_upload_links', 'notes', 'skills'];
  try {
    app.deps.provider.setGrantSavesWait(grantId, true);
    for (const tool of [...REFUSED, ...HELD, ...APPROVAL_GATED]) {
      const before = fingerprint(app.deps.db!);
      const r = await callTool(app.baseUrl, token, tool, calls[tool]);
      const changed = changedTables(before, fingerprint(app.deps.db!));
      assert.deepEqual(changed.filter((t) => LIVE.includes(t)), [], `${tool} changed live data on a connection whose saves wait: ${changed.join(', ')} (${r.text})`);
      if (REFUSED.includes(tool)) {
        assert.equal(r.result?.isError, true, `${tool} should be refused: ${r.text}`);
        assert.deepEqual(changed, [], `${tool} was refused but wrote`);
      }
      if (HELD.includes(tool)) {
        assert.equal(r.result?.isError, undefined, `${tool}: ${r.text}`);
        assert.match(r.text, /Held for the owner|wait for the owner/, `${tool} should say it is held: ${r.text}`);
      }
    }
    assert.equal(app.deps.service.get(w.fact2)!.deletedAt, null, 'a held forget leaves the fact');
    assert.equal(app.deps.service.get(w.fact)!.content, 'Use SQLite for the activity feed', 'a held update leaves the text');
  } finally { await app.close(); }
});

test('the picture upload link an assistant already holds stops working when saving is paused, when its saves wait, and when it is revoked', async () => {
  const { app, token, w, grantId } = await world();
  try {
    const png = Buffer.from(w.png, 'base64');
    const link = async () => {
      const r = await callTool(app.baseUrl, token, 'begin_image_upload', { page_id: w.page, alt: 'A small test picture' });
      return new URL(/(http:\/\/\S+\/api\/image-upload\/\S+)/.exec(r.text)![1]!).pathname;
    };
    const put = (path: string) => fetch(app.baseUrl + path, { method: 'PUT', body: png });
    const images = () => (app.deps.db!.prepare('SELECT COUNT(*) AS n FROM images').get() as { n: number }).n;
    let path = await link();
    app.deps.service.setSavesPaused(true);
    assert.equal((await put(path)).status, 403);
    app.deps.service.setSavesPaused(false);
    app.deps.provider.setGrantSavesWait(grantId, true);
    assert.equal((await put(path)).status, 403);
    app.deps.provider.setGrantSavesWait(grantId, false);
    app.deps.provider.setGrantAccess(grantId, 'discussions');
    assert.equal((await put(path)).status, 403, 'a connection cut down to discussions cannot upload');
    app.deps.provider.setGrantAccess(grantId, 'full');
    assert.equal(images(), 0, 'nothing was stored by the refused uploads');
    app.deps.provider.revokeGrant(grantId);
    assert.equal((await put(path)).status, 403, 'a revoked connection cannot upload');
    assert.equal(images(), 0);
    path = '/api/image-upload/not-a-real-token';
    assert.equal((await put(path)).status, 410);
  } finally { await app.close(); }
});

test('weekly_review while saving is paused shows the week built for the call and stores no snapshot (read-only grants still store the derived week when saving is on: documented bookkeeping)', async () => {
  const { app } = await world();
  try {
    app.advance(8 * 86_400_000); // the week the seed facts were saved in is now finished
    const { token } = app.deps.provider.issueLocalGrant({ name: 'Reviewer', clientName: 'Reviewer' }); // the first token has expired by now
    const rows = () => (app.deps.db!.prepare('SELECT COUNT(*) AS n FROM weekly_reviews').get() as { n: number }).n;
    app.deps.service.setSavesPaused(true);
    const shown = await callTool(app.baseUrl, token, 'weekly_review', {});
    assert.equal(rows(), 0, 'a paused brain stored a snapshot');
    assert.match(shown.text, /The weekly review for/, `a paused brain still shows the week, built for the call: ${shown.text}`);
    app.deps.service.setSavesPaused(false);
    const r = await callTool(app.baseUrl, token, 'weekly_review', {});
    assert.equal(r.result?.isError, undefined, r.text);
    assert.equal(rows(), 1, `not vacuous: with saving on, the week is stored: ${r.text}`);
  } finally { await app.close(); }
});

test('while paused, every read tool changes no content table (derived snapshots included); only documented bookkeeping columns move', async () => {
  const { app, token, w } = await world();
  try {
    app.advance(8 * 86_400_000);
    const { token: t2 } = app.deps.provider.issueLocalGrant({ name: 'Reader', clientName: 'Reader' });
    app.deps.service.setSavesPaused(true);
    const args: Record<string, Record<string, unknown>> = {
      load_profile: {}, recall: { query: 'SQLite activity feed' }, project_brief: { project: 'brainai' }, list_projects: {}, recent_work: {}, whats_left: {},
      list_pages: {}, read_page: { id: w.page }, view_image: { id: 'aaaaaaaaaaaaaaaaaaaaaaaa' }, weekly_review: {}, list_skills: {}, load_skill: { name: 'nothing' },
      tidy_session: { project: 'brainai' }, list_discussions: { status: 'all' }, read_discussion: { id: w.discussion, model: 'GPT' },
    };
    assert.deepEqual(Object.keys(args).sort(), [...READ_TOOLS].sort(), 'a read tool has no call here');
    void token;
    for (const tool of READ_TOOLS) {
      const before = fingerprint(app.deps.db!);
      const r = await callTool(app.baseUrl, t2, tool, args[tool]);
      assert.notEqual(r.status, 401, `${tool}: ${r.text}`);
      assert.deepEqual(changedTables(before, fingerprint(app.deps.db!)), [], `${tool} changed a content table while paused`);
    }
  } finally { await app.close(); }
});
