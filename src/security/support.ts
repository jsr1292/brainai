/** Test support for src/security: an MCP caller over real HTTP, and a fingerprint of everything an assistant can write. */
import { createHash, randomBytes } from 'node:crypto';
import sharp from 'sharp';
import type { DB } from '../db.js';
import type { AppDeps } from '../web/app.js';
import { TEST_PASSWORD } from '../testing/helpers.js';

/** The tables an assistant's saves land in. Usage counts, sessions, tokens and derived indexes are not content. */
export const CONTENT_TABLES = [
  'memories', 'memory_history', 'profile_suggestions', 'supersessions', 'disagreements', 'projects', 'project_aliases', 'project_checks',
  'project_check_history', 'check_snoozes', 'handbook_topics', 'observations', 'observation_evidence', 'pages', 'page_versions', 'page_sections',
  'page_images', 'page_links', 'page_file_imports', 'page_imports', 'images', 'image_upload_links', 'notes', 'discussions', 'discussion_posts',
  'discussion_files', 'skills', 'skill_files', 'skill_versions', 'skill_proposals', 'tidy_proposals', 'weekly_reviews',
] as const;

/** Bookkeeping columns that a read legitimately updates (documented in docs/SECURITY.md), left out of the fingerprint. */
const BOOKKEEPING_COLUMNS = new Set(['last_recalled_at']);

/** One hash per content table: equal before and after means nothing was written there. */
export function fingerprint(db: DB): Record<string, string> {
  const out: Record<string, string> = {};
  for (const t of CONTENT_TABLES) {
    const rows = db.prepare(`SELECT * FROM ${t}`).all().map((r) => JSON.stringify(r, (k, v) => (BOOKKEEPING_COLUMNS.has(k) ? undefined : Buffer.isBuffer(v) ? v.toString('hex') : v)));
    out[t] = createHash('sha256').update(rows.sort().join('\n')).digest('hex');
  }
  return out;
}

/** The tables whose content differs between two fingerprints. */
export const changedTables = (a: Record<string, string>, b: Record<string, string>): string[] => CONTENT_TABLES.filter((t) => a[t] !== b[t]);

export interface McpReply { status: number; result?: { isError?: boolean; content?: { type: string; text?: string }[] }; error?: { code: number; message: string }; text: string }

/** One JSON-RPC call to /mcp with a bearer token, answered as plain data. */
export async function mcpCall(baseUrl: string, token: string | null, method: string, params: unknown = {}, extraHeaders: Record<string, string> = {}): Promise<McpReply> {
  const res = await fetch(baseUrl + '/mcp', {
    method: 'POST',
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      Accept: 'application/json, text/event-stream',
      'Content-Type': 'application/json',
      'mcp-protocol-version': '2025-06-18',
      ...extraHeaders,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const body = await res.text();
  let msg: { result?: McpReply['result']; error?: McpReply['error'] } = {};
  try {
    msg = (res.headers.get('content-type') ?? '').includes('text/event-stream')
      ? JSON.parse(body.split('\n').filter((l) => l.startsWith('data: ')).at(-1)!.slice(6))
      : JSON.parse(body);
  } catch { /* a refusal that is not JSON-RPC (401 from the bearer check) */ }
  const text = msg.result?.content?.map((c) => c.text ?? '').join('\n') ?? msg.error?.message ?? body;
  return { status: res.status, result: msg.result, error: msg.error, text };
}

export const callTool = (baseUrl: string, token: string | null, name: string, args: Record<string, unknown> = {}) => mcpCall(baseUrl, token, 'tools/call', { name, arguments: args });

/** The names a connection is offered (tools/list). */
export async function toolNames(baseUrl: string, token: string): Promise<string[]> {
  const r = await fetch(baseUrl + '/mcp', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json', 'mcp-protocol-version': '2025-06-18' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  });
  const body = await r.text();
  const line = body.startsWith('{') ? body : body.split('\n').filter((l) => l.startsWith('data: ')).at(-1)!.slice(6);
  return (JSON.parse(line).result.tools as { name: string }[]).map((t) => t.name).sort();
}

const CALLBACK = 'http://localhost:9999/callback';

export interface Connected { clientId: string; accessToken: string; refreshToken: string; grantId: string }

/**
 * The real OAuth flow (register, authorize, consent as the owner, token), like helpers.connectClient but keeping the refresh
 * token and the grant id, and letting the owner pick the access level and projects on the consent form.
 */
export async function connectWith(
  app: { baseUrl: string; deps: { provider: { listGrants(): { id: string; clientId?: string }[] } } },
  f: (path: string, init?: RequestInit) => Promise<Response>,
  opts: { name?: string; access?: 'full' | 'discussions' | 'projects'; projects?: string[]; resource?: string } = {},
): Promise<Connected> {
  const { baseUrl } = app;
  const reg = await fetch(baseUrl + '/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ redirect_uris: [CALLBACK], client_name: opts.name ?? 'Claude Code', token_endpoint_auth_method: 'none' }),
  });
  if (reg.status !== 201) throw new Error(`register failed: ${reg.status}`);
  const { client_id: clientId } = await reg.json() as { client_id: string };
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const resource = opts.resource ?? `${baseUrl}/mcp`;
  const auth = await fetch(baseUrl + '/authorize?' + new URLSearchParams({
    response_type: 'code', client_id: clientId, redirect_uri: CALLBACK, code_challenge: challenge, code_challenge_method: 'S256', state: 'xyz', resource,
  }), { redirect: 'manual' });
  const consentPath = auth.headers.get('location');
  if (auth.status !== 302 || !consentPath) throw new Error(`authorize failed: ${auth.status}`);
  const form = new URLSearchParams({ decision: 'approve', access: opts.access ?? 'full' });
  for (const p of opts.projects ?? []) form.append('projects', p);
  const approve = await f(consentPath, { method: 'POST', body: form });
  const code = new URL(approve.headers.get('location') ?? '', baseUrl).searchParams.get('code');
  if (approve.status !== 302 || !code) throw new Error(`consent failed: ${approve.status}`);
  const tok = await fetch(baseUrl + '/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: clientId, redirect_uri: CALLBACK, resource }),
  });
  if (tok.status !== 200) throw new Error(`token failed: ${tok.status} ${await tok.text()}`);
  const t = await tok.json() as { access_token: string; refresh_token: string };
  const grant = app.deps.provider.listGrants().find((g) => g.clientId === clientId) ?? app.deps.provider.listGrants().at(-1)!;
  return { clientId, accessToken: t.access_token, refreshToken: t.refresh_token, grantId: grant.id };
}

/** POST /token with a refresh token. */
export const refresh = (baseUrl: string, clientId: string, refreshToken: string, resource?: string) => fetch(baseUrl + '/token', {
  method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId, ...(resource ? { resource } : {}) }),
});

