/*
 * Lost-work defects (UX states review, 2026-11-23): the editor's leave warning after a server-drawn page, the draft copy on
 * this device, the login that returns to the page a form came from, the failed-save page, and one submit at a time.
 * editor-cm.js's editorGuard takes the DOM and storage as arguments, so it runs here with small fakes.
 */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { loggedIn, startTestApp } from '../testing/helpers.js';
import { sessionCards } from './dashboardViews.js';

const cm = await import(new URL('./static/editor-cm.js', import.meta.url).href);
const dr = await import(new URL('./static/draft.js', import.meta.url).href);

type Handler = (e: Record<string, unknown>) => void;
class Node {
  attrs: Record<string, string> = {};
  value = '';
  type = '';
  className = '';
  textContent = '';
  value2 = '';
  children: Node[] = [];
  handlers: Record<string, Handler[]> = {};
  editorApi: { setValue(t: string): void; focus(): void } | undefined;
  removed = false;
  constructor(public tag = 'div') {}
  setAttribute(k: string, v: string) { this.attrs[k] = v; }
  removeAttribute(k: string) { delete this.attrs[k]; }
  getAttribute(k: string) { return this.attrs[k] ?? null; }
  addEventListener(n: string, h: Handler) { (this.handlers[n] ??= []).push(h); }
  fire(n: string, e: Record<string, unknown> = {}) { const ev = { defaultPrevented: false, preventDefault() { ev.defaultPrevented = true; }, ...e }; for (const h of this.handlers[n] ?? []) h(ev); return ev; }
  append(...c: (Node | string)[]) { for (const x of c) this.children.push(typeof x === 'string' ? Object.assign(new Node('#text'), { textContent: x }) : x); }
  remove() { this.removed = true; }
  dispatchEvent() { return true; }
  classList = { contains: (c: string) => this.className.split(' ').includes(c) };
  before(n: Node) { this.shown = n; }
  shown?: Node;
  querySelector: (s: string) => Node | null = () => null;
}
const store = () => { const m = new Map<string, string>(); return { m, getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); }, removeItem: (k: string) => { m.delete(k); }, key: (i: number) => [...m.keys()][i] ?? null, get length() { return m.size; } }; };

function rig(opts: { body?: string; title?: string; fromPost?: boolean; action?: string; base?: string; section?: string; storage?: ReturnType<typeof store>; at?: number; conflict?: boolean } = {}) {
  const storage = opts.storage ?? store();
  const form = new Node('form'), textarea = new Node('textarea'), title = new Node('textarea'), save = new Node('button'), cancel = new Node('a'), ed = new Node('section');
  form.attrs.action = opts.action ?? '/pages/p1';
  textarea.value = opts.body ?? 'start';
  title.value = opts.title ?? 'T';
  save.value = 'save';
  const base = Object.assign(new Node('input'), { value: opts.base ?? '3' });
  const section = opts.section ? Object.assign(new Node('input'), { value: opts.section }) : null;
  const hiddenSave = Object.assign(new Node('button'), { value: 'save', className: 'visually-hidden' });
  const visible = Object.assign(new Node('button'), { value: 'save' });
  const q: Record<string, Node | null> = { '.psavebar button[name="intent"][value="save"]': visible, 'input[name="base"]': base, 'input[name="section"]': section, '.psavebar a[href]': cancel, 'section.ed': ed, 'button[name="intent"][value="save"]:not(.visually-hidden)': save };
  form.querySelector = (s) => q[s] ?? null;
  const win = new Node('window') as Node & { timers: (() => void)[]; setTimeout(f: () => void): number; clearTimeout(): void };
  win.timers = []; win.setTimeout = (f) => { win.timers.push(f); return win.timers.length; }; win.clearTimeout = () => { win.timers = []; };
  const discard = new Node('a');
  const doc = { documentElement: { lang: 'en' }, querySelector: (s: string) => (opts.conflict && s === '.conflict .actions a[href]' ? discard : null), createElement: (t: string) => new Node(t), createTextNode: (s: string) => Object.assign(new Node('#text'), { textContent: s }) };
  let asked = 0, answer = false;
  const clock = { now: opts.at ?? 1_000_000 };
  const guard = cm.editorGuard(form, textarea, title, { win, doc, storage, now: () => clock.now, startText: textarea.value, startTitle: title.value, fromPost: !!opts.fromPost, confirm: () => { asked++; return answer; } });
  return { form, textarea, title, save, cancel, base, discard, visible, hiddenSave, win, storage, guard, clock, asked: () => asked, answer: (a: boolean) => { answer = a; }, flush: () => { const t = win.timers; win.timers = []; t.forEach((f) => f()); } };
}

