import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm, { runInNewContext } from 'node:vm';

/** Just enough DOM for static/app.js: elements with attributes, a body, click listeners. */
class FakeElement {
  textContent = '';
  innerHTML = '';
  className = '';
  dataset: Record<string, string> = {};
  attrs: Record<string, string> = {};
  children: FakeElement[] = [];
  constructor(readonly tag: string, private readonly matches: string[] = []) {}
  setAttribute(name: string, value: string) { this.attrs[name] = value; }
  getAttribute(name: string) { return this.attrs[name] ?? null; }
  removeAttribute(name: string) { delete this.attrs[name]; }
  append(...els: FakeElement[]) { this.children.push(...els); }
  closest(selector: string) { return this.matches.includes(selector) ? this : null; }
  // For the box that shows the text when copying fails.
  value = '';
  readOnly = false;
  type = '';
  focused = false;
  selected = false;
  nextElementSibling: FakeElement | null = null;
  after(el: FakeElement) { el.nextElementSibling = this.nextElementSibling; this.nextElementSibling = el; }
  focus() { this.focused = true; }
  select() { this.selected = true; }
  range: [number, number] | null = null;
  setSelectionRange(a: number, b: number) { this.range = [a, b]; }
}

test('the contents mark the section in view and load without IntersectionObserver', () => {
  const script = readFileSync(new URL('./static/app.js', import.meta.url), 'utf8');
  const a = new FakeElement('a'), b = new FakeElement('a');
  const headingA = new FakeElement('h2'), headingB = new FakeElement('h2');
  a.attrs.href = '#a'; b.attrs.href = '#b';
  let callback: ((entries: { target: FakeElement; isIntersecting: boolean }[]) => void) | undefined;
  const document = {
    body: new FakeElement('body'),
    querySelectorAll: (s: string) => s === '.toc a[href^="#"]' ? [a, b] : [],
    querySelector: () => null,
    getElementById: (id: string) => id === 'a' ? headingA : id === 'b' ? headingB : null,
    createElement: (tag: string) => new FakeElement(tag), addEventListener: () => {},
  };
  const context = { document, navigator: {}, Element: FakeElement, Intl, Date, Number, String, setTimeout: () => 1, clearTimeout: () => {}, addEventListener: () => {}, matchMedia: () => ({ matches: false }) };
  runInNewContext(script, { ...context, IntersectionObserver: class { constructor(cb: typeof callback) { callback = cb; } observe() {} } });
  assert.ok(callback);
  callback!([{ target: headingA, isIntersecting: true }]);
  assert.equal(a.getAttribute('aria-current'), 'true');
  callback!([{ target: headingB, isIntersecting: true }]);
  assert.equal(a.getAttribute('aria-current'), null);
  assert.equal(b.getAttribute('aria-current'), 'true');
  assert.doesNotThrow(() => runInNewContext(script, context));
});