export const OWNER = { type: 'owner' } as const;

export interface World { fact: string; fact2: string; fact3: string; page: string; note: string; discussion: string; png: string }

/** The owner's own data an assistant's write could touch: two projects, two facts, a page with a note, a discussion. */
export async function seedWorld(app: { deps: AppDeps }): Promise<World> {
  const { service, pages, notes, discussions, registry } = app.deps;
  registry.create('brainai', { state: 'open', area: 'apps' }, 'owner');
  const a = await service.remember({ kind: 'decision', project: 'brainai', content: 'Use SQLite for the activity feed' }, OWNER);
  const b = await service.remember({ kind: 'decision', project: 'brainai', content: 'Deploy through the Cloudflare tunnel only' }, OWNER);
  const c = await service.remember({ kind: 'decision', project: 'brainai', content: 'Photos are resized before they are stored' }, OWNER);
  if (a.status !== 'saved' || b.status !== 'saved' || c.status !== 'saved') throw new Error('seed facts not saved');
  const page = await pages.create({ title: 'brainai notes', project: 'brainai', body: '# Notes\n\nThe first section.\n\n## Key decisions\n\n- 2026-11-01 Use SQLite' }, 'owner');
  const note = notes.add(page.id, { text: 'Please check the second section' });
  const d = discussions.open({ name: 'Codex', model: 'GPT', access: 'full' }, { title: 'Which store', question: 'SQLite or files?', project: 'brainai' });
  const png = (await sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 1, g: 2, b: 3 } } }).png().toBuffer()).toString('base64');
  return { fact: a.memory.id, fact2: b.memory.id, fact3: c.memory.id, page: page.id, note: note.id, discussion: d.id, png };
}

/** A valid call for every tool an assistant can write with, built from a seeded world. Keys are the WRITE_TOOLS names. */
export function writeCalls(w: World): Record<string, Record<string, unknown>> {
  return {
    remember: { kind: 'decision', project: 'brainai', content: 'Backups run nightly at three in the morning' },
    suggest_memories: { session: 'security review', items: [{ kind: 'decision', project: 'brainai', content: 'Logs are kept for fourteen days only' }] },
    update_memory: { id: w.fact, content: 'Use SQLite with WAL for the activity feed' },
    forget: { id: w.fact3 },
    flag_disagreement: { a: w.fact, b: w.fact2, why: 'They disagree about hosting' },
    set_project_info: { project: 'brainai', one_liner: 'A shared memory for assistants' },
    note_observation: { kind: 'strength', area: 'testing', what: 'Wrote the failing test before the fix on the sync bug' },
    set_project_area: { project: 'brainai', area: 'safe', status: 'done', note: 'Backups checked and restored once' },
    record_lesson: { title: 'What a commit and a push are', level: 'seen' },
    propose_skill: { name: 'release-notes', description: 'Use when writing release notes', body: 'Write the notes from the changelog.' },
    propose_tidy: { ids: [w.fact, w.fact2], proposal: { keep: { ids: [w.fact, w.fact2] } }, reason: 'Both still hold' },
    write_page: { title: 'Security notes', project: 'brainai', body: '# Security\n\nPlain text.' },
    edit_page_section: { id: w.page, section: 'notes', base_version: 1, text: 'The first section, changed.' },
    begin_image_upload: { page_id: w.page, alt: 'A small test picture' },
    add_page_image: { page_id: w.page, alt: 'A small test picture', data_base64: w.png },
    resolve_note: { id: w.note, reply: 'Checked it' },
    open_discussion: { title: 'Another question', question: 'Tabs or spaces?', model: 'GPT' },
    reply_to_discussion: { id: w.discussion, model: 'GPT', text: 'I would use SQLite.' },
    close_discussion: { id: w.discussion, model: 'GPT', decision: 'Use SQLite for the store.' },
  };
}

/** Logs in through the real flow and returns the bare session cookie, so a test can send it with any Origin (or none). */
export async function sessionCookie(app: { baseUrl: string; nextTotp(): string }): Promise<string> {
  const res = await fetch(app.baseUrl + '/login', {
    method: 'POST', redirect: 'manual',
    headers: { Origin: app.baseUrl, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ password: TEST_PASSWORD, code: app.nextTotp() }),
  });
  const cookie = res.headers.getSetCookie().map((c) => c.split(';')[0]).filter((c) => c!.startsWith('mem_session=')).join('; ');
  if (res.status !== 302 || !cookie) throw new Error(`login failed: ${res.status}`);
  return cookie;
}