test('an editor drawn from a form POST (data-fresh="off") counts as unsaved from the start, so Cancel and leaving warn', () => {
  const r = rig({ fromPost: true });
  assert.equal(r.guard.dirty(), true);
  const leave = r.win.fire('beforeunload');
  assert.equal(leave.defaultPrevented, true);
  r.cancel.fire('click');
  assert.equal(r.asked(), 1);
  r.answer(true);
  r.cancel.fire('click');
  assert.equal(r.win.fire('beforeunload').defaultPrevented, false, 'a confirmed Cancel does not ask again');
  r.win.fire('pagehide');
  assert.equal(r.storage.m.size, 0, 'and the discarded text is not kept');
  const plain = rig();
  assert.equal(plain.guard.dirty(), false);
  assert.equal(plain.win.fire('beforeunload').defaultPrevented, false);
});

test('no warning right after a save is sent', () => {
  const r = rig({ fromPost: true });
  r.form.fire('submit', { submitter: r.save });
  assert.equal(r.win.fire('beforeunload').defaultPrevented, false);
});

test('one submit at a time: the pressed button is busy and a second send is stopped; coming back lets it send again', () => {
  const r = rig();
  const first = r.form.fire('submit', { submitter: r.save });
  assert.equal(first.defaultPrevented, false);
  assert.equal(r.save.attrs['aria-busy'], 'true');
  assert.equal(r.form.fire('submit', { submitter: r.save }).defaultPrevented, true);
  r.win.fire('pageshow');
  assert.equal(r.save.attrs['aria-busy'], undefined);
  assert.equal(r.form.fire('submit', { submitter: r.save }).defaultPrevented, false);
});

test('the draft copy is written after typing stops, and again when the form is sent', () => {
  const r = rig();
  r.textarea.value = 'start plus more';
  r.textarea.fire('cm:change');
  assert.equal(r.storage.m.size, 0, 'not before the pause');
  r.flush();
  const d = dr.readDraft(r.storage, dr.draftKey('/pages/p1', ''), r.clock.now);
  assert.deepEqual([d.body, d.title, d.base, d.saving], ['start plus more', 'T', 3, false]);
  r.title.value = 'New title';
  r.form.fire('submit', { submitter: r.save });
  const sent = dr.readDraft(r.storage, dr.draftKey('/pages/p1', ''), r.clock.now);
  assert.deepEqual([sent.title, sent.saving], ['New title', true]);
});

test('a section editor has its own copy; a preview does not mark the save as sent', () => {
  const r = rig({ section: 'stack' });
  r.textarea.value = 'x';
  const preview = Object.assign(new Node('button'), { value: 'preview' });
  r.form.fire('submit', { submitter: preview });
  assert.equal(dr.readDraft(r.storage, dr.draftKey('/pages/p1', 'stack'), r.clock.now).saving, false);
  assert.equal(r.storage.m.has(dr.draftKey('/pages/p1', '')), false);
});