test('a contents heading that starts with a digit (#2026-plan) is still marked, and the rest of the script still runs', () => {
  const script = readFileSync(new URL('./static/app.js', import.meta.url), 'utf8');
  const a = new FakeElement('a'), b = new FakeElement('a');
  const headingA = new FakeElement('h2'), headingB = new FakeElement('h2');
  a.attrs.href = '#2026-plan'; b.attrs.href = '#3d-graph';
  let callback: ((entries: { target: FakeElement; isIntersecting: boolean }[]) => void) | undefined;
  const listeners: string[] = [];
  const ids: Record<string, FakeElement> = { '2026-plan': headingA, '3d-graph': headingB };
  const document = {
    body: new FakeElement('body'),
    querySelectorAll: (s: string) => s === '.toc a[href^="#"]' ? [a, b] : [],
    // As in a browser: an id selector that starts with a digit is not valid CSS.
    querySelector: (s: string) => { if (/^#\d/.test(s)) throw new SyntaxError(`'${s}' is not a valid selector`); return null; },
    getElementById: (id: string) => ids[id] ?? null,
    createElement: (tag: string) => new FakeElement(tag),
    addEventListener: (type: string) => { listeners.push(type); },
  };
  const context = { document, navigator: {}, Element: FakeElement, Intl, Date, Number, String, setTimeout: () => 1, clearTimeout: () => {}, addEventListener: () => {}, matchMedia: () => ({ matches: false }) };
  runInNewContext(script, { ...context, IntersectionObserver: class { constructor(cb: typeof callback) { callback = cb; } observe() {} } });
  assert.ok(callback);
  callback!([{ target: headingB, isIntersecting: true }]);
  assert.equal(b.getAttribute('aria-current'), 'true');
  assert.ok(listeners.includes('keydown'), 'the ⌘K shortcut is still set up after the contents');
});

function load(writeText: ((text: string) => Promise<void>) | undefined, buttons: FakeElement[], times: FakeElement[] = []) {
  const listeners: Record<string, ((e: unknown) => void)[]> = {};
  const body = new FakeElement('body');
  const document = {
    body,
    querySelectorAll: (s: string) => (s === 'time[datetime]:not(.day)' ? times : []),
    querySelector: (s: string) => (s === 'button[data-copy]' ? buttons[0] ?? null : null),
    createElement: (tag: string) => new FakeElement(tag),
    addEventListener: (type: string, fn: (e: unknown) => void) => { (listeners[type] ??= []).push(fn); },
  };
  const timers: (() => void)[] = [];
  runInNewContext(readFileSync(new URL('./static/app.js', import.meta.url), 'utf8'), {
    document, navigator: writeText ? { clipboard: { writeText } } : {}, Element: FakeElement, Intl, Date, Number, String,
    setTimeout: (fn: () => void) => { timers.push(fn); return timers.length; }, clearTimeout: () => {},
  });
  const click = async (target: FakeElement) => {
    for (const fn of listeners.click ?? []) fn({ target });
    await new Promise((r) => setImmediate(r));
  };
  const status = () => body.children.find((c) => c.getAttribute('role') === 'status');
  return { click, status, runTimers: () => timers.splice(0).forEach((fn) => fn()) };
}

const copyButton = () => {
  const b = new FakeElement('button', ['button[data-copy]']);
  b.dataset.copy = 'cd ~/Projects/wildlog && claude';
  b.innerHTML = 'Continue in Claude Code';
  return b;
};

test('a copy button tells screen readers it copied, through a status message', async () => {
  const copied: string[] = [];
  const button = copyButton();
  const dom = load(async (t) => { copied.push(t); }, [button]);
  const status = dom.status();
  assert.ok(status, 'a status region is on the page before anything is copied');
  assert.equal(status.className, 'visually-hidden');
  assert.equal(status.textContent, '');
  await dom.click(button);
  assert.deepEqual(copied, ['cd ~/Projects/wildlog && claude']);
  assert.equal(button.textContent, 'Copied');
  assert.equal(status.textContent, 'Copied');
  dom.runTimers();
  assert.equal(button.innerHTML, 'Continue in Claude Code');
  assert.equal(status.textContent, '', 'cleared, so the next copy is announced again');
});

test('a copy that fails says so instead of doing nothing', async () => {
  const button = copyButton();
  const dom = load(() => Promise.reject(new Error('denied')), [button]);
  await dom.click(button);
  assert.equal(button.textContent, 'Could not copy');
  assert.match(dom.status()!.textContent, /^Could not copy/);
  dom.runTimers();
  assert.equal(button.innerHTML, 'Continue in Claude Code');
});

test('without a clipboard (a page not served over HTTPS) the button says it could not copy', async () => {
  const button = copyButton();
  const dom = load(undefined, [button]);
  await dom.click(button);
  assert.equal(button.textContent, 'Could not copy');
});

test('when copying fails, the text appears in a read-only box after the button, selected, so it can be copied by hand', async () => {
  const button = copyButton();
  const dom = load(() => Promise.reject(new Error('denied')), [button]);
  await dom.click(button);
  const box = button.nextElementSibling;
  assert.ok(box, 'a box after the button');
  assert.equal(box.tag, 'input');
  assert.equal(box.readOnly, true);
  assert.equal(box.value, 'cd ~/Projects/wildlog && claude');
  assert.equal(box.className, 'copy-fallback');
  assert.match(box.getAttribute('aria-label') ?? '', /copy/i);
  assert.ok(box.focused && box.selected, 'focused with the text selected');
  // iOS Safari often ignores select() on a read-only field; an explicit range selects the whole text there.
  assert.deepEqual(box.range, [0, box.value.length]);
  assert.match(dom.status()!.textContent, /box/, 'the message points to the box, which is really there');
  dom.runTimers();
  assert.equal(button.nextElementSibling, box, 'it stays after the message goes');
  await dom.click(button);
  assert.equal(button.nextElementSibling, box, 'a second failure reuses the same box');
  assert.equal(box.nextElementSibling, null);
});

test('a date older than a week keeps the server\'s "20 Sep" (never "20 Sept"), and the tooltip spells the month out', () => {
  const t = Object.assign(new FakeElement('time'), { dateTime: '2020-09-20T12:00:00Z', title: '' });
  t.textContent = '20 Sep 2020';
  load(undefined, [], [t]);
  assert.equal(t.textContent, '20 Sep 2020');
  assert.match(t.title, /September 2020/);
  assert.doesNotMatch(t.title, /Sept\b/);
});

test('times keep the server\'s words (one date language) and gain the full local date as a tooltip', () => {
  const t = Object.assign(new FakeElement('time'), { dateTime: '2026-11-03T08:00:00Z', title: '' });
  t.textContent = 'yesterday';
  load(undefined, [], [t]);
  assert.equal(t.textContent, 'yesterday', 'the label is not rewritten');
  assert.match(t.title, /2026/);
});

// ---- Fresh on return (the installed app) ----

/** app.js in a page of the installed app (or a browser tab), with a clock, storage and navigation we control. */
function loadFresh(o: { href?: string; standalone?: boolean; online?: boolean; focused?: string | null; edited?: boolean; draft?: string; fromPost?: boolean } = {}) {
  const docListeners: Record<string, (() => void)[]> = {};
  const winListeners: Record<string, (() => void)[]> = {};
  let clock = 1_000_000;
  const store = new Map<string, string>();
  const replaced: string[] = [];
  const scrolled: [number, number][] = [];
  const history = { scrollRestoration: 'auto' };
  const location = { href: o.href ?? 'https://brain.example/?project=wildlog', replace: (u: string) => { replaced.push(u); } };
  const field = o.draft !== undefined
    ? { tagName: 'TEXTAREA', type: 'textarea', value: o.draft, defaultValue: o.draft, checked: false, defaultChecked: false }
    : { tagName: 'INPUT', type: 'text', value: o.edited ? 'typed' : '', defaultValue: '', checked: false, defaultChecked: false };
  const body = new FakeElement('body');
  if (o.fromPost) body.dataset.fresh = 'off';
  const active = o.focused ? { matches: (s: string) => s.split(',').map((x) => x.trim()).includes(o.focused!) } : { matches: () => false };
  const document = {
    body, visibilityState: 'visible', activeElement: active,
    querySelectorAll: (s: string) => (s === 'input, textarea, select' ? [field] : s === 'textarea' && field.tagName === 'TEXTAREA' ? [field] : []),
    querySelector: () => null,
    createElement: (tag: string) => new FakeElement(tag),
    addEventListener: (type: string, fn: () => void) => { (docListeners[type] ??= []).push(fn); },
  };
  class FakeDate extends Date { static now() { return clock; } }
  runInNewContext(readFileSync(new URL('./static/app.js', import.meta.url), 'utf8'), {
    document, navigator: { onLine: o.online ?? true, standalone: false }, Element: FakeElement, Intl, Date: FakeDate, Number, String,
    setTimeout: () => 0, clearTimeout: () => {}, location, history, scrollY: 640,
    scrollTo: (x: number, y: number) => { scrolled.push([x, y]); },
    sessionStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); }, removeItem: (k: string) => { store.delete(k); } },
    matchMedia: (q: string) => ({ matches: q === '(display-mode: standalone)' ? (o.standalone ?? true) : false }),
    addEventListener: (type: string, fn: () => void) => { (winListeners[type] ??= []).push(fn); },
  });
  const away = (ms: number) => {
    document.visibilityState = 'hidden'; for (const fn of docListeners.visibilitychange ?? []) fn();
    clock += ms;
    document.visibilityState = 'visible'; for (const fn of docListeners.visibilitychange ?? []) fn();
  };
  const pageshow = () => { for (const fn of winListeners.pageshow ?? []) fn(); };
  return { away, pageshow, store, replaced, scrolled, location, history };
}

