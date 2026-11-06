import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connectClient, loggedIn, startTestApp } from '../testing/helpers.js';
import * as fx from '../testing/imageFixtures.js';

async function world(t: TestContext) {
  const a = await startTestApp();
  t.after(() => a.close());
  const f = await loggedIn(a);
  await connectClient(a.baseUrl, f, 'Claude Code');
  const grant = a.deps.provider.listGrants()[0]!;
  const p = await a.deps.pages.create({ title: 'wildlog — shots', area: 'apps', body: 'Lead.' }, 'owner');
  const link = (title: string | null = null) => a.deps.uploadLinks.create({ grantId: grant.id, pageId: p.id, alt: 'The label screen', title, by: 'Claude Code' });
  // As curl -T sends it: a PUT with no Origin and no cookie.
  const put = async (token: string, body: Buffer) => fetch(`${a.baseUrl}/api/image-upload/${token}`, { method: 'PUT', body: new Uint8Array(body) });
  return { a, grant, p, link, put };
}

test('a shell assistant uploads through its one-use link and gets the Markdown line', async (t) => {
  const { a, p, link, put } = await world(t);
  const token = link('Reading a Rioja label');
  const r = await put(token, await fx.jpegWithGps());
  assert.equal(r.status, 201);
  const line = await r.text();
  const m = /^!\[The label screen\]\(\/images\/([0-9a-f]{24})\.jpg "Reading a Rioja label"\)$/.exec(line);
  assert.ok(m, line);
  const img = a.deps.images.get(m![1]!)!;
  assert.deepEqual([img.createdBy, img.pageId, img.alt], ['Claude Code', p.id, 'The label screen']);
  const again = await put(token, await fx.jpegWithGps());
  assert.equal(again.status, 410);
  assert.equal((await again.json() as { error: string }).error, 'This upload link is used up or expired. Ask for a new one with begin_image_upload.');
  const plain = await (await put(link(), await fx.pngWithText())).text();
  assert.match(plain, /^!\[The label screen\]\(\/images\/[0-9a-f]{24}\.png\)$/);
});

test('an expired link, a lowered or revoked connection, and a bad file are refused; a bad file leaves the link usable', async (t) => {
  const { a, grant, link, put } = await world(t);
  const late = link();
  a.advance(11 * 60_000);
  assert.equal((await put(late, await fx.jpegWithGps())).status, 410);
  const svgFirst = link();
  const bad = await put(svgFirst, fx.svg());
  assert.equal(bad.status, 400);
  assert.equal((await bad.json() as { error: string }).error, "SVG pictures can't be added: they can carry script.");
  assert.equal((await put(svgFirst, await fx.jpegWithGps())).status, 201, 'the link still works after a refused file');
  const lowered = link();
  a.deps.provider.setGrantAccess(grant.id, 'discussions');
  const r = await put(lowered, await fx.jpegWithGps());
  assert.equal(r.status, 403);
  assert.equal((await r.json() as { error: string }).error, 'This connection can no longer add pictures.');
  a.deps.provider.setGrantAccess(grant.id, 'full');
  const revoked = link();
  a.deps.provider.revokeGrant(grant.id);
  assert.equal((await put(revoked, await fx.jpegWithGps())).status, 403);
});

const haveCurl = spawnSync('sh', ['-c', 'command -v curl']).status === 0;

test('end to end over HTTP: begin_image_upload, curl the file, edit_page_section, read_page and view_image', { skip: !haveCurl }, async (t) => {
  const a = await startTestApp();
  t.after(() => a.close());
  const f = await loggedIn(a);
  const { accessToken } = await connectClient(a.baseUrl, f, 'Claude Code');
  const p = await a.deps.pages.create({ title: 'wildlog — e2e', area: 'apps', body: 'Lead.\n\n## Screens\n\nTo come.' }, 'owner');
  let id = 0;
  const call = async (name: string, args: Record<string, unknown>) => {
    const res = await fetch(a.baseUrl + '/mcp', {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json', 'mcp-protocol-version': '2025-06-18' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } }),
    });
    const body = await res.text();
    const json = (res.headers.get('content-type') ?? '').includes('text/event-stream') ? JSON.parse(body.split('\n').filter((l) => l.startsWith('data: ')).pop()!.slice(6)) : JSON.parse(body);
    return json.result as { content: any[]; isError?: boolean };
  };
  const begun = await call('begin_image_upload', { page_id: p.id, alt: 'The label screen' });
  const url = /Run: curl --fail -T <file> (\S+)/.exec(begun.content[0].text)![1]!;
  const dir = mkdtempSync(join(tmpdir(), 'brain-e2e-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'shot.jpg');
  writeFileSync(file, await fx.jpegWithGps());
  // Async: the server answering curl runs in this same process.
  const line = (await promisify(execFile)('curl', ['--fail', '-sS', '-T', file, url], { encoding: 'utf8' })).stdout;
  assert.match(line, /^!\[The label screen\]\(\/images\/[0-9a-f]{24}\.jpg\)$/);
  const saved = await call('edit_page_section', { id: p.id, section: 'screens', base_version: 1, text: line });
  assert.match(saved.content[0].text, /^Saved section screens of page \S+ as version 2\.$/);
  const read = JSON.parse(/<pages>\n([\s\S]*?)\n<\/pages>/.exec((await call('read_page', { id: p.id })).content[0].text)![1]!);
  const pics = read.sections.find((s: any) => s.anchor === 'screens').images;
  assert.equal(pics.length, 1);
  assert.equal(pics[0].added_by, 'Claude Code');
  const seen = await call('view_image', { id: pics[0].id });
  assert.equal(seen.content.find((c: any) => c.type === 'image').mimeType, 'image/jpeg');
});

test('two uploads racing on one link store one file: the link is claimed when the file is stored, not before', async (t) => {
  const { a, link, put } = await world(t);
  const token = link();
  const photo = await fx.jpegWithGps();
  // A: a slow body, still arriving while B is sent.
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const slow = new ReadableStream<Uint8Array>({
    async start(c) { c.enqueue(new Uint8Array(photo.subarray(0, 100))); await gate; c.enqueue(new Uint8Array(photo.subarray(100))); c.close(); },
  });
  const first = fetch(`${a.baseUrl}/api/image-upload/${token}`, { method: 'PUT', body: slow, duplex: 'half' } as RequestInit);
  await new Promise((r) => setTimeout(r, 150));
  const second = await put(token, await fx.pngWithText());
  release();
  const statuses = [second.status, (await first).status].sort();
  assert.deepEqual(statuses, [201, 410]);
});