test('opening the editor offers a newer copy whose text differs: Put it back restores title and text, Discard removes it', () => {
  const storage = store();
  dr.writeDraft(storage, dr.draftKey('/pages/p1', ''), { title: 'Mine', body: 'lost words', base: 3, saving: true }, 1_000_000);
  const r = rig({ storage, at: 1_000_000 + 60_000 });
  const line = (r.form.querySelector('section.ed') as unknown as Node).shown!;
  assert.ok(line, 'the line is shown in place');
  assert.equal(line.attrs.role, 'status');
  assert.match(line.children[0].textContent, /^You have unsaved text from .+\. $/);
  const [put, , drop] = line.children.slice(1);
  assert.equal(put.textContent, 'Put it back');
  assert.equal(drop.textContent, 'Discard');
  let set = '';
  r.textarea.editorApi = { setValue: (t) => { set = t; r.textarea.value = t; }, focus() {} };
  put.fire('click');
  assert.equal(set, 'lost words');
  assert.equal(r.textarea.value, 'lost words');
  assert.equal(r.title.value, 'Mine');
  assert.equal(line.removed, true);
  assert.equal(r.guard.dirty(), true, 'the put-back text warns before leaving');

  const again = rig({ storage, at: 1_000_000 + 60_000, body: 'other' });
  const l2 = (again.form.querySelector('section.ed') as unknown as Node).shown!;
  l2.children[3].fire('click');
  assert.equal(storage.m.size, 0);
  assert.equal(l2.removed, true);
});

test('no offer when the copy is the same text, is for another page, or is a day old; and typing does not overwrite an unanswered offer', () => {
  const storage = store();
  dr.writeDraft(storage, dr.draftKey('/pages/p1', ''), { title: 'T', body: 'start', base: 3, saving: false }, 1_000_000);
  assert.equal((rig({ storage, at: 1_000_100 }).form.querySelector('section.ed') as unknown as Node).shown, undefined);
  dr.writeDraft(storage, dr.draftKey('/pages/p2', ''), { title: 'T', body: 'elsewhere', base: 1, saving: false }, 1_000_000);
  assert.equal((rig({ storage, at: 1_000_100 }).form.querySelector('section.ed') as unknown as Node).shown, undefined);
  dr.writeDraft(storage, dr.draftKey('/pages/p1', ''), { title: 'T', body: 'old', base: 3, saving: false }, 1_000_000);
  assert.equal((rig({ storage, at: 1_000_000 + dr.DRAFT_TTL_MS + 1 }).form.querySelector('section.ed') as unknown as Node).shown, undefined);
  assert.equal(storage.m.has(dr.draftKey('/pages/p1', '')), false, 'an expired copy is removed');
  dr.writeDraft(storage, dr.draftKey('/pages/p1', ''), { title: 'T', body: 'kept', base: 3, saving: false }, 1_000_000);
  const r = rig({ storage, at: 1_000_100 });
  r.textarea.value = 'typed meanwhile';
  r.textarea.fire('cm:change');
  r.flush();
  assert.equal(dr.readDraft(storage, dr.draftKey('/pages/p1', ''), 1_000_100).body, 'kept');
});

test('a page the server saved clears a sent copy only at base+1 by the owner; a new page copy only on the page with its title', () => {
  const storage = store();
  const k1 = dr.draftKey('/pages/p1', '');
  dr.writeDraft(storage, k1, { title: 'T', body: 'a', base: 3, saving: true });
  dr.writeDraft(storage, dr.draftKey('/pages/p1', 'stack'), { title: '', body: 'b', base: 3, saving: false });
  dr.writeDraft(storage, dr.draftKey('/pages/p2', ''), { title: 'T', body: 'c', base: 3, saving: true });
  dr.clearConfirmed(storage, 'p1', 3, 'T', 'owner'); // the save did not happen (a login got in the way)
  dr.clearConfirmed(storage, 'p1', 5, 'T', 'owner'); // not base+1: proves nothing
  dr.clearConfirmed(storage, 'p1', 4, 'T', 'claude'); // somebody else's save
  assert.equal(storage.m.size, 3);
  dr.clearConfirmed(storage, 'p1', 4, 'T', 'owner');
  assert.deepEqual([...storage.m.keys()].sort(), [dr.draftKey('/pages/p1', 'stack'), dr.draftKey('/pages/p2', '')].sort());
  dr.writeDraft(storage, dr.draftKey('/pages', ''), { title: 'New one', body: 'new', base: 0, saving: true });
  dr.clearConfirmed(storage, 'p9', 1, 'Another page', 'owner');
  assert.equal(storage.m.has(dr.draftKey('/pages', '')), true, 'any other page at version 1 keeps it');
  dr.clearConfirmed(storage, 'p9', 1, ' New  one ', 'owner');
  assert.equal(storage.m.has(dr.draftKey('/pages', '')), false);
});