test('the installed app reloads the page in place after 2 minutes away, keeping the scroll', () => {
  const d = loadFresh();
  d.away(121_000);
  assert.deepEqual(d.replaced, ['https://brain.example/?project=wildlog']);
  assert.equal(d.store.get('scroll:https://brain.example/?project=wildlog'), '640');
});

test('a URL with a fragment is reloaded without it, so the refresh really fetches', () => {
  const d = loadFresh({ href: 'https://brain.example/?project=wildlog#panel' });
  d.away(121_000);
  assert.deepEqual(d.replaced, ['https://brain.example/?project=wildlog']);
  assert.equal(d.store.get('scroll:https://brain.example/?project=wildlog'), '640');
  d.location.href = 'https://brain.example/?project=wildlog';
  d.pageshow();
  assert.deepEqual(d.scrolled, [[0, 640]]);
});

test('it never navigates over a focused or edited field, offline, after a short absence, or in a browser tab', () => {
  for (const [why, o, ms] of [
    ['a focused field', { focused: 'textarea' }, 121_000], ['an edited field', { edited: true }, 121_000], ['offline', { online: false }, 121_000],
    ['a short absence', {}, 60_000], ['a browser tab', { standalone: false }, 121_000],
  ] as const) {
    const d = loadFresh(o);
    d.away(ms);
    assert.deepEqual(d.replaced, [], why);
  }
});

