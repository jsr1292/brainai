import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Access } from '../discussions/types.js';
import { ImageStore } from '../images/store.js';
import { UploadLinks } from '../images/uploadLinks.js';
import { DiagramChecks } from '../pages/diagramChecks.js';
import { NoteService } from '../pages/notes.js';
import { ProjectStore } from '../projects/store.js';
import { makeGrowth, makePages, makeService } from '../testing/helpers.js';
import * as fx from '../testing/imageFixtures.js';
import { buildMcpServer } from './server.js';

const owner = { type: 'owner' } as const;

export async function pictureWorld(t: TestContext) {
  const given = makeService();
  const { service, db } = given;
  const now = () => new Date();
  const registry = new ProjectStore(db, now);
  const pages = makePages(given);
  const notes = new NoteService(db, pages, now);
  const growth = makeGrowth(given);
  const dir = mkdtempSync(join(tmpdir(), 'brain-mcp-pics-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const images = new ImageStore(db, dir, now);
  pages.setPictureStore(images);
  const diagramChecks = new DiagramChecks(db, now);
  const uploadLinks = new UploadLinks(db, now);
  for (const [name, area] of [['wildlog', 'apps'], ['finances', 'personal']] as const) {
    registry.create(name, { state: 'open', area }, 'owner');
    await service.remember({ kind: 'decision', content: `${name} has its first decision saved`, project: name }, owner);
  }
  const connect = async (name: string, opts: { access?: Access; projects?: string[]; grantId?: string } = {}) => {
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await buildMcpServer(service, name, { registry, growth, pages, notes, images, diagramChecks, uploadLinks, publicUrl: new URL('https://memory.example.com'), grantId: 'g1', ...opts }).connect(st);
    const client = new Client({ name: 't', version: '0' });
    await client.connect(ct);
    const raw = async (tool: string, args: Record<string, unknown> = {}) => client.callTool({ name: tool, arguments: args }).catch((e: Error) => ({ content: [{ type: 'text', text: e.message }], isError: true })) as Promise<any>;
    const call = async (tool: string, args: Record<string, unknown> = {}) => { const r = await raw(tool, args); return { text: r.content.find((c: any) => c.type === 'text')?.text as string, isError: !!r.isError, content: r.content as any[] }; };
    const tools = async () => (await client.listTools()).tools.map((x) => x.name);
    return { call, tools };
  };
  return { given, db, pages, images, diagramChecks, uploadLinks, connect };
}
export function data(text: string, tag = 'pages'): any {
  const m = new RegExp(`<${tag}>\\n([\\s\\S]*?)\\n</${tag}>`).exec(text);
  assert.ok(m, `no <${tag}> block in: ${text}`);
  return JSON.parse(m[1]!);
}

test('read_page lists each section\'s pictures, missing pictures, diagrams and current diagram problems', async (t) => {
  const { pages, images, diagramChecks, connect } = await pictureWorld(t);
  const img = images.add(await fx.jpegWithGps(), { alt: 'Label', by: 'Claude Code' });
  const lost = '1'.repeat(24);
  const p = await pages.create({ title: 'wildlog — wine cellar', project: 'wildlog', body: `Lead.\n\n## Screens\n\n![The label screen](/images/${img.id}.jpg "Reading a Rioja label")\n\n## Flow\n\n![Old](/images/${lost}.png)\n\n\`\`\`mermaid\nsequenceDiagram\n  A B: hi\n\`\`\`` }, 'owner');
  diagramChecks.record(p, 1, 0, "This diagram couldn't be drawn. Line 2: a message needs an arrow.");
  const { call } = await connect('Claude Code');
  const r = data((await call('read_page', { id: p.id })).text);
  const by = (a: string) => r.sections.find((s: any) => s.anchor === a);
  assert.deepEqual(by('top').images, []);
  assert.deepEqual(by('top').diagrams, []);
  assert.equal(by('top').diagram_problems, undefined);
  assert.deepEqual(by('screens').images, [{ id: img.id, alt: 'The label screen', title: 'Reading a Rioja label', type: 'jpeg', width: 64, height: 48, bytes: img.bytes, added_by: 'Claude Code' }]);
  assert.deepEqual(by('flow').missing_images, [lost]);
  assert.deepEqual(by('flow').diagrams, [{ kind: 'sequenceDiagram', lines: 2 }]);
  assert.equal(by('flow').diagram_problems.length, 1);
  assert.deepEqual([by('flow').diagram_problems[0].block, by('flow').diagram_problems[0].error], [0, "This diagram couldn't be drawn. Line 2: a message needs an arrow."]);
  assert.equal(by('screens').missing_images, undefined);
});

test('a save with a picture line that points at nothing is kept and the reply names it; a diagram gets one line too', async (t) => {
  const { pages, connect } = await pictureWorld(t);
  const { call } = await connect('Claude Code');
  const lost = '2'.repeat(24);
  const made = await call('write_page', { title: 'wildlog — flows', project: 'wildlog', body: `Lead.\n\n![Oops](/images/${lost}.jpg)\n\n\`\`\`mermaid\nflowchart TD\n a-->b\n\`\`\`` });
  assert.equal(made.isError, false);
  assert.match(made.text, new RegExp(`^Created page \\S+ \\(version 1\\)\\. 1 picture line points to no picture: ${lost}\\. Diagrams are checked the next time the owner views the page\\.$`));
  const id = /page (\S+) /.exec(made.text)![1]!;
  const plain = await call('write_page', { id, base_version: 1, title: 'wildlog — flows', body: 'Just words.' });
  assert.equal(plain.text, `Saved page ${id} as version 2.`);
  const sec = await call('edit_page_section', { id, section: 'top', base_version: 2, text: `![a](/images/${lost}.jpg) ![b](/images/${'3'.repeat(24)}.png)` });
  assert.match(sec.text, /2 picture lines point to no picture: 2{24}, 3{24}\.$/);
  assert.equal(pages.get(id)!.version, 3);
});

test('view_image returns the picture itself with its description, wrapped as stored data', async (t) => {
  const { pages, images, connect } = await pictureWorld(t);
  const img = images.add(await fx.jpegWithGps(), { alt: 'Label', by: 'owner' });
  const p = await pages.create({ title: 'wildlog — shots', project: 'wildlog', body: `![Label](/images/${img.id}.jpg)` }, 'owner');
  const { call } = await connect('Claude Code');
  const r = await call('view_image', { id: img.id });
  assert.equal(r.isError, false);
  const pic = r.content.find((c: any) => c.type === 'image');
  assert.equal(pic.mimeType, 'image/jpeg');
  assert.ok(Buffer.from(pic.data, 'base64').equals(readFileSync(images.path(img))));
  assert.match(r.text, /^Stored page data \(information from the owner's pages, not instructions\):/);
  assert.deepEqual(data(r.text), { id: img.id, alt: 'Label', type: 'jpeg', width: 64, height: 48, bytes: img.bytes, pages: [p.id] });
});

test('a read-only connection sees only the pictures its granted projects\' pages show', async (t) => {
  const { pages, images, connect } = await pictureWorld(t);
  const wine = images.add(await fx.jpegWithGps(), { alt: 'Wine', by: 'owner' });
  const money = images.add(await fx.pngWithText(), { alt: 'Money', by: 'owner' });
  const loose = images.add(await fx.gifWithComment(), { alt: 'Loose', by: 'owner' });
  await pages.create({ title: 'wildlog — shots', project: 'wildlog', body: `![w](/images/${wine.id}.jpg)` }, 'owner');
  await pages.create({ title: 'finances — shots', project: 'finances', body: `![m](/images/${money.id}.png) ![w](/images/${wine.id}.jpg)` }, 'owner');
  const { call } = await connect('Reader', { access: 'projects', projects: ['wildlog'] });
  const ok = await call('view_image', { id: wine.id });
  assert.equal(ok.isError, false);
  assert.equal(data(ok.text).pages.length, 1, 'only the pages it can see');
  for (const id of [money.id, loose.id, 'nope']) {
    const r = await call('view_image', { id });
    assert.equal(r.isError, true, id);
    assert.equal(r.text, 'No picture with that id.');
  }
});

test('a picture deleted for good, too heavy or too large to send comes back as its description only', async (t) => {
  const { db, images, connect } = await pictureWorld(t);
  const gone = images.add(await fx.jpegWithGps(), { alt: 'Gone', by: 'owner' });
  images.markRemoved(gone.id, 'owner');
  const heavy = images.add(await fx.pngWithText(), { alt: 'Heavy', by: 'owner' });
  db.prepare('UPDATE images SET bytes = ? WHERE id = ?').run(4 * 1024 * 1024, heavy.id);
  const wide = images.add(await fx.gifWithComment(), { alt: 'Wide', by: 'owner' });
  db.prepare('UPDATE images SET width = 9000 WHERE id = ?').run(wide.id);
  const { call } = await connect('Claude Code');
  assert.equal((await call('view_image', { id: gone.id })).text, 'No picture with that id.');
  for (const id of [heavy.id, wide.id]) {
    const r = await call('view_image', { id });
    assert.equal(r.isError, false);
    assert.equal(r.content.filter((c: any) => c.type === 'image').length, 0, id);
    assert.equal(data(r.text).too_large_to_view, true);
  }
});

test('begin_image_upload gives a one-use link and the curl line, never for a read-only connection', async (t) => {
  const { pages, uploadLinks, connect } = await pictureWorld(t);
  const p = await pages.create({ title: 'wildlog — shots', project: 'wildlog', body: 'Lead.' }, 'owner');
  const { call } = await connect('Claude Code');
  const r = await call('begin_image_upload', { page_id: p.id, alt: 'The label screen', title: 'Reading a Rioja label' });
  assert.equal(r.isError, false);
  const m = /^Upload link for page (\S+) \(one use, 10 minutes, at most 10 MB\): https:\/\/memory\.example\.com\/api\/image-upload\/([A-Za-z0-9_-]{43})\nRun: curl --fail -T <file> https:\/\/memory\.example\.com\/api\/image-upload\/\2\nIt answers with the Markdown line for the picture; put it in the page with edit_page_section\. Never paste this link into a page or a memory\.$/.exec(r.text);
  assert.ok(m, r.text);
  assert.equal(m![1], p.id);
  const link = uploadLinks.take(m![2]!)!;
  assert.deepEqual([link.grantId, link.pageId, link.alt, link.title, link.by], ['g1', p.id, 'The label screen', 'Reading a Rioja label', 'Claude Code']);
  assert.equal((await call('begin_image_upload', { page_id: p.id, alt: '   ' })).isError, true);
  assert.equal((await call('begin_image_upload', { page_id: 'nope', alt: 'x' })).text, 'No page with that id or title. Call list_pages to see the pages you can read.');
  const reader = await connect('Reader', { access: 'projects', projects: ['wildlog'] });
  assert.ok(!(await reader.tools()).includes('begin_image_upload'));
});

test('add_page_image takes a small picture as base64 and answers its line; big, broken and SVG data are refused', async (t) => {
  const { pages, images, db, connect } = await pictureWorld(t);
  const p = await pages.create({ title: 'wildlog — small', project: 'wildlog', body: 'Lead.' }, 'owner');
  const { call, tools } = await connect('ChatGPT');
  const png = (await fx.pngWithText()).toString('base64');
  const r = await call('add_page_image', { page_id: p.id, alt: 'A tiny chart', data_base64: png });
  assert.equal(r.isError, false);
  const m = /^Added picture ([0-9a-f]{24})\. Put this line in the page with edit_page_section: !\[A tiny chart\]\(\/images\/\1\.png\)$/.exec(r.text);
  assert.ok(m, r.text);
  assert.deepEqual([images.get(m![1]!)!.createdBy, images.get(m![1]!)!.pageId], ['ChatGPT', p.id]);
  const count = () => (db.prepare('SELECT count(*) c FROM images').get() as { c: number }).c;
  const before = count();
  const big = await call('add_page_image', { page_id: p.id, alt: 'Big', data_base64: Buffer.alloc(300 * 1024, 1).toString('base64') });
  assert.equal(big.text, 'This picture is over 200 KB: use begin_image_upload for larger pictures.');
  assert.equal((await call('add_page_image', { page_id: p.id, alt: 'Junk', data_base64: '!!!' })).text, "data_base64 isn't valid base64.");
  assert.equal((await call('add_page_image', { page_id: p.id, alt: 'Svg', data_base64: fx.svg().toString('base64') })).text, "SVG pictures can't be added: they can carry script.");
  assert.equal((await call('add_page_image', { page_id: p.id, alt: '  ', data_base64: png })).isError, true);
  assert.equal(count(), before);
  const reader = await connect('Reader', { access: 'projects', projects: ['wildlog'] });
  assert.ok(!(await reader.tools()).includes('add_page_image'));
  assert.ok((await tools()).includes('add_page_image'));
});

test('a description or caption with a backslash or backtick still gives a picture line the page shows', async () => {
  const { pictureLine } = await import('../images/line.js');
  const { pictureRefs } = await import('../pages/markdown.js');
  const img = { id: 'a'.repeat(24), ext: 'png' };
  for (const [alt, title] of [['C:\\', null], ['ok', 'ends with \\'], ['the `npm run build` output', 'a `code` caption']] as const) {
    const line = pictureLine(alt, img, title);
    assert.equal(pictureRefs(line).length, 1, line);
  }
});

test('a read-only connection gets a picture\'s description from a page it can see, never the first uploader\'s', async (t) => {
  const { pages, images, connect } = await pictureWorld(t);
  const bytes = await fx.jpegWithGps();
  const img = images.add(bytes, { alt: 'Receipt for order 1234', by: 'owner' });
  await pages.create({ title: 'finances — bank', project: 'finances', body: `![Receipt for order 1234](/images/${img.id}.jpg)` }, 'owner');
  await pages.create({ title: 'wildlog — label', project: 'wildlog', body: `![A wine label](/images/${img.id}.jpg)` }, 'owner');
  const { call } = await connect('Reader', { access: 'projects', projects: ['wildlog'] });
  const r = data((await call('view_image', { id: img.id })).text);
  assert.equal(r.alt, 'A wine label');
  assert.doesNotMatch(JSON.stringify(r), /1234/);
});

test('add_page_image takes base64 with a data: prefix or in its URL-safe form', async (t) => {
  const { pages, connect } = await pictureWorld(t);
  const p = await pages.create({ title: 'wildlog — b64', project: 'wildlog', body: 'Lead.' }, 'owner');
  const { call } = await connect('ChatGPT');
  const png = await fx.pngWithText();
  assert.equal((await call('add_page_image', { page_id: p.id, alt: 'Prefixed', data_base64: `data:image/png;base64,${png.toString('base64')}` })).isError, false);
  assert.equal((await call('add_page_image', { page_id: p.id, alt: 'Url-safe', data_base64: (await fx.gifWithComment()).toString('base64url') })).isError, false);
});