test('on a conflict page the copy is marked not sent, so a later reading page does not delete it', () => {
  const storage = store();
  dr.writeDraft(storage, dr.draftKey('/pages/p1', ''), { title: 'T', body: 'mine', base: 3, saving: true }, 1_000_000);
  rig({ storage, fromPost: true, base: '4', body: 'theirs', at: 1_000_100, conflict: true });
  assert.equal(dr.readDraft(storage, dr.draftKey('/pages/p1', ''), 1_000_100).saving, false);
  dr.clearConfirmed(storage, 'p1', 4, 'T', 'claude');
  dr.clearConfirmed(storage, 'p1', 4, 'T', 'owner');
  assert.equal(storage.m.size, 1, 'kept: nothing of it was saved');
});

test('Put it back on a newer page posts the draft\'s own version (a conflict, not an overwrite); on a POST page it keeps the base', () => {
  const storage = store();
  dr.writeDraft(storage, dr.draftKey('/pages/p1', ''), { title: 'T', body: 'lost words', base: 3, saving: false }, 1_000_000);
  const r = rig({ storage, base: '4', at: 1_000_100 });
  (r.form.querySelector('section.ed') as unknown as Node).shown!.children[1].fire('click');
  assert.equal(r.base.value, '3');
  const p = rig({ storage, base: '4', at: 1_000_100, fromPost: true, body: 'theirs' });
  (p.form.querySelector('section.ed') as unknown as Node).shown!.children[1].fire('click');
  assert.equal(p.base.value, '4');
});

test('⌘S and Enter (the hidden Save) show the busy state on the visible Save', () => {
  const r = rig();
  r.form.fire('submit', { submitter: r.hiddenSave });
  assert.equal(r.visible.attrs['aria-busy'], 'true');
  assert.equal(r.hiddenSave.attrs['aria-busy'], undefined);
});

test('the submit lock lets go after 10 seconds, and leaving warns again then', () => {
  const r = rig({ body: 'start' });
  r.form.fire('submit', { submitter: r.save });
  r.textarea.value = 'edited';
  r.clock.now += 5000;
  assert.equal(r.form.fire('submit', { submitter: r.save }).defaultPrevented, true);
  assert.equal(r.win.fire('beforeunload').defaultPrevented, false);
  r.clock.now += 6000;
  assert.equal(r.win.fire('beforeunload').defaultPrevented, true);
  assert.equal(r.form.fire('submit', { submitter: r.save }).defaultPrevented, false);
});

test('"Discard mine" on the conflict page leaves without a question and drops the copy', () => {
  const r = rig({ fromPost: true, conflict: true });
  r.discard.fire('click');
  assert.equal(r.win.fire('beforeunload').defaultPrevented, false);
  r.win.fire('pagehide');
  assert.equal(r.storage.m.size, 0);
});

test('a title that differs only in spaces is not offered; old copies are swept, and a logout sweeps all', () => {
  const storage = store();
  dr.writeDraft(storage, dr.draftKey('/pages/p1', ''), { title: 'T ', body: 'start', base: 3, saving: false }, 1_000_000);
  dr.writeDraft(storage, dr.draftKey('/pages/p7', ''), { title: 'x', body: 'y', base: 1, saving: false }, 1_000_000 - dr.DRAFT_TTL_MS - 5);
  storage.setItem('other', 'keep');
  const r = rig({ storage, at: 1_000_100 });
  assert.equal((r.form.querySelector('section.ed') as unknown as Node).shown, undefined);
  assert.equal(storage.m.has(dr.draftKey('/pages/p7', '')), false, 'the expired copy of another page is swept');
  dr.sweepDrafts(storage, 1_000_100, true);
  assert.deepEqual([...storage.m.keys()], ['other']);
});