test('a page drawn from a form POST is never refreshed, even when its draft looks untouched', () => {
  // A preview, a refused note or a conflict view puts the draft back as the field's own text (value === defaultValue):
  // a GET of the same URL would show the Pages home or the saved page instead, and the draft would be gone.
  const posted = loadFresh({ fromPost: true });
  posted.away(121_000);
  assert.deepEqual(posted.replaced, [], 'the server marked the page data-fresh="off"');
  const draft = loadFresh({ draft: '# My new page\nhalf written' });
  draft.away(121_000);
  assert.deepEqual(draft.replaced, [], 'a textarea holding text is never thrown away, mark or no mark');
});

test('back from the replace, the scroll comes back once', () => {
  const d = loadFresh();
  d.store.set('scroll:https://brain.example/?project=wildlog', '640');
  d.pageshow();
  assert.deepEqual(d.scrolled, [[0, 640]]);
  assert.equal(d.store.has('scroll:https://brain.example/?project=wildlog'), false);
  assert.equal(d.history.scrollRestoration, 'auto', 'manual only around the one restore');
  d.pageshow();
  assert.equal(d.scrolled.length, 1);
});

test('app.js never calls location.reload', () => {
  assert.doesNotMatch(readFileSync(new URL('./static/app.js', import.meta.url), 'utf8'), /location\.reload\(/);
});

// ---- Old Settings bookmarks ----

/** app.js on a page whose address we control, with one <details id="notyet"> to open. */
function loadAt(pathname: string, hash: string) {
  const script = readFileSync(new URL('./static/app.js', import.meta.url), 'utf8');
  const replaced: string[] = [];
  // FakeElement keeps its tag as `tag`; app.js reads the DOM's `tagName`.
  const notyet = Object.assign(new FakeElement('details'), { tagName: 'DETAILS', open: false });
  const location = { pathname, hash, href: `https://brain.example${pathname}${hash}`, replace: (u: string) => { replaced.push(u); } };
  const document = {
    body: new FakeElement('body'),
    querySelectorAll: () => [],
    querySelector: () => null,
    getElementById: (id: string) => (id === 'notyet' ? notyet : null),
    createElement: (tag: string) => new FakeElement(tag),
    addEventListener: () => {},
  };
  runInNewContext(script, {
    document, navigator: {}, Element: FakeElement, Intl, Date, Number, String,
    setTimeout: () => 0, clearTimeout: () => {}, location, matchMedia: () => ({ matches: false }),
  });
  return { replaced, notyet };
}

test('old Settings bookmarks are sent on', () => {
  // A /settings#… bookmark from before the move lands on that screen's new home.
  assert.deepEqual(loadAt('/settings', '#tidy').replaced, ['/facts/tidy']);
  assert.deepEqual(loadAt('/settings', '#approvals').replaced, ['/approvals']);
  assert.deepEqual(loadAt('/settings', '#moved').replaced, ['/pages/moved']);
  // A hash that still names a Settings section stays where it is.
  assert.deepEqual(loadAt('/settings', '#connections').replaced, []);
  // On any page, a hash naming a <details> opens it (the server cannot).
  const home = loadAt('/', '#notyet');
  assert.deepEqual(home.replaced, []);
  assert.equal(home.notyet.open, true);
});

// ---- The phone's search row ----

test('a tap on Cancel or a pointer keeps the field until the click', () => {
  // The keyboard is up: a tap on Cancel or a search pointer must not lose to the field's blur, or the tap lands
  // nowhere; pointerdown holds the focus, and Cancel's click is what blurs the field.
  const cancel = new FakeElement('button', ['.find-cancel', '.find-cancel, .find-hints a']);
  const pointer = new FakeElement('a', ['.find-hints a', '.find-cancel, .find-hints a']);
  const input = Object.assign(new FakeElement('input'), { blurred: 0, blur() { this.blurred++; } });
  const addedClasses: string[] = [];
  const listeners: Record<string, ((e: unknown) => void)[]> = {};
  const document = {
    documentElement: { classList: { add: (c: string) => { addedClasses.push(c); } } },
    body: new FakeElement('body'),
    querySelectorAll: () => [],
    querySelector: (s: string) => (s === '.find input' ? input : null),
    createElement: (tag: string) => new FakeElement(tag),
    addEventListener: (type: string, fn: (e: unknown) => void) => { (listeners[type] ??= []).push(fn); },
  };
  runInNewContext(readFileSync(new URL('./static/app.js', import.meta.url), 'utf8'), {
    document, navigator: {}, Element: FakeElement, Intl, Date, Number, String,
    setTimeout: () => 0, clearTimeout: () => {}, matchMedia: () => ({ matches: false }),
  });
  const prevented: string[] = [];
  const tap = (type: string, target: FakeElement) => {
    for (const fn of listeners[type] ?? []) fn({ target, preventDefault: () => { prevented.push(type); } });
  };
  tap('pointerdown', cancel);
  tap('pointerdown', pointer);
  assert.equal(prevented.length, 2, 'both taps keep the field until the click');
  assert.equal(input.blurred, 0, 'nothing blurred the field yet');
  tap('click', cancel);
  assert.equal(input.blurred, 1, 'Cancel blurs the search input');
  tap('click', pointer);
  assert.equal(input.blurred, 1, 'a pointer leaves the field alone; the link navigates');
  assert.ok(addedClasses.includes('js'), 'html.js says the script ran');
});

test('⌘K focuses the visible search field, not the hidden header one', () => {
  const header = new FakeElement('input'), side = new FakeElement('input');
  Object.assign(header, { getClientRects: () => [] });
  Object.assign(side, { getClientRects: () => [{}] });
  const keydown: ((e: unknown) => void)[] = [];
  const document = {
    body: new FakeElement('body'),
    querySelectorAll: (s: string) => (s === 'form[role="search"] input[name="q"]' ? [header, side] : []),
    querySelector: (s: string) => (s === 'form.find input[name="q"]' ? header : null),
    createElement: (tag: string) => new FakeElement(tag),
    addEventListener: (type: string, fn: (e: unknown) => void) => { if (type === 'keydown') keydown.push(fn); },
  };
  runInNewContext(readFileSync(new URL('./static/app.js', import.meta.url), 'utf8'), {
    document, navigator: {}, Element: FakeElement, Intl, Date, Number, String, setTimeout: () => 1, clearTimeout: () => {},
  });
  let prevented = false;
  for (const fn of keydown) fn({ key: 'k', metaKey: true, ctrlKey: false, altKey: false, shiftKey: false, target: document.body, preventDefault: () => { prevented = true; } });
  assert.equal(side.focused, true);
  assert.equal(side.selected, true);
  assert.equal(header.focused, false);
  assert.ok(prevented);
});

// ---- Wide folds (desktop D1): folds marked data-desk-open open while the window is 1100 px or wider ----

/** A <details> with an `open` that queues a toggle event, as a browser fires it after the change (asynchronously). */
class FakeDetails {
  #open: boolean;
  listeners: (() => void)[] = [];
  dataset: Record<string, string>;
  constructor(mark: string | undefined, open = false, private readonly queue: (() => void)[]) {
    this.#open = open;
    this.dataset = mark === undefined ? {} : { deskOpen: mark };
  }
  get open() { return this.#open; }
  set open(v: boolean) {
    if (v === this.#open) return;
    this.#open = v;
    this.queue.push(() => this.listeners.forEach((fn) => fn()));
  }
  addEventListener(type: string, fn: () => void) { if (type === 'toggle') this.listeners.push(fn); }
}

function wideFolds(at: { wide: boolean; xl: boolean }, marks: [string | undefined, boolean][], opts: { matchMedia?: boolean } = {}) {
  const queue: (() => void)[] = [];
  const folds = marks.map(([mark, open]) => new FakeDetails(mark, open, queue));
  const mqls: Record<string, { matches: boolean; fns: (() => void)[]; addEventListener: (t: string, fn: () => void) => void }> = {};
  const mql = (q: string, matches: boolean) => (mqls[q] = { matches, fns: [], addEventListener(t, fn) { if (t === 'change') this.fns.push(fn); } });
  mql('(min-width: 1100px)', at.wide); mql('(min-width: 1920px)', at.xl);
  const document = {
    body: new FakeElement('body'),
    querySelectorAll: (s: string) => (s === 'details[data-desk-open]' ? folds.filter((f) => f.dataset.deskOpen !== undefined) : []),
    querySelector: () => null, createElement: (tag: string) => new FakeElement(tag), addEventListener: () => {},
  };
  const context: Record<string, unknown> = { document, navigator: {}, Element: FakeElement, Intl, Date, Number, String, setTimeout: () => 1, clearTimeout: () => {} };
  if (opts.matchMedia !== false) context.matchMedia = (q: string) => mqls[q] ?? { matches: false, addEventListener() {} };
  runInNewContext(readFileSync(new URL('./static/app.js', import.meta.url), 'utf8'), context);
  const flush = () => { while (queue.length) queue.shift()!(); };
  const change = (q: 'wide' | 'xl', v: boolean) => {
    const m = mqls[q === 'wide' ? '(min-width: 1100px)' : '(min-width: 1920px)']!;
    m.matches = v; m.fns.forEach((fn) => fn()); flush();
  };
  return { folds, flush, change };
}

test('wide: data-desk-open folds open at once; xl folds only from 1920; narrowing closes what it opened', () => {
  const { folds: [d1, dx], flush, change } = wideFolds({ wide: true, xl: false }, [['', false], ['xl', false]]);
  assert.equal(d1!.open, true, 'open synchronously, before any tick');
  assert.equal(dx!.open, false);
  flush();
  assert.equal(d1!.open, true, 'its own toggle event is not taken for the owner closing it');
  change('xl', true);
  assert.equal(dx!.open, true);
  change('xl', false);
  assert.equal(dx!.open, false);
  assert.equal(d1!.open, true);
  change('wide', false);
  assert.equal(d1!.open, false);
});

test('a fold that was already open, or that the owner closed, is left alone', () => {
  const { folds: [d1, already], flush, change } = wideFolds({ wide: true, xl: false }, [['', false], ['', true]]);
  flush();
  d1!.open = false; flush(); // the owner closes it
  change('xl', true);
  assert.equal(d1!.open, false, 'not reopened while still wide');
  change('wide', false);
  assert.equal(already!.open, true, 'never closed: app.js did not open it');
  change('wide', true);
  assert.equal(d1!.open, true, 'after the window was narrow, widening opens it again');
});

test('a fold the owner opened stays open when the window narrows', () => {
  const { folds: [dx], flush, change } = wideFolds({ wide: true, xl: false }, [['xl', false]]);
  dx!.open = true; flush(); // the owner opens a shelf fold below 1920
  change('xl', true); change('xl', false);
  assert.equal(dx!.open, true);
  change('wide', false);
  assert.equal(dx!.open, true);
});

test('narrow at load: nothing opens; widening later opens the marked folds', () => {
  const { folds: [d1, dx, plain], change } = wideFolds({ wide: false, xl: false }, [['', false], ['xl', false], [undefined, false]]);
  assert.deepEqual([d1!.open, dx!.open, plain!.open], [false, false, false]);
  change('wide', true);
  assert.deepEqual([d1!.open, dx!.open, plain!.open], [true, false, false]);
});

test('without matchMedia, or with no marked folds, app.js runs as before', () => {
  assert.doesNotThrow(() => wideFolds({ wide: true, xl: true }, [['', false]], { matchMedia: false }));
  const { folds: [plain] } = wideFolds({ wide: true, xl: true }, [[undefined, false]]);
  assert.equal(plain!.open, false);
});

// ---- desk.js (desktop D2): app.js imports it only when the window is 1100 px or wider, at load or on widening ----

/** Runs app.js with body.dataset.desk set to a data: module that counts its loads in a global named per test. */
async function deskLoads(wide: boolean, opts: { loader?: boolean } = {}) {
  const name = `__deskLoads${Math.random().toString(36).slice(2)}`;
  const g = globalThis as unknown as Record<string, number | undefined>;
  const body = new FakeElement('body');
  body.dataset.desk = `data:text/javascript,globalThis.${name}=(globalThis.${name}??0)+1`;
  const fns: ((e: { matches: boolean }) => void)[] = [];
  const mq = { matches: wide, addEventListener: (t: string, fn: (e: { matches: boolean }) => void) => { if (t === 'change') fns.push(fn); },
    removeEventListener: (t: string, fn: (e: { matches: boolean }) => void) => { const i = fns.indexOf(fn); if (i >= 0) fns.splice(i, 1); } };
  const document = { body, querySelectorAll: () => [], querySelector: () => null, createElement: (tag: string) => new FakeElement(tag), addEventListener: () => {} };
  const rejections: unknown[] = [];
  const onRejection = (r: unknown) => { rejections.push(r); };
  process.on('unhandledRejection', onRejection);
  const context = { document, navigator: {}, Element: FakeElement, Intl, Date, Number, String, setTimeout: () => 1, clearTimeout: () => {},
    matchMedia: (q: string) => (q === '(min-width: 1100px)' ? mq : { matches: false, addEventListener() {}, removeEventListener() {} }) };
  const code = readFileSync(new URL('./static/app.js', import.meta.url), 'utf8');
  const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };
  if (opts.loader === false) runInNewContext(code, context);
  else runInNewContext(code, context, { importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER });
  await settle();
  const widen = async () => { mq.matches = true; for (const fn of [...fns]) fn({ matches: true }); await settle(); };
  const done = () => { process.off('unhandledRejection', onRejection); };
  return { count: () => g[name] ?? 0, widen, rejections, done };
}

test('app.js imports desk.js once when wide at load, never when narrow, and once on widening', async () => {
  const wide = await deskLoads(true);
  assert.equal(wide.count(), 1);
  await wide.widen();
  assert.equal(wide.count(), 1, 'a later change does not import it again');
  wide.done();
  const narrow = await deskLoads(false);
  assert.equal(narrow.count(), 0);
  await narrow.widen();
  assert.equal(narrow.count(), 1);
  await narrow.widen();
  assert.equal(narrow.count(), 1);
  narrow.done();
});

test('app.js survives a failing desk.js import (a vm without a loader)', async () => {
  const r = await deskLoads(true, { loader: false });
  assert.equal(r.count(), 0);
  assert.deepEqual(r.rejections, []);
  r.done();
});

test('a setup check line refreshes itself every 10 seconds from its own address', () => {
  const script = readFileSync(new URL('./static/app.js', import.meta.url), 'utf8');
  assert.match(script, /querySelectorAll\('\[data-setup-status\]'\)/);
  assert.match(script, /setInterval\([\s\S]{0,400}dataset\.setupStatus[\s\S]{0,400}10_?000\)/);
});

test('the setup check line ignores a redirect (an expired login) instead of showing the login page in it', () => {
  const script = readFileSync(new URL('./static/app.js', import.meta.url), 'utf8');
  const poller = script.slice(script.indexOf("querySelectorAll('[data-setup-status]')"));
  assert.match(poller, /redirect: 'manual'/);
  assert.match(poller, /r\.ok && !r\.redirected|r\.status === 200/);
});