function runApp(local: ReturnType<typeof store>) {
  const handlers: ((e: Record<string, unknown>) => void)[] = [];
  const document = { body: new Node('body'), querySelectorAll: () => [], querySelector: () => null, getElementById: () => null, createElement: (t: string) => new Node(t), addEventListener: (type: string, h: (e: Record<string, unknown>) => void, capture?: boolean) => { if (type === 'submit' && capture === true) handlers.push(h); } };
  runInNewContext(readFileSync(new URL('./static/app.js', import.meta.url), 'utf8'), { document, localStorage: local, navigator: {}, Element: Node, Intl, Date, Number, String, JSON, setTimeout: () => 1, clearTimeout: () => {}, addEventListener: () => {}, matchMedia: () => ({ matches: false }) });
  return (form: unknown) => handlers.forEach((h) => h({ target: form, preventDefault() {} }));
}

test('the page script drops expired copies on load, and every copy when the real "Log out" of this device is sent', () => {
  const local = store();
  dr.writeDraft(local, dr.draftKey('/pages/a', ''), { title: 't', body: 'b', base: 1, saving: false }, Date.now());
  dr.writeDraft(local, dr.draftKey('/pages/b', ''), { title: 't', body: 'b', base: 1, saving: false }, Date.now() - dr.DRAFT_TTL_MS - 1000);
  local.setItem('unrelated', '1');
  const submit = runApp(local);
  assert.deepEqual([...local.m.keys()].sort(), [dr.draftKey('/pages/a', ''), 'unrelated'].sort());
  // The real markup: the form of the current session, and the form of another device.
  const out = sessionCards({ sessions: [{ id: 's1', userAgent: '', createdAt: '2026-11-01T00:00:00Z', lastSeenAt: '2026-11-01T00:00:00Z' } as never, { id: 's2', userAgent: '', createdAt: '2026-11-01T00:00:00Z', lastSeenAt: '2026-11-01T00:00:00Z' } as never], currentSessionId: 's1' }).value;
  const forms = [...out.matchAll(/<form ([^>]*)>/g)].map((m) => m[1]!);
  const fake = (attrs: string) => ({ dataset: {}, matches: (sel: string) => sel.split(',').map((x) => x.trim()).some((x) => x === 'form[data-logout]' ? /(^| )data-logout($| )/.test(attrs) : x === 'form[action="/logout"]' ? /action="\/logout"/.test(attrs) : false) });
  assert.equal(forms.length, 2);
  submit(fake(forms[1]!)); // another device: this one stays signed in
  assert.equal(local.m.size, 2);
  submit(fake(forms[0]!));
  assert.deepEqual([...local.m.keys()], ['unrelated']);
});

test('Cancel keeps an offered copy nobody answered; Discard and "Discard mine" drop it', () => {
  const storage = store();
  const k = dr.draftKey('/pages/p1', '');
  dr.writeDraft(storage, k, { title: 'T', body: 'lost words', base: 3, saving: false }, 1_000_000);
  const r = rig({ storage, at: 1_000_100 });
  r.answer(true);
  r.cancel.fire('click');
  assert.equal(storage.m.has(k), true);
  const c = rig({ storage, at: 1_000_100, fromPost: true, conflict: true, body: 'theirs' });
  c.discard.fire('click');
  assert.equal(storage.m.has(k), false);
});

test('without storage nothing throws', () => {
  assert.equal(dr.readDraft(null, 'k'), null);
  dr.writeDraft(null, 'k', { title: '', body: '' });
  const boom = { getItem() { throw new Error('off'); }, setItem() { throw new Error('off'); }, removeItem() { throw new Error('off'); } };
  assert.equal(dr.readDraft(boom, 'k'), null);
  dr.writeDraft(boom, 'k', { title: '', body: '' });
});

async function start(t: TestContext) {
  const app = await startTestApp();
  t.after(() => app.close());
  return app;
}

test('a POST that meets an ended session goes to login with the page the form came from, never the POST URL', async (t) => {
  const app = await start(t);
  const send = (headers: Record<string, string>) => fetch(app.baseUrl + '/projects/seed-swap/waiting/0/done', { method: 'POST', redirect: 'manual', headers: { Origin: app.baseUrl, ...headers } });
  const a = await send({ Referer: app.baseUrl + '/projects/seed-swap?x=1' });
  assert.equal(a.status, 302);
  assert.equal(a.headers.get('location'), '/login?next=' + encodeURIComponent('/projects/seed-swap?x=1'));
  assert.equal((await send({})).headers.get('location'), '/login?next=%2F', 'no Referer: the start page');
  assert.equal((await send({ Referer: 'https://evil.example/x' })).headers.get('location'), '/login?next=%2F', 'another site is ignored');
  const own = (path: string, referer: string, body: Record<string, string> = {}) => fetch(app.baseUrl + path, { method: 'POST', redirect: 'manual', headers: { Origin: app.baseUrl, Referer: referer, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) });
  const next = (r: Response) => r.headers.get('location');
  assert.equal(next(await own('/pages/p1', app.baseUrl + '/pages/p1', { section: 'stack' })), '/login?next=' + encodeURIComponent('/pages/p1/edit?section=stack'), 'a Preview or conflict page goes back to its editor');
  assert.equal(next(await own('/pages/p1', app.baseUrl + '/pages/p1')), '/login?next=' + encodeURIComponent('/pages/p1/edit'));
  assert.equal(next(await own('/pages', app.baseUrl + '/pages')), '/login?next=' + encodeURIComponent('/pages/new'));
  assert.equal(next(await own('/pages/p1', app.baseUrl + '/pages/p1/edit')), '/login?next=' + encodeURIComponent('/pages/p1/edit'));
  assert.equal(next(await own('/pages/p1', app.baseUrl + '//evil.example/a')), '/login?next=%2F', 'a double slash is refused');
  assert.equal(next(await own('/pages/p1', app.baseUrl + '/\\evil.example')), '/login?next=%2F');
  assert.equal(next(await own('/pages/p1', app.baseUrl + '/pages/p1', { section: 'configuración-año' })), '/login?next=' + encodeURIComponent('/pages/p1/edit?section=' + encodeURIComponent('configuración-año')), 'an accented section keeps its editor');
  const get = await fetch(app.baseUrl + '/pages/abc?q=1', { redirect: 'manual' });
  assert.equal(get.headers.get('location'), '/login?next=' + encodeURIComponent('/pages/abc?q=1'), 'a page view still returns to itself');
});

test('a failed save (500 on a POST) says it may not have been saved and offers the way back, in English and Spanish', async (t) => {
  const app = await start(t);
  const f = await loggedIn(app);
  const page = await app.deps.pages.create({ title: 'Cellar', area: 'start', body: 'Text.' }, 'owner');
  const real = app.deps.pages.save.bind(app.deps.pages);
  (app.deps.pages as unknown as { save: unknown }).save = async () => { throw new Error('disk full'); };
  const post = () => f(`/pages/${page.id}`, { method: 'POST', body: new URLSearchParams({ title: 'Cellar', project: '', area: 'start', body: 'x', base: String(page.version), intent: 'save' }) });
  const en = await post();
  assert.equal(en.status, 500);
  const enText = await en.text();
  assert.match(enText, /This may not have been saved\. Go back to get your text/);
  assert.match(enText, /<a href="#" class="quiet-btn" data-go-back>Go back<\/a>/);
  await f('/settings/language', { method: 'POST', body: new URLSearchParams({ language: 'es' }) });
  const esText = await (await post()).text();
  assert.match(esText, /Puede que no se haya guardado\. Vuelve atrás para recuperar tu texto e inténtalo de nuevo/);
  assert.match(esText, /data-go-back>Volver atrás<\/a>/);
  (app.deps.pages as unknown as { save: unknown }).save = real;
});

test('the reading page marks itself for draft clearing; the page script wires Back without inline script', async (t) => {
  const app = await start(t);
  const f = await loggedIn(app);
  const page = await app.deps.pages.create({ title: 'Cellar', area: 'start', body: 'Text.' }, 'owner');
  assert.match(await (await f(`/pages/${page.id}`)).text(), new RegExp(`<article class="art"[^>]* data-page="${page.id}" data-version="${page.version}" data-draft="/static/draft\\.js\\?v=[0-9a-f]+" data-title="Cellar" data-by="owner">`));
  const appJs = readFileSync(new URL('./static/app.js', import.meta.url), 'utf8');
  assert.match(appJs, /a\[data-go-back\][\s\S]{0,200}history\.back\(\)[\s\S]{0,40}location\.href = '\/'/);
});
