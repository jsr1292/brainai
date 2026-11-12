/*
 * desk.js: the desktop module (desktop design §5–§7). app.js imports it only while the window is 1100 px or wider, so a
 * phone never downloads it. It is one self-contained file (only its own URL carries the fingerprint, so no relative
 * imports). The top half is pure helpers, exported and tested in node; the page part at the bottom runs only in a
 * browser. Under the CSP (default-src 'self') it never writes a style attribute: it toggles classes and attributes,
 * builds its own chrome with createElement and textContent, and adopts fetched pages through DOMParser.
 *
 * Nothing here is needed: with JavaScript off, or "Open things beside the list" off, every link and form still works.
 */

// ---- Preferences (Settings › This Mac), per device in localStorage: absent means on ----

export const PREF = { keys: 'desk.keys', beside: 'desk.beside', nolist: (place) => `desk.nolist.${place}` };

/** Both switches; a missing or throwing storage gives both on (the defaults). */
export function readPrefs(storage) {
  const on = (key) => {
    try { return !storage || storage.getItem(key) !== 'off'; } catch { return true; }
  };
  return { keys: on(PREF.keys), beside: on(PREF.beside) };
}

/** On removes the key (the default), off stores "off". A throwing storage is ignored. */
export function writePref(storage, name, on) {
  try {
    if (on) storage.removeItem(PREF[name]);
    else storage.setItem(PREF[name], 'off');
  } catch { /* storage off: the switch lasts until reload */ }
}

// ---- Keys (design §6) ----

const NOT_TEXT = new Set(['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'file', 'image', 'hidden']);

/** Is focus in a field where keys type text? A button, checkbox or link never is. */
export function isTyping(el) {
  if (!el) return false;
  const tag = String(el.tagName || '').toUpperCase();
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') return !NOT_TEXT.has(String(el.type || 'text').toLowerCase());
  return el.isContentEditable === true;
}

/** ⌘↵ may submit only an approve, decide or save form (design §6): never reject, delete, state, pin, done or undo. */
export function cmdEnterForm(action) {
  if (!action) return false;
  let path = String(action);
  try { path = new URL(path, 'https://desk.invalid/').pathname; } catch { return false; }
  return /\/(approve|decide|note|info)$/.test(path);
}

const DIGITS = { Digit1: 'place1', Digit2: 'place2', Digit3: 'place3', Digit4: 'place4' };
const ARROWS = new Set(['ArrowDown', 'ArrowUp', 'KeyJ', 'KeyK']);
const SIDEWAYS = new Set(['ArrowLeft', 'ArrowRight']);

/**
 * What a keydown does, or null for "let the browser have it". Letters and digits are read from event.code, so a Spanish
 * layout works; "?" from event.key. No single key approves, rejects, deletes, parks or marks done.
 */
export function keyAction(e, ctx) {
  if (e.isComposing) return null;
  if (e.repeat && !ARROWS.has(e.code)) return null;
  const mod = e.metaKey || e.ctrlKey;
  const backslash = e.code === 'Backslash' || e.key === '\\';
  // ⌘K opens the palette from anywhere: typing, shortcuts off, on Graph (design §6).
  if (mod && e.code === 'KeyK' && !e.shiftKey && !e.altKey) return 'palette';
  if (mod && (e.key === 'Enter' || e.code === 'Enter' || e.code === 'NumpadEnter')) return ctx.typing && ctx.inSheetForm ? 'submit' : null;
  if (e.metaKey && backslash) return ctx.screen === 'panes' ? 'hide-list' : null;
  if (e.key === 'Escape' || e.code === 'Escape') return ctx.typing ? 'blur' : 'esc';
  if (mod || e.altKey) return null;
  if (ctx.typing || !ctx.keysOn) return null;
  if (e.key === '?') return 'keys';
  if (ctx.dialog) return null;
  // "/" by key, so Shift+7 on a Spanish keyboard works too.
  if (e.key === '/') return ctx.filter ? 'filter' : null;
  if (DIGITS[e.code]) return DIGITS[e.code];
  if (backslash) return ctx.screen === 'panes' ? 'hide-list' : null;
  if (e.code === 'KeyN') return ctx.screen === 'overview' || ctx.screen === 'panes' ? 'idea' : null;
  // On Graph every arrow is graph3d.js's own.
  if (ctx.screen === 'graph' && (ARROWS.has(e.code) || SIDEWAYS.has(e.code))) return null;
  if (SIDEWAYS.has(e.code)) return ctx.screen === 'week' ? (e.code === 'ArrowLeft' ? 'older' : 'newer') : null;
  if (ARROWS.has(e.code)) {
    const dir = e.code === 'ArrowDown' || e.code === 'KeyJ' ? 'down' : 'up';
    if (ctx.screen === 'week') return ctx.peek ? dir : null;
    if (ctx.screen === 'overview') return dir === 'down' ? 'down' : null;
    if (ctx.screen === 'panes' && ctx.inList) return dir;
    return null;
  }
  if (e.code === 'KeyX') return ctx.screen === 'panes' || ctx.screen === 'week' ? 'tick' : null;
  if (e.code === 'KeyZ') return ctx.toast ? 'undo' : null;
  if (e.code === 'KeyE') return ctx.screen === 'panes' ? 'edit' : null;
  return null;
}

/** A fold marked data-desk-open ("" from 1100 px, "xl" from 1920) is open while wide. */
export function deskFoldWanted(value, wide, xl) {
  return wide && (value === '' || (value === 'xl' && xl));
}

// ---- The sheet beside the list (design §3, §7): pure helpers ----

/** Which sheet a link opens beside the list, or null for a plain navigation. Same origin only. */
export function sheetKind(href, base) {
  let u, b;
  try { b = new URL(base); u = new URL(href, b); } catch { return null; }
  if (u.origin !== b.origin) return null;
  const q = u.searchParams;
  if (q.has('pane')) return null;
  if (u.pathname === '/') {
    if ((q.get('project') ?? '') !== '') return 'project';
    if (u.hash === '#notyet' && !q.has('project')) return 'notyet';
    return null;
  }
  if (u.pathname === '/approvals') return 'approval';
  if (/^\/discussions\/[^/]+$/.test(u.pathname)) return 'discussion';
  if (/^\/pages\/[0-9a-f-]{36}$/.test(u.pathname)) return 'page';
  const fact = /^\/memories\/([^/]+)$/.exec(u.pathname);
  if (fact && fact[1] !== 'new') return 'fact';
  return null;
}

/** The place whose frame shows a sheet of this kind. */
export function sheetPlace(kind) {
  if (kind === 'page') return 'pages';
  if (kind === 'fact') return 'facts';
  return 'projects';
}

/** The place a path belongs to (the sidebar's places and Settings). */
export function placeOfPath(pathname) {
  const p = String(pathname);
  if (p === '/') return 'projects';
  if (p === '/pages' || p.startsWith('/pages/')) return 'pages';
  if (p === '/facts' || p.startsWith('/facts/') || p.startsWith('/memories/')) return 'facts';
  if (p === '/review' || p.startsWith('/review/') || p === '/growth') return 'week';
  if (p === '/graph') return 'graph';
  if (p === '/settings') return 'settings';
  return 'other';
}

/** Where a place's list pane comes from: a fact keeps the Facts list it came from (its `from`), else all facts. */
export function listSource(place, href) {
  if (place === 'projects') return '/?pane=projects';
  if (place === 'pages') return '/pages';
  if (place !== 'facts') return null;
  let from = null;
  try { from = new URL(href, 'https://desk.invalid/').searchParams.get('from'); } catch { /* not a URL */ }
  return from && /^\/facts(?:\?|$)/.test(from) ? from : '/facts';
}

/** Do this sheet's forms post by fetch (true), or natively (Settings, anything else)? */
export function postScope(kind) {
  return ['project', 'approval', 'discussion', 'notyet', 'page', 'fact'].includes(kind);
}

/** A #link to the page already shown (path and query `shown`): the browser jumps inside the sheet, nothing loads. */
export function sameDocAnchor(href, shown, base) {
  let u, b;
  try { b = new URL(base); u = new URL(href, b); } catch { return false; }
  return u.origin === b.origin && u.hash.length > 1 && u.pathname + u.search === shown;
}

/** The folds desk.js opens while wide, in a page it shows or in content it swaps in (never a closed-by-design fold). */
export const DESK_FOLDS = [
  'main > .narrow > details.filter-fold',
  '.desk-list details.filter-fold',
  '.desk-sheet details#history.pfold',
  '.review .decisions details.more',
];

/** Scroll-spy: the last heading whose top is at or above the line; the first when none is; -1 with none. */
export function spyIndex(tops, line) {
  if (tops.length === 0) return -1;
  let at = 0;
  tops.forEach((t, i) => { if (t <= line) at = i; });
  return at;
}

/** The side fragment of the same route (?pane=side), or null when the sheet has none. */
export function sideUrl(kind, href, base, approvalId) {
  const u = new URL(href, base);
  if (kind === 'project') return `/?project=${encodeURIComponent(u.searchParams.get('project') ?? '')}&pane=side`;
  if (kind === 'approval') return `/approvals?pane=side${approvalId ? `&id=${encodeURIComponent(approvalId)}` : ''}`;
  if (kind === 'discussion' || kind === 'fact') return `${u.pathname}?pane=side`;
  return null;
}

/** The sheet bar's crumb. For a discussion, `title` is its project (or empty: "Discussions"). */
export function crumbParts(kind, title) {
  if (kind === 'project') return ['Projects', title];
  if (kind === 'approval') return title ? ['Inbox', title] : ['Inbox'];
  if (kind === 'discussion') return ['Projects', title || 'Discussions', 'Discussion'];
  return ['Projects', 'Not in the brain yet'];
}

/**
 * Do ↑ ↓ step the list (true) or scroll the sheet? In the list, on the body, or on the sheet's heading where desk.js put
 * focus when it opened the sheet (`landing`): a project opened by a click or by ↓ steps on with ↓, as in Mail. Focus
 * the owner moved into the sheet (a click, Tab to a link) scrolls it.
 */
export function listFocus(a, landing) {
  if (!a) return true;
  const tag = String(a.tagName || '').toUpperCase();
  if (tag === 'BODY' || tag === 'HTML') return true;
  if (a.closest('.phome.has-panel > .plist') || a.closest('.desk-panes > .desk-list')) return true;
  return landing !== null && landing !== undefined && a === landing;
}

/** Where ↑ ↓ count from: the list row with keyboard focus, else the selected row. */
export function stepStart(focusedAt, selectedAt) {
  return focusedAt >= 0 ? focusedAt : selectedAt;
}

/** The approval sheet shows one suggestion: the one asked for (?id=) while it still waits, else the first. */
export function approvalPick(ids, wanted) {
  return wanted !== undefined && ids.includes(wanted) ? wanted : ids[0];
}
/** The suggestion an approval sheet's URL asks for (/approvals?id=), if any. */
export function approvalIdOf(href) {
  try { return new URL(href, 'https://desk.invalid/').searchParams.get('id') ?? undefined; } catch { return undefined; }
}

/** The next row's index, clamped to the list; from no row, the first. */
export function stepIndex(at, dir, n) {
  return Math.min(n - 1, Math.max(0, at + dir));
}

/** A swap to the URL already shown (ignoring the hash) replaces the history entry instead of adding one. */
export function historyMode(from, to) {
  const strip = (h) => String(h).split('#')[0];
  return strip(from) === strip(to) ? 'replace' : 'push';
}

// ---- Forms in the sheet (design §4.2, §7): pure helpers ----

/** Where a submit goes: the pressed button's own formaction/formmethod when it has one (Reject), else the form's. */
export function requestFor(form, submitter) {
  const url = submitter && submitter.hasAttribute('formaction') ? submitter.formAction : form.action;
  const method = String(submitter && submitter.hasAttribute('formmethod') ? submitter.formMethod : form.method).toLowerCase() === 'get' ? 'get' : 'post';
  return { url, method };
}

/**
 * What a POST's answer means for the sheet: a redirect to a sheet of the same place swaps it; to anything else (another
 * place, a list) goes there for real; no redirect, in place.
 */
export function postOutcome(res, base, place = 'projects') {
  if (!res.redirected) return { do: 'inplace' };
  const kind = sheetKind(res.url, base);
  return kind && sheetPlace(kind) === place ? { do: 'swap', url: res.url } : { do: 'go', url: res.url };
}

/** A list fold's lasting name: its id, else its summary without counts. Refreshing the list keeps folds open by it. */
export function foldKey(summaryText, id) {
  if (id) return `#${id}`;
  return String(summaryText ?? '').replace(/[\d,]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** A page sheet's crumb: its area, its project when it has one, its title. */
export function pageCrumb(area, project, title) {
  return project ? [area, project, title] : [area, title];
}

/** Decided's "N more ›" on the desktop (nine rows shown), or null when every row shows. */
export function capLabel(total, cap = 9) {
  return total > cap ? `${total - cap} more ›` : null;
}

/** The tick toast's words. */
export function toastText(text) {
  const t = String(text);
  return `Ticked “${t.length > 60 ? `${t.slice(0, 60)}…` : t}”`;
}

// ---- The ⌘K palette (design §4.10): pure helpers ----

/** The places the palette's Do group jumps to (GET only), in the sidebar's order; the digit where one exists, and another name it answers to. */
const DO_PLACES = [['Projects', '/', '1'], ['Pages', '/pages', '2'], ['Facts', '/facts'], ['Inbox', '/approvals', undefined, 'Approvals'],
  ['Last week', '/review', '3'], ['So far', '/review/now'], ['Growth', '/growth'], ['Graph', '/graph', '4'], ['Settings', '/settings']];
const fold = (t) => String(t).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/**
 * The palette's Do group: only safe jumps (design §4.10). First, for a query of 1–140 characters, adding it as an idea
 * (which only fills the idea field: the owner presses Add idea); then Go to each place the query names (accents and
 * case aside; all of them for an empty query). Growth is not there in work mode. Nothing here posts.
 */
export function paletteDo(q, o) {
  const t = String(q ?? '').trim();
  const out = [];
  if (t.length >= 1 && t.length <= 140) out.push({ label: `Add “${t}” as an idea`, idea: t });
  for (const [name, href, key, alias] of DO_PLACES) {
    if (o.work && name === 'Growth') continue;
    if (t !== '' && !fold(name).includes(fold(t)) && !(alias && fold(alias).includes(fold(t)))) continue;
    out.push(key ? { label: `Go to ${name}`, href, key } : { label: `Go to ${name}`, href });
  }
  return out;
}

/** A row's text in parts, each word of the query (two characters or more) marked wherever it occurs. */
export function markParts(text, q) {
  const s = String(text);
  const words = String(q ?? '').trim().split(/\s+/).filter((w) => w.length >= 2).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (words.length === 0) return [{ text: s, hit: false }];
  const re = new RegExp(words.join('|'), 'gi');
  const out = [];
  let at = 0;
  for (const m of s.matchAll(re)) {
    if (m[0].length === 0) continue;
    if (m.index > at) out.push({ text: s.slice(at, m.index), hit: false });
    out.push({ text: m[0], hit: true });
    at = m.index + m[0].length;
  }
  if (at < s.length) out.push({ text: s.slice(at), hit: false });
  return out.length ? out : [{ text: s, hit: false }];
}

/** Numbers each request; only the newest one's answer is shown. */
export function createLatest() {
  let n = 0;
  return { next: () => ++n, isLatest: (k) => k === n };
}

/** The palette's groups in order: In the graph (only on Graph), Projects, Pages, Facts, Do; others are left out. */
export function paletteOrder(labels, onGraph) {
  return ['In the graph', 'Projects', 'Pages', 'Facts', 'Do'].filter((l) => labels.includes(l) && (onGraph || l !== 'In the graph'));
}

// ---- The page part: only in a browser ----

const browser = typeof document !== 'undefined' && typeof window !== 'undefined' && typeof matchMedia === 'function';

/** Every listener desk.js adds hangs off this; tear-down aborts it. */
let ac = null;
/** Set once desk.js has moved page content around (the sheet): narrowing then reloads the canonical page. */
let touched = false;
/** Nodes desk.js added (keys dialog, toast, hint, This Mac rows): removed on tear-down when nothing was moved. */
const inserted = new Set();
/** Undo steps for changes to the page's own nodes (the index status, folds desk.js opened), run on tear-down. */
const restores = [];

const wideQ = browser ? matchMedia('(min-width: 1100px)') : null;
const xlQ = browser ? matchMedia('(min-width: 1920px)') : null;

function storage() {
  try { return window.localStorage; } catch { return null; }
}
const prefs = () => readPrefs(storage());

function el(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else n.setAttribute(k, v === true ? '' : String(v));
  }
  for (const kid of kids) if (kid !== null && kid !== undefined) n.append(kid);
  return n;
}
function add(node) {
  inserted.add(node);
  return node;
}

/** Folds desk.js opened and still holds: tear-down closes them (an owner's toggle lets go, as app.js does). */
const mineFolds = new Set();
/** The state desk.js just set on a fold: its toggle event is not the owner's. */
const expectedFold = new Map();
const watchedFolds = new WeakSet();
let foldsRestore = false;

/**
 * Opens the folds marked data-desk-open in content desk.js put on the page (app.js does it for the page itself), and
 * every DESK_FOLDS match under `root` (in the page or in content swapped in). Tear-down closes the ones still held.
 */
function openDeskFolds(root) {
  for (const d of root.querySelectorAll('details[data-desk-open]')) {
    if (deskFoldWanted(d.dataset.deskOpen, wideQ.matches, xlQ.matches)) d.open = true;
  }
  const all = root === document ? [...document.querySelectorAll('details')]
    : [...(root.matches?.('details') ? [root] : []), ...root.querySelectorAll('details')];
  for (const d of all) {
    if (d.open || !DESK_FOLDS.some((sel) => d.matches(sel))) continue;
    expectedFold.set(d, true);
    d.open = true;
    mineFolds.add(d);
    if (watchedFolds.has(d)) continue;
    watchedFolds.add(d);
    d.addEventListener('toggle', () => {
      const ours = expectedFold.has(d) && expectedFold.get(d) === d.open;
      expectedFold.delete(d);
      if (!ours) mineFolds.delete(d);
    });
  }
  if (!foldsRestore) {
    foldsRestore = true;
    restores.push(() => {
      for (const d of mineFolds) if (d.isConnected && d.open) d.open = false;
      mineFolds.clear();
      foldsRestore = false;
    });
  }
}

/** The panes of a place: `main > .desk-panes[data-place]` (Projects keeps its D2 classes beside them). */
const frame = () => document.querySelector('main > .desk-panes');
/** The frame's list pane. */
const listPane = () => frame()?.querySelector(':scope > .desk-list') ?? null;
/** The place the panes show, or null with none. */
const framePlace = () => frame()?.dataset.place ?? null;

function screen() {
  if (frame() || document.querySelector('main > .phome.has-panel')) return 'panes';
  if (document.querySelector('main > .phome') || factsOverview()) return 'overview';
  if (document.querySelector('main > .review')) return 'week';
  if (document.body.classList.contains('graph-on')) return 'graph';
  return 'other';
}

// ---- The keys sheet ----

let keysDialog = null;
function keysSheet() {
  if (keysDialog) return keysDialog;
  const k = (keys, words) => [el('dt', {}, ...keys.flatMap((x, i) => (i ? [' ', el('kbd', { text: x })] : [el('kbd', { text: x })]))), el('dd', { text: words })];
  const rows = [
    [['⌘K'], 'Search'],
    [['1', '4'], 'Projects, Pages, Week, Graph'],
    [['↑', '↓'], 'Move in the list, the sheet follows'],
    [['Esc'], 'Close, back to the overview'],
    [['\\'], 'Hide or show the list'],
    [['e'], 'Edit what is open'],
    [['x'], 'Tick the item in focus, with Undo (not on Week)'],
    [['z'], 'Undo the tick'],
    [['n'], 'Write an idea (Projects)'],
    [['/'], 'Filter the list (Facts)'],
    [['←', '→'], 'Older or newer week (Week)'],
    [['⌘↵'], 'Approve or decide, inside the sheet'],
    [['?'], 'This sheet'],
  ];
  const dl = el('dl');
  for (const [keys, words] of rows) {
    const [dt, dd] = k(keys, words);
    if (keys[0] === '1') { dt.textContent = ''; dt.append(el('kbd', { text: '1' }), '–', el('kbd', { text: '4' })); }
    dl.append(dt, dd);
  }
  dl.append(el('dt'), el('dd', { class: 'desk-muted', text: 'No single key approves, rejects or deletes.' }));
  keysDialog = add(el('dialog', { class: 'desk-keys', 'aria-labelledby': 'desk-keys-h' },
    el('h2', { id: 'desk-keys-h', text: 'Keys' }),
    el('p', { text: 'Single keys only work outside a text field. Turn them off in Settings › This Mac.' }),
    dl));
  document.body.append(keysDialog);
  return keysDialog;
}
/** A modal is open (desk.js's keys sheet, Delete…'s question, the palette, or the picture viewer): single keys wait. */
const dialogOpen = () => !!document.querySelector('dialog.desk-keys[open], dialog.desk-confirm[open], dialog.desk-palette[open], dialog.viewer[open]');

// ---- Keydown ----

function keyContext() {
  const a = document.activeElement;
  const form = a && a.form ? a.form : null;
  const sheetForm = !!(form && form.closest('.desk-sheet, .phome.has-panel > .ppanel') && cmdEnterForm(form.getAttribute('action') ?? ''));
  const inList = listFocus(a, landing);
  const shown = (n) => !!n && n.getClientRects().length > 0;
  const filter = [...document.querySelectorAll('.desk-list input[name="q"], main > .narrow details.filter-fold input[name="q"], main > .narrow form.frow-filters input[name="q"]')].some(shown);
  return {
    typing: isTyping(a), keysOn: prefs().keys, screen: screen(), inSheetForm: sheetForm, inList, toast: hooks.toastOpen(), dialog: dialogOpen(),
    filter, peek: !!document.querySelector('dialog.desk-peek[open]'), palette: !!document.querySelector('dialog.desk-palette[open]'),
  };
}

/** Later parts (the sheet, the toast) register here; each returns true when it handled the action. */
const hooks = {
  toastOpen: () => false,
  /** Key actions: each returns true when it handled one. */
  actions: [],
  /** Esc in the panes: a menu or toast closes first (true when handled). */
  esc: [],
  /** Clicks on a summary (For you's approval, Not in the brain yet). */
  clicks: [],
  /** Sheet kinds with their own way in (notyet): return a promise to take over. */
  open: [],
  /** After a page's root is in the sheet. */
  filled: [],
  /** A post's answer, before the usual outcome (Not in the brain yet): true when handled. */
  posted: [],
  /** After a post swapped the sheet, and after its side fragment came. */
  swapped: [],
  sided: [],
  mountNotyet: null,
  /** Per place: focus on the overview row after the kept overview is back (Projects: focusReturn). */
  restored: {},
  /** Per place: the list pane fetched again after a post (Projects: refreshList's own). */
  refresh: {},
};
/** Set-up steps of the later parts, each given the AbortSignal that tear-down aborts. */
const setups = [];

function onKey(e) {
  const action = keyAction(e, keyContext());
  if (!action) return;
  if (action === 'esc' && keysDialog?.open) { e.preventDefault(); keysDialog.close(); return; }
  if (action === 'keys') {
    e.preventDefault();
    const d = keysSheet();
    if (d.open) d.close(); else d.showModal();
    return;
  }
  if (action === 'palette') return; // the window's capture listener opens it
  if (action === 'blur') { document.activeElement?.blur?.(); return; }
  if (action.startsWith('place')) {
    e.preventDefault();
    location.assign(['/', '/pages', '/review', '/graph'][Number(action.slice(5)) - 1]);
    return;
  }
  for (const h of hooks.actions) if (h(action, e)) return;
  if (action === 'idea' && screen() === 'overview') {
    const field = document.getElementById('idea-text');
    if (field) { e.preventDefault(); field.focus(); }
  }
}

// ---- The On the go hint ----

function addHint() {
  const ongo = document.querySelector('.phome:not(.has-panel) #ongo');
  if (!ongo || !prefs().keys || ongo.querySelector('.desk-hint')) return;
  ongo.append(add(el('span', { class: 'desk-hint' }, el('kbd', { text: '↓' }), ' opens beside the list')));
}

// ---- Settings › This Mac (design §4.9): two switches, stored per device ----

function thisMac() {
  if (location.pathname !== '/settings') return;
  let section = document.getElementById('this-device');
  if (!section) {
    // Work mode has no This device section: desk.js adds one before Connections.
    const connections = document.getElementById('connections');
    if (!connections) return;
    section = add(el('section', { id: 'this-device', class: 'panel' }, el('div', { class: 'panel-head' }, el('h2', { text: 'This Mac' }))));
    connections.before(section);
  }
  if (section.querySelector('.desk-mac')) return;
  const status = document.querySelector('a[href="#this-device"] .st');
  if (status) {
    const before = [...status.childNodes];
    restores.push(() => status.replaceChildren(...before));
  }
  // Looked up each time: on the desktop, Settings' index row for This Mac may be added after this (work mode).
  const showStatus = () => { const st = document.querySelector('a[href="#this-device"] .st'); if (st) st.textContent = prefs().keys ? 'Shortcuts on' : 'Shortcuts off'; };
  const row = (name, key, title, note) => {
    const noteId = `desk-mac-${key}`;
    const sw = el('button', { type: 'button', class: 'desk-switch', role: 'switch', 'aria-checked': String(prefs()[key]), 'aria-label': title, 'aria-describedby': noteId });
    sw.addEventListener('click', () => {
      const on = sw.getAttribute('aria-checked') !== 'true';
      writePref(storage(), key, on);
      sw.setAttribute('aria-checked', String(on));
      showStatus();
    });
    return el('li', {}, el('span', { class: 'desk-mac-name', text: title }), el('span', { class: 'desk-mac-note', id: noteId, text: note }), sw);
  };
  const list = add(el('ul', { class: 'desk-mac' },
    row('keys', 'keys', 'Keyboard shortcuts', 'Single keys such as 1–4, x and e. ⌘K and Esc always work.'),
    row('beside', 'beside', 'Open things beside the list', 'Off opens every project, page and fact as its own page, like the iPhone.')));
  const head = section.querySelector('.panel-head');
  if (head) head.after(list); else section.prepend(list);
  showStatus();
}

// ---- The sheet beside the list (design §3, §4.1, §4.2, §7) ----

/** Bumped by every open, swap, return to the overview and history step: a response that lands later does nothing. */
let sheetGen = 0;
/** What focusSheet focused when the sheet opened: ↑ ↓ still step the list from there (listFocus). */
let landing = null;
let openAbort = null;
/** The overview's own .phome, kept detached while the panes show, so Esc puts it back at once. */
let homeNode = null;
/** /?pane=projects, fetched once per session and again after a post (refreshList). */
let listCache = null;
/** What the page shows (path and query): a history step to the same with no state is an in-page anchor. */
let shownKey = null;

const pathKey = (href) => { const u = new URL(href, location.href); return u.pathname + u.search; };
/** Does a list link open the sheet shown (path and query `key`, of `kind`)? Every approval link opens the one sheet. */
function sameSheet(href, key, kind) {
  const k = sheetKind(href, location.href);
  if (!k || kind === 'notyet') return false;
  return kind === 'approval' ? k === 'approval' : pathKey(href) === key;
}
const sheet = () => document.getElementById('desk-sheet');
const besideOn = () => prefs().beside;
const isAbort = (e) => e && e.name === 'AbortError';

function svgX() {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', 'desk-x-icon');
  const path = document.createElementNS(NS, 'path');
  path.setAttribute('d', 'M6 6l12 12M18 6 6 18');
  svg.append(path);
  return svg;
}

function liveSay(text) {
  let p = document.getElementById('desk-live');
  if (!p) {
    p = add(el('p', { id: 'desk-live', class: 'visually-hidden', role: 'status' }));
    document.body.append(p);
  }
  p.textContent = text;
}

function buildSheet(place = 'projects') {
  const hide = el('button', { type: 'button', class: 'desk-hide', 'aria-pressed': 'false', text: 'Hide list' });
  hide.addEventListener('click', () => toggleList());
  return el('section', { class: 'desk-sheet', id: 'desk-sheet', tabindex: '-1' },
    el('div', { class: 'desk-bar' },
      el('nav', { class: 'desk-crumb', 'aria-label': 'Where you are' }),
      el('div', { class: 'desk-acts' }, hide, el('a', { class: 'desk-x', href: placeOf(place)?.overview() ?? '/', 'aria-label': 'Close (Esc)' }, svgX()))),
    el('div', { class: 'desk-body' }, el('div', { class: 'desk-head' }), el('div', { class: 'desk-cols' }, el('div', { class: 'desk-main' }), el('div', { class: 'desk-aside' }))));
}

function addOverview(plist) {
  if (!plist || plist.querySelector(':scope > a.desk-overview')) return;
  const h1 = plist.querySelector(':scope > h1');
  const a = el('a', { class: 'desk-overview', href: '/', text: 'Overview' });
  if (h1) h1.after(a); else plist.prepend(a);
}

function setCrumb(parts, lead = null) {
  const s = sheet();
  const nav = s.querySelector('.desk-crumb');
  const kids = lead ? [lead] : [];
  parts.forEach((p, i) => {
    if (i === parts.length - 1) kids.push(el('b', { text: p }));
    else kids.push(el('span', { text: p }), el('span', { class: 'desk-sep', 'aria-hidden': 'true', text: '›' }));
  });
  nav.replaceChildren(...kids);
  s.setAttribute('aria-label', parts[parts.length - 1]);
}

/**
 * A project's heading (title, error, meta line, jump row) goes above both columns, as in the mockup; its Pages,
 * Discussions and Facts (and their links) go to the side column; Manage stays (the bar takes it, Task 7).
 */
function splitPanel(panel, aside, head) {
  head.append(...panel.querySelectorAll(':scope > .ppanel-back, :scope > #panel-title, :scope > .error, :scope > .meta-line.big, :scope > .jump'));
  let n = panel.querySelector(':scope > h3#p-pages, :scope > h3#p-discussions, :scope > h3#p-facts');
  while (n && !(n.nodeType === 1 && n.matches('details.manage'))) {
    const next = n.nextSibling;
    aside.append(n);
    n = next;
  }
}

function placeSide(text, main, aside) {
  if (!text) return;
  const side = new DOMParser().parseFromString(text, 'text/html').querySelector('aside.desk-side');
  if (!side) return;
  for (const sec of [...side.children]) {
    const n = document.importNode(sec, true);
    if (n.classList.contains('desk-next')) main.append(n); else aside.append(n);
  }
}

function keyline() {
  return el('p', { class: 'desk-keyline' },
    el('span', {}, el('kbd', { text: '↑' }), ' ', el('kbd', { text: '↓' }), ' next project'),
    el('span', { class: 'desk-sep', text: ' · ' }),
    el('span', {}, el('kbd', { text: 'x' }), ' tick the item in focus'),
    el('span', { class: 'desk-sep', text: ' · ' }),
    el('span', {}, el('kbd', { text: 'Esc' }), ' back to the overview'));
}

const rootOf = (doc) => doc.querySelector('#panel') ?? doc.querySelector('main > .approvals, main > .discussion, main > .pages-wrap.on-page')
  ?? doc.querySelector('main > .narrow:has(> h1.fact-text)');
const cardId = (n) => (n.querySelector('form[action^="/suggestions/"]')?.getAttribute('action') ?? '').split('/')[2] || undefined;
/** The suggestion the approval sheet shows for this page and URL (approvalPick over the page's cards). */
const shownApprovalId = (root, href) => approvalPick([...root.querySelectorAll('.approval-card')].map(cardId).filter(Boolean), approvalIdOf(href));

/**
 * The approval sheet as the mockup's After view (design §4.3), from today's /approvals page: only the suggestion shown
 * (`id`), its sentence as the h1, the writer leading the meta line, a Suggested inset, then what it Replaces struck
 * through, and the keys on the pills. Returns the suggestion's kind for the crumb (Projects › For you › Profile).
 */
function shapeApproval(node, id) {
  const items = [...node.querySelectorAll(':scope > ul.cards > li')];
  const keep = items.find((li) => cardId(li) === id) ?? items[0];
  for (const li of items) if (li !== keep) li.remove();
  const card = keep?.querySelector('.approval-card');
  if (!card) return '';
  node.querySelector(':scope > h1')?.remove();
  const meta = card.querySelector(':scope > .meta-line');
  const kindLabel = meta?.children[1]?.textContent.trim() ?? '';
  const head = card.querySelector(':scope > .approval-head');
  if (head) {
    const h1 = el('h1', { class: 'approval-head' });
    h1.append(...head.childNodes);
    head.replaceWith(h1);
    const who = h1.querySelector('.writer');
    if (meta && who) meta.prepend(el('li', {}, who.cloneNode(true)));
  }
  const label = (text, cls) => el('p', { class: cls ? `label ${cls}` : 'label', text });
  const proposed = card.querySelector(':scope > blockquote.proposed');
  const current = card.querySelector(':scope > blockquote.current');
  const also = [...card.querySelectorAll(':scope > p.label')].find((p) => p.nextElementSibling?.matches('blockquote.dim'));
  if (proposed) {
    proposed.before(label('Suggested', 'desk-suggested'));
    if (current) {
      if (current.previousElementSibling?.matches('p.label')) current.previousElementSibling.remove(); // "Currently:"
      current.classList.add('replaced');
      proposed.after(label('Replaces'), current);
    }
  }
  for (const q of card.querySelectorAll(':scope > blockquote.dim')) q.classList.add('replaced');
  if (also) { if (current && proposed) also.remove(); else also.textContent = 'Replaces'; }
  const form = card.querySelector('form[action$="/approve"]');
  const approve = form?.querySelector('button.primary');
  // ⌘↵ approves from the form's text field (Edit first); a delete has none, so no hint there.
  if (approve && form.querySelector('textarea[name="content"]')) {
    approve.setAttribute('aria-keyshortcuts', 'Meta+Enter');
    approve.append(el('kbd', { 'aria-hidden': 'true', text: '⌘↵' }));
  }
  const edit = card.querySelector('.edit-first > summary');
  if (edit && prefs().keys) {
    edit.setAttribute('aria-keyshortcuts', 'E');
    edit.append(el('kbd', { 'aria-hidden': 'true', text: 'E' }));
  }
  return kindLabel;
}
/** The crumb's middle part: a project's name, or a discussion's project (the page's back link names it). */
function crumbTitle(kind, doc, root) {
  if (kind === 'project') return root.querySelector('#panel-title')?.textContent.trim() ?? '';
  if (kind === 'discussion') {
    const back = doc.querySelector('main > p.crumb.back a')?.textContent.replace(/^‹\s*/, '').trim() ?? '';
    return back === 'Discussions' ? '' : back;
  }
  return '';
}
function sheetTitle(kind, root) {
  if (kind === 'project') return root.querySelector('#panel-title')?.textContent.trim() ?? '';
  if (kind === 'discussion') return root.querySelector(':scope > h1')?.textContent.trim() ?? 'the discussion';
  if (kind === 'approval') return root.querySelector('h1.approval-head')?.textContent.trim() ?? 'Inbox';
  if (kind === 'page') return root.querySelector('.pmain > h1')?.textContent.trim() ?? 'the page';
  if (kind === 'fact') return root.querySelector(':scope > h1.fact-text')?.textContent.trim() ?? 'the fact';
  return 'Not in the brain yet';
}

/**
 * Puts a canonical page's root (and the side fragment) in the sheet. Later parts hook in through hooks.filled. `href`,
 * the sheet's URL, says which suggestion an approval sheet shows.
 */
function fillSheet(kind, root, sideText, crumb, href) {
  const s = sheet();
  const main = s.querySelector('.desk-main'), aside = s.querySelector('.desk-aside'), head = s.querySelector('.desk-head');
  for (const old of s.querySelectorAll('.desk-acts > details.manage')) old.remove();
  main.replaceChildren();
  aside.replaceChildren();
  head.replaceChildren();
  const node = root.ownerDocument === document ? root : document.importNode(root, true);
  if (kind === 'approval') crumb = shapeApproval(node, shownApprovalId(node, href ?? location.href)) || crumb;
  const title = sheetTitle(kind, node);
  const crumbs = kind === 'page' ? pageCrumbOf(node) : null;
  if (kind === 'page') placePage(node, main, aside);
  else main.append(node);
  openDeskFolds(kind === 'page' ? s.querySelector('.desk-body') : node);
  if (kind === 'project') splitPanel(node, aside, head);
  if (kind === 'fact') splitFact(node, aside);
  placeSide(sideText, main, aside);
  if (kind === 'project' && prefs().keys) main.append(keyline());
  if (kind === 'fact') setCrumb(['Facts', node.querySelector(':scope > .fact-kind a.project')?.textContent.trim() || node.querySelector(':scope > .fact-kind .kind')?.textContent.trim() || 'Fact']);
  else if (crumbs) setCrumb(crumbs.parts, crumbs.ring);
  else setCrumb(crumbParts(kind, crumb));
  s.dataset.kind = kind;
  for (const h of hooks.filled) h(kind, node, s);
  return title;
}

function failLine(href) {
  const s = sheet();
  if (!s) return;
  s.querySelector('.desk-aside').replaceChildren();
  s.querySelector('.desk-head').replaceChildren();
  // Without the hash: a link to the URL already shown plus a fragment would only jump, not load the page.
  const own = String(href).split('#')[0];
  s.querySelector('.desk-main').replaceChildren(el('p', { class: 'desk-fail' }, 'Couldn’t load this. ', el('a', { href: own, 'data-desk-native': '', text: 'Open it as its own page ›' })));
}

function focusSheet(kind) {
  const s = sheet();
  if (!s) return;
  const sel = { project: '#panel-title', discussion: '.discussion > h1', notyet: '.desk-notyet h1', approval: 'h1.approval-head, .approvals > h1', page: '.pmain > h1', fact: 'h1.fact-text' }[kind];
  let t = sel ? s.querySelector(sel) : null;
  if (!t || t.getClientRects().length === 0) t = s;
  else t.setAttribute('tabindex', '-1');
  t.focus({ preventScroll: true });
  landing = t;
}

function fade() {
  const b = sheet()?.querySelector('.desk-body');
  if (!b) return;
  b.classList.remove('desk-fade');
  void b.offsetWidth;
  b.classList.add('desk-fade');
  setTimeout(() => b.classList.remove('desk-fade'), 200);
}

/**
 * Each place's own parts (D34): its overview URL, the rows ↑ ↓ step, how the selection is marked, and how its panes
 * mount from a page that has none. Projects is filled here; Pages, Facts and Settings add theirs further down.
 */
const PLACE = {
  projects: {
    overview: () => '/',
    rows: () => projectRows(),
    mark: (href) => markProject(href),
    canMount: () => !!document.querySelector('main > .phome:not(.has-panel)'),
    mount: (kind, url, opts) => mountPanes(kind, url, opts),
  },
};
const placeOf = (name) => PLACE[name ?? ''] ?? null;
/** A place's overview URL: Facts keeps the list the frame shows (its filter). */
const overviewOf = (place) => (place === 'facts' && frame()?.dataset.overview) || placeOf(place)?.overview() || '/';

/** The list rows that open a sheet, as the list shows them now. */
function listRows() {
  return placeOf(framePlace() ?? 'projects')?.rows() ?? [];
}
function projectRows() {
  const pl = frame()?.querySelector(':scope > .plist');
  if (!pl) return [];
  return [...pl.querySelectorAll('a[href], details.fy-approval > summary')]
    .filter((r) => r.getClientRects().length > 0 && (r.tagName === 'SUMMARY' || sheetKind(r.href, location.href)));
}
const rowHref = (r) => (r.tagName === 'SUMMARY' ? (r.closest('#notyet') ? '/#notyet' : '/approvals') : r.href);

/** Marks the list row for the sheet's URL, in the place's own way. */
function markSelected(href) {
  placeOf(framePlace() ?? 'projects')?.mark(href);
}
/** Projects: the white card on the row, and the fold that holds it opened. */
function markProject(href) {
  const pl = frame()?.querySelector(':scope > .plist');
  if (!pl) return;
  for (const r of pl.querySelectorAll('.is-selected, [aria-current="true"]')) { r.classList.remove('is-selected'); r.removeAttribute('aria-current'); }
  const key = pathKey(href);
  const kind = sheetKind(href, location.href);
  let row = [...pl.querySelectorAll('a[href]')].find((a) => sameSheet(a.href, key, kind));
  if (!row && kind === 'approval') row = pl.querySelector('details.fy-approval > summary');
  if (!row && kind === 'notyet') row = pl.querySelector('#notyet > summary');
  if (!row) return;
  row.classList.add('is-selected');
  row.setAttribute('aria-current', 'true');
  const own = row.tagName === 'SUMMARY' ? row.parentElement : null;
  for (let d = (own ?? row).parentElement?.closest('details'); d; d = d.parentElement?.closest('details')) if (!d.open) d.open = true;
  // The list pane scrolls (only it) so the selected row is in view.
  row.scrollIntoView({ block: 'nearest' });
}

function applyNolist(f) {
  let off = false;
  try { off = window.localStorage.getItem(PREF.nolist(f.dataset.place ?? 'projects')) === '1'; } catch { /* storage off */ }
  setNolist(f, off);
}
function setNolist(f, off) {
  f.classList.toggle('desk-nolist', off);
  const b = f.querySelector('.desk-hide');
  if (b) { b.setAttribute('aria-pressed', String(off)); b.textContent = off ? 'Show list' : 'Hide list'; }
}
function toggleList() {
  const f = frame();
  if (!f || !f.querySelector('.desk-sheet .desk-hide')) return;
  const off = !f.classList.contains('desk-nolist');
  setNolist(f, off);
  const key = PREF.nolist(f.dataset.place ?? 'projects');
  try { if (off) window.localStorage.setItem(key, '1'); else window.localStorage.removeItem(key); } catch { /* storage off */ }
}

async function fetchPage(href, signal, place = framePlace() ?? 'projects') {
  const res = await fetch(href, { headers: { Accept: 'text/html' }, credentials: 'same-origin', signal });
  // Signed out (the login page), or sent somewhere that is not a sheet of this place: go there for real.
  if (res.redirected && postOutcome(res, location.href, place).do !== 'swap') { location.assign(res.url); return null; }
  return { res, doc: new DOMParser().parseFromString(await res.text(), 'text/html') };
}
async function fetchSide(href, signal) {
  if (!href) return null;
  try {
    const r = await fetch(href, { headers: { Accept: 'text/html' }, credentials: 'same-origin', signal });
    return r.ok ? await r.text() : null;
  } catch (e) {
    if (isAbort(e)) throw e;
    return null;
  }
}
async function listPartial(signal, fresh = false) {
  if (listCache !== null && !fresh) return listCache;
  const r = await fetch('/?pane=projects', { headers: { Accept: 'text/html' }, credentials: 'same-origin', signal });
  if (!r.ok || r.redirected) throw new Error('list');
  listCache = await r.text();
  return listCache;
}
function listNode(text) {
  const n = new DOMParser().parseFromString(text, 'text/html').querySelector('.plist');
  if (!n) return null;
  const node = document.importNode(n, true);
  node.classList.add('desk-list');
  return node;
}

function setHistory(push, kind, href) {
  labelList();
  const state = { desk: { kind, place: sheetPlace(kind) } };
  if (push && historyMode(location.href, href) === 'push') history.pushState(state, '', href);
  else history.replaceState(state, '', href);
  shownKey = pathKey(href);
  touched = true;
}

/** After the content is in: the selection, the live line, the cross-fade and focus. */
function settle(kind, href, title, focus) {
  labelList();
  markSelected(href);
  liveSay(`Opened ${title}`);
  fade();
  const s = sheet();
  if (s) s.scrollTop = 0;
  scrollToHash(href);
  if (focus === 'heading') focusSheet(kind);
  else if (focus === 'row') focusRow(kind);
}

/** After a history step: the list row of the sheet shown, else the sheet's heading. */
function focusRow(kind) {
  const row = listPane()?.querySelector(framePlace() === 'pages' ? 'a[aria-current="page"]' : '.is-selected[aria-current="true"]');
  if (row && row.getClientRects().length > 0) row.focus({ preventScroll: true });
  else focusSheet(kind);
}

/** Loads a canonical page (and its side fragment) for the sheet. Resolves null when superseded or sent away. */
async function load(kind, url, gen, signal) {
  const sideP = kind === 'approval' ? null : fetchSide(sideUrl(kind, url, location.href), signal);
  // Watched here too: when the page fails or is superseded first, nothing else awaits it (an abort is no page error).
  sideP?.catch(() => {});
  const page = await fetchPage(url, signal);
  if (!page || gen !== sheetGen) return null;
  const root = rootOf(page.doc);
  let side = null;
  if (kind === 'approval' && root) side = await fetchSide(sideUrl(kind, url, location.href, shownApprovalId(root, page.res.redirected ? page.res.url : url)), signal);
  else if (sideP) side = await sideP;
  if (gen !== sheetGen) return null;
  const href = page.res.redirected ? page.res.url : url;
  return { root, side, doc: page.doc, href };
}

/** Opens a sheet URL beside the list: swapped in the panes, or the panes mounted from the overview. */
async function openInSheet(href, opts = {}) {
  const { push = true, focus = 'heading' } = opts;
  const url = new URL(href, location.href).href;
  const kind = sheetKind(url, location.href);
  if (!kind) { location.assign(url); return; }
  for (const h of hooks.open) { const r = h(kind, url, opts); if (r) return r; }
  const place = sheetPlace(kind);
  if (!frame()) {
    const pl = placeOf(place);
    if (pl && pl.canMount()) return pl.mount(kind, url, opts);
    location.assign(url);
    return;
  }
  // Another place's page loads as that place (a fact from a project sheet opens the Facts panes, never in Projects).
  if (framePlace() !== place) { location.assign(url); return; }
  const gen = ++sheetGen;
  openAbort?.abort();
  const ctl = openAbort = new AbortController();
  markSelected(url);
  let got = null;
  try {
    got = await load(kind, url, gen, ctl.signal);
  } catch (e) {
    if (isAbort(e) || gen !== sheetGen) return;
    failLine(url);
    setHistory(push, kind, url);
    return;
  }
  if (!got) return;
  if (!got.root) { failLine(url); setHistory(push, kind, url); return; }
  const title = fillSheet(kind, got.root, got.side, crumbTitle(kind, got.doc, got.root), got.href);
  setHistory(push, kind, kind === 'project' ? got.href.split('#')[0] + '#panel' : got.href);
  settle(kind, url, title, focus);
}

/** From the overview: the list slides in and the sheet shows; the overview is kept for Esc. */
async function mountPanes(kind, url, opts = {}) {
  const { push = true, focus = 'heading', openFold } = opts;
  const home = document.querySelector('main > .phome:not(.has-panel)');
  if (!home) { location.assign(url); return; }
  const gen = ++sheetGen;
  openAbort?.abort();
  const ctl = openAbort = new AbortController();
  let list, got;
  try {
    [list, got] = await Promise.all([listPartial(ctl.signal), kind === 'notyet' ? Promise.resolve(null) : load(kind, url, gen, ctl.signal)]);
  } catch (e) {
    if (isAbort(e) || gen !== sheetGen) return;
    location.assign(url); // the server's own panes
    return;
  }
  if (gen !== sheetGen || (kind !== 'notyet' && !got)) return;
  const plist = listNode(list);
  if (!plist) { location.assign(url); return; }
  openDeskFolds(plist);
  addOverview(plist);
  if (prefersMotion()) {
    plist.classList.add('desk-in');
    plist.addEventListener('animationend', () => plist.classList.remove('desk-in'), { once: true });
  }
  const f = el('div', { class: 'phome wide has-panel desk-mounted desk-panes', 'data-place': 'projects' }, plist, buildSheet());
  history.replaceState({ desk: { kind: 'overview', place: 'projects' } }, '');
  homeNode = home;
  home.replaceWith(f);
  applyNolist(f);
  if (typeof openFold === 'number') { const fold = plist.querySelectorAll('.pfolds details')[openFold]; if (fold) fold.open = true; }
  if (kind === 'notyet') return hooks.mountNotyet?.(opts);
  if (!got.root) { failLine(url); setHistory(push, kind, url); return; }
  const title = fillSheet(kind, got.root, got.side, crumbTitle(kind, got.doc, got.root), got.href);
  setHistory(push, kind, kind === 'project' ? got.href.split('#')[0] + '#panel' : got.href);
  settle(kind, url, title, focus);
}
const prefersMotion = () => !matchMedia('(prefers-reduced-motion: reduce)').matches;

/** A server-rendered /?project=x: its panel becomes the sheet, in place (nothing is fetched but the side fragment). */
function adoptPanes() {
  const f = document.querySelector('main > .phome.has-panel');
  const panel = f?.querySelector(':scope > #panel');
  if (!f || !panel || f.classList.contains('desk-mounted')) return;
  const s = buildSheet();
  panel.replaceWith(s);
  f.classList.add('desk-mounted', 'desk-panes');
  f.dataset.place = 'projects';
  f.querySelector(':scope > .plist')?.classList.add('desk-list');
  addOverview(f.querySelector(':scope > .plist'));
  applyNolist(f);
  const title = fillSheet('project', panel, null, crumbTitle('project', document, panel));
  touched = true;
  shownKey = pathKey(location.href);
  history.replaceState({ desk: { kind: 'project', place: 'projects' } }, '');
  const gen = sheetGen;
  fetchSide(sideUrl('project', location.href, location.href), undefined).then((text) => {
    if (gen !== sheetGen || !text) return;
    const s2 = sheet();
    placeSide(text, s2.querySelector('.desk-main'), s2.querySelector('.desk-aside'));
    const kl = s2.querySelector('.desk-main > .desk-keyline');
    if (kl) s2.querySelector('.desk-main').append(kl);
  }).catch(() => {});
  void title;
}

/**
 * A load of /approvals or /discussions/:id on a wide window (a reload, a link from elsewhere, typed): the canonical page,
 * mounted into the panes, however the URL was reached.
 */
async function mountFromPage() {
  if (!besideOn()) return;
  const kind = sheetKind(location.href, location.href);
  if (kind !== 'approval' && kind !== 'discussion') return;
  const root = document.querySelector('main > .approvals, main > .discussion');
  if (!root) return;
  history.replaceState({ desk: { kind, place: 'projects' } }, '');
  const gen = ++sheetGen;
  let list, side;
  try {
    [list, side] = await Promise.all([listPartial(undefined), fetchSide(sideUrl(kind, location.href, location.href, kind === 'approval' ? shownApprovalId(root, location.href) : undefined), undefined)]);
  } catch { return; }
  if (gen !== sheetGen) return;
  const plist = listNode(list);
  const mainEl = root.parentElement;
  if (!plist || !mainEl) return;
  openDeskFolds(plist);
  addOverview(plist);
  const crumb = crumbTitle(kind, document, root);
  const f = el('div', { class: 'phome wide has-panel desk-mounted desk-panes', 'data-place': 'projects' }, plist, buildSheet());
  mainEl.replaceChildren(f);
  applyNolist(f);
  const title = fillSheet(kind, root, side, crumb, location.href);
  touched = true;
  shownKey = pathKey(location.href);
  settle(kind, location.href, title, 'keep');
}

/**
 * After a post (a tick, an approval, a decision, a state change) the kept overview is out of date: it would show
 * answered suggestions with their live forms. Dropping it makes the way back load / from the server.
 */
function forgetHome() {
  homeNode = null;
}

/** Back to the overview, focus on the row the sheet came from: the kept one at once, or / loaded fresh. */
function restoreOverview(returnHref, opts = {}) {
  ++sheetGen;
  openAbort?.abort();
  const f = frame();
  const place = framePlace() ?? 'projects';
  const url = overviewOf(place);
  if (homeNode && f) {
    const home = homeNode;
    homeNode = null;
    f.replaceWith(home);
    if (!opts.fromPop) history.pushState({ desk: { kind: 'overview', place } }, '', url);
    shownKey = pathKey(url);
    (hooks.restored[place] ?? focusReturn)(home, returnHref);
    return;
  }
  try { sessionStorage.setItem('desk.return', returnHref ?? ''); } catch { /* storage off */ }
  location.assign(url);
}
function focusReturn(home, href) {
  if (!href) return;
  const key = pathKey(href);
  const kind = sheetKind(href, location.href);
  const links = [...home.querySelectorAll('a[href]')].filter((a) => a.getClientRects().length > 0 && sameSheet(a.href, key, kind));
  let t = links.find((a) => a.closest('.pcards')) ?? links[0];
  if (!t && kind === 'approval') t = home.querySelector('details.fy-approval > summary');
  if (!t && kind === 'notyet') t = home.querySelector('#notyet > summary');
  t?.focus();
}

/** On the home after an adopted sheet's Esc (or n): the row it came from, or the idea field. */
function homeArrival() {
  if (!document.querySelector('main > .phome:not(.has-panel)')) return;
  let back = null, focus = null;
  try {
    back = sessionStorage.getItem('desk.return'); sessionStorage.removeItem('desk.return');
    focus = sessionStorage.getItem('desk.focus'); sessionStorage.removeItem('desk.focus');
  } catch { /* storage off */ }
  if (focus === 'idea') { document.getElementById('idea-text')?.focus(); return; }
  if (back) focusReturn(document.querySelector('main > .phome'), back);
}

function stepList(dir) {
  const own = placeOf(framePlace())?.step;
  if (own) { own(dir); return; }
  const rows = listRows();
  if (rows.length === 0) return;
  const selected = rows.findIndex((r) => r.getAttribute('aria-current') === 'true' || r.classList.contains('is-selected'));
  const at = stepStart(rows.indexOf(document.activeElement), selected);
  const next = rows[stepIndex(at, dir, rows.length)];
  if (!next || next === rows[at]) return;
  next.focus();
  const href = rowHref(next);
  if (besideOn()) openInSheet(href, { focus: 'keep' }); else location.assign(href);
}

/** On the overview, a click on an Everything else fold opens the list with that fold open and its first project. */
function foldFromOverview(summary, e) {
  if (screen() !== 'overview') return false;
  const fold = summary.parentElement;
  // Only the extras' folds (the area fold lines open in place, spec 2026-11-11).
  if (!fold || !fold.matches('.pextra details.fold') || fold.id === 'notyet') return false;
  const first = fold.querySelector('.fold-list a.row[href]');
  if (!first || !sheetKind(first.href, location.href)) return false;
  e.preventDefault();
  const at = [...document.querySelectorAll('main > .phome .pfolds details')].indexOf(fold);
  mountPanes('project', first.href, { openFold: at });
  return true;
}

function ideaFromPanes() {
  if (homeNode) {
    restoreOverview(null);
    document.getElementById('idea-text')?.focus();
    return;
  }
  try { sessionStorage.setItem('desk.focus', 'idea'); } catch { /* storage off */ }
  location.assign('/');
}

function onClick(e) {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  const t = e.target instanceof Element ? e.target : null;
  if (!t) return;
  if (t.closest('a.desk-x, a.desk-overview')) { e.preventDefault(); restoreOverview(location.href); return; }
  if (!besideOn()) return;
  const a = t.closest('a[href]');
  if (a) {
    if (!(a.closest('.phome, .desk-panes, .desk-sheet') || factsOverview()?.contains(a)) || a.target || a.hasAttribute('download') || a.hasAttribute('data-desk-native')) return;
    // A #link to the page shown: the browser jumps inside the sheet; Back is onPop's same-path case.
    if (sameDocAnchor(a.href, shownKey ?? pathKey(location.href), location.href)) return;
    const kind = sheetKind(a.href, location.href);
    if (!kind) return;
    const place = sheetPlace(kind);
    const f = framePlace();
    // Another place's link is a plain navigation; the panes intercept only their own place's links.
    if (f ? f !== place : !placeOf(place)?.canMount()) return;
    e.preventDefault();
    openInSheet(a.href);
    return;
  }
  const summary = t.closest('summary');
  if (!summary) return;
  for (const h of hooks.clicks) if (h(summary, e)) return;
  foldFromOverview(summary, e);
}

function onPop(e) {
  const st = e.state?.desk;
  const kind = st?.kind;
  // An in-page anchor (the jump row, #notyet on the overview, a page's contents): same path, no state of ours.
  if (!kind && shownKey !== null && pathKey(location.href) === shownKey) return;
  // Back from a #link inside the sheet shown (a Settings section, a page's contents) to its own entry: nothing to load.
  if (kind && kind !== 'overview' && shownKey !== null && pathKey(location.href) === shownKey && frame()?.querySelector('.desk-sheet')) return;
  const place = st?.place ?? (kind === 'overview' ? 'projects' : kind ? sheetPlace(kind) : null);
  const f = framePlace();
  // A state of another place's frame: that place's page, loaded for real.
  if (kind && f && place !== f) { location.reload(); return; }
  if (kind && kind !== 'overview') { openInSheet(location.href, { push: false, focus: 'row' }); return; }
  if (kind === 'overview' && homeNode) { restoreOverview(shownKey, { fromPop: true }); return; }
  if (kind === 'overview' && !f && pathKey(location.href) === pathKey(overviewOf(place))) { shownKey = pathKey(location.href); return; }
  // A reload: replacing the location with the same URL and a #fragment (#panel, #notyet) would only jump.
  location.reload();
}

hooks.actions.push((action, e) => {
  const scr = screen();
  if (action === 'esc' && scr === 'panes') {
    for (const h of hooks.esc) if (h()) { e.preventDefault(); return true; }
    if (!frame()?.querySelector('.desk-sheet') || framePlace() === 'settings') return false;
    e.preventDefault();
    restoreOverview(location.href);
    return true;
  }
  if (action === 'hide-list') { e.preventDefault(); toggleList(); return true; }
  if ((action === 'down' || action === 'up') && scr === 'panes') { e.preventDefault(); stepList(action === 'down' ? 1 : -1); return true; }
  if (action === 'down' && scr === 'overview') {
    const a = document.querySelector('main > .phome .pcards a.pcard[href]') ?? document.querySelector('main > .phome .prows a.row[href]');
    if (!a) return false;
    e.preventDefault();
    if (besideOn()) openInSheet(a.href); else location.assign(a.href);
    return true;
  }
  if (action === 'idea' && scr === 'panes') { e.preventDefault(); ideaFromPanes(); return true; }
  return false;
});

setups.push((signal) => {
  shownKey = pathKey(location.href);
  document.addEventListener('click', onClick, { signal });
  window.addEventListener('popstate', onPop, { signal });
  // A click in the sheet means reading it: from then on ↑ ↓ scroll the sheet, until desk.js opens another.
  document.addEventListener('pointerdown', (e) => { if (e.target instanceof Element && e.target.closest('.desk-sheet')) landing = null; }, { signal, capture: true });
  adoptPanes();
  mountFromPage();
  homeArrival();
});

// ---- Forms in the sheet: posts in place, one at a time, the list fresh after each; ticks with Undo; Manage ----

/** One POST in flight for the whole sheet: a second submit meanwhile is dropped, never queued. */
let posting = false;
let toast = null, toastTimer = 0, toastUndo = null;
const TICK = /\/projects\/[^/]+\/waiting\/\d+\/done$/;

/** The list again from the server (after any post): same scroll, same open folds, the selection marked. */
async function refreshList() {
  const f = frame();
  if (f && hooks.refresh[f.dataset.place]) return hooks.refresh[f.dataset.place]();
  const old = f?.querySelector(':scope > .plist');
  if (!old) return;
  let text;
  try { text = await listPartial(undefined, true); } catch { return; }
  const cur = frame()?.querySelector(':scope > .plist');
  if (!cur) return;
  const fresh = listNode(text);
  if (!fresh) return;
  // By name, not by position: a post can add or remove a fold (a project leaves Quiet), and the rest would shift.
  const keyOf = (d) => foldKey(d.querySelector(':scope > summary')?.textContent ?? '', d.id);
  const open = new Map([...cur.querySelectorAll('details')].map((d) => [keyOf(d), d.open]));
  const top = cur.scrollTop;
  for (const d of fresh.querySelectorAll('details')) if (open.get(keyOf(d))) d.open = true;
  openDeskFolds(fresh);
  addOverview(fresh);
  cur.replaceWith(fresh);
  fresh.scrollTop = top;
  labelList();
  markSelected(location.href);
}

/** The sidebar's Inbox place (its count of what waits for the owner) as the response page draws it. */
function sidebarFrom(doc) {
  const mine = document.querySelector('nav.side a.side-place[href="/approvals"]');
  const theirs = doc?.querySelector('nav.side a.side-place[href="/approvals"]');
  if (mine && theirs) mine.replaceChildren(...[...theirs.childNodes].map((n) => document.importNode(n, true)));
}

function hideToast() {
  clearTimeout(toastTimer);
  toast?.remove();
  toast = null;
  toastUndo = null;
}
function showToast(text, undo) {
  hideToast();
  const button = undo ? el('button', { type: 'button', text: 'Undo' }) : null;
  toast = add(el('div', { class: 'desk-toast', role: 'status' }, el('span', { text: toastText(text) }), button, button && prefs().keys ? el('kbd', { text: 'z' }) : null));
  toastUndo = undo;
  button?.addEventListener('click', () => runUndo());
  document.body.append(toast);
  const arm = () => {
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { if (toast && toast.contains(document.activeElement)) arm(); else hideToast(); }, 5000);
  };
  arm();
}
let undoing = false;
function runUndo() {
  const form = toastUndo;
  hideToast();
  if (!form || !form.isConnected) return;
  undoing = true;
  form.requestSubmit();
}
hooks.toastOpen = () => toast !== null;

function submitButtons() {
  return [...document.querySelectorAll('.desk-sheet button, .phome.has-panel > .plist button')].filter((b) => b.type === 'submit' && !b.disabled);
}

async function onSubmit(e) {
  const form = e.target;
  if (!(form instanceof HTMLFormElement) || !form.matches('.desk-panes > .desk-list form, .phome.has-panel > .plist form, .desk-sheet form')) return;
  if (!besideOn() || form.hasAttribute('data-desk-native')) return;
  // Only the sheets whose posts answer with a sheet (Settings and anything else post natively); in the list, Projects'.
  if (form.closest('.desk-sheet') ? !postScope(sheet()?.dataset.kind) : framePlace() !== 'projects') return;
  const req = requestFor(form, e.submitter ?? null);
  if (req.method !== 'post') return;
  // The body first: disabled buttons (and the submitter's name and value) would be left out after.
  const body = new URLSearchParams(new FormData(form, e.submitter ?? null));
  e.preventDefault();
  const fromUndo = undoing;
  undoing = false;
  if (posting) return;
  posting = true;
  forgetHome();
  const gen = sheetGen;
  const kindBefore = sheet()?.dataset.kind ?? null;
  const tick = TICK.test(new URL(req.url, location.href).pathname) ? (form.querySelector('input[name="text"]')?.value ?? '') : null;
  const checks = () => [...document.querySelectorAll('.desk-sheet button.check')];
  const at = checks().indexOf(e.submitter ?? document.activeElement);
  const disabled = submitButtons();
  for (const b of disabled) { b.disabled = true; b.setAttribute('aria-busy', 'true'); }
  try {
    let res, doc;
    try {
      res = await fetch(req.url, { method: 'POST', body, headers: { Accept: 'text/html' }, credentials: 'same-origin', redirect: 'follow' });
      doc = new DOMParser().parseFromString(await res.text(), 'text/html');
    } catch {
      // Never sent again: the server may have acted before the connection dropped. Show what it holds now.
      if (gen === sheetGen) failLine(location.href);
      refreshList();
      return;
    }
    if (gen !== sheetGen) { refreshList(); sidebarFrom(doc); return; }
    for (const h of hooks.posted) if (h(form, res, doc)) { refreshList(); sidebarFrom(doc); return; }
    const out = postOutcome(res, location.href, framePlace() ?? 'projects');
    if (out.do === 'go') { location.assign(out.url); return; }
    const root = rootOf(doc);
    if (out.do === 'swap') {
      ++sheetGen;
      const kind = sheetKind(out.url, location.href);
      if (!root) { failLine(location.href); }
      else {
        const title = fillSheet(kind, root, null, crumbTitle(kind, doc, root), out.url);
        const href = kind === 'project' ? `${out.url.split('#')[0]}#panel` : out.url;
        setHistory(historyMode(location.href, href) === 'push', kind, href);
        markSelected(href);
        if (kindBefore !== kind || title) liveSay(`Opened ${title}`);
        const g2 = sheetGen;
        const side = sideUrl(kind, href, location.href, kind === 'approval' ? shownApprovalId(root, href) : undefined);
        fetchSide(side, undefined).then((text) => {
          if (g2 !== sheetGen || !text) return;
          const s2 = sheet();
          placeSide(text, s2.querySelector('.desk-main'), s2.querySelector('.desk-aside'));
          const kl = s2.querySelector('.desk-main > .desk-keyline');
          if (kl) s2.querySelector('.desk-main').append(kl);
          for (const h of hooks.sided) h(kind);
        }).catch(() => {});
        for (const h of hooks.swapped) h(kind, root);
      }
    } else if (root) {
      fillSheet(kindBefore ?? sheetKind(location.href, location.href) ?? 'project', root, null, crumbTitle(kindBefore ?? 'project', doc, root), location.href);
    } else {
      failLine(location.href);
    }
    refreshList();
    sidebarFrom(doc);
    const now = checks();
    if (at >= 0 && now[Math.min(at, now.length - 1)]) now[Math.min(at, now.length - 1)].focus({ preventScroll: true });
    else if (document.activeElement === document.body || !document.activeElement?.isConnected) focusSheet(sheet()?.dataset.kind);
    if (tick !== null && !fromUndo) {
      const undos = [...document.querySelectorAll('.desk-sheet ul.checks.done form[action$="/undo"]')];
      const last = undos[undos.length - 1];
      const v = last?.querySelector('input[name="text"]')?.value ?? '';
      showToast(tick, last && (v === tick || v.startsWith(`${tick} (by `)) ? last : null);
    }
  } finally {
    posting = false;
    for (const b of disabled) if (b.isConnected) { b.disabled = false; b.removeAttribute('aria-busy'); }
  }
}

/** Manage, the project's state and details, moves into the bar as a menu (design §4.2): not one click from a change. */
function manageMenu(kind, node, s) {
  if (kind !== 'project') return;
  const manage = node.querySelector(':scope > details.manage');
  if (!manage) return;
  const summary = manage.querySelector(':scope > summary');
  const menu = el('div', { class: 'desk-menu' });
  for (const n of [...manage.childNodes]) if (n !== summary) menu.append(n);
  manage.append(menu);
  manage.open = false;
  s.querySelector('.desk-acts').prepend(manage);
}
function openMenu() {
  return document.querySelector('.desk-acts > details.manage[open]');
}
function closeMenu() {
  const m = openMenu();
  if (!m) return false;
  m.open = false;
  m.querySelector(':scope > summary')?.focus();
  return true;
}
hooks.filled.push(manageMenu);
hooks.esc.push(closeMenu);
hooks.esc.push(() => { if (!toast) return false; hideToast(); return true; });

hooks.actions.push((action, e) => {
  if (action === 'tick') {
    const a = document.activeElement;
    // In a sheet it posts by fetch with the Undo toast; on Week it posts natively (no toast: Week has no Undo form).
    if (a && a.matches('.desk-sheet button.check, main > .review button.check')) { e.preventDefault(); a.click(); return true; }
    return false;
  }
  if (action === 'undo' && toast) { e.preventDefault(); runUndo(); return true; }
  return false;
});

setups.push((signal) => {
  document.addEventListener('submit', onSubmit, { signal, capture: true });
  document.addEventListener('click', (e) => {
    const m = openMenu();
    if (m && e.target instanceof Node && !m.contains(e.target)) m.open = false;
  }, { signal, capture: true });
});

// ---- Not in the brain yet in the sheet (design §4.1, §4.2): its rows and forms, /#notyet, and its posts ----

/** The sheet's copy of a #notyet fold: a heading, then the fold's own content (not its summary). */
function notyetSheet(from) {
  const fold = from && (from.id === 'notyet' ? from : from.querySelector('#notyet'));
  if (!fold) return null;
  const box = el('div', { class: 'desk-notyet' }, el('h1', { tabindex: '-1', text: 'Not in the brain yet' }));
  for (const n of fold.children) if (n.tagName !== 'SUMMARY') box.append(document.importNode(n, true));
  return box;
}

/** Shows the list pane's own Not in the brain yet in the sheet (the list is fetched fresh after each post). */
function showNotyet(push, focus) {
  const fold = frame()?.querySelector(':scope > .plist #notyet');
  const node = notyetSheet(fold);
  if (!node) { location.assign('/'); return; }
  fold.open = false;
  ++sheetGen;
  const title = fillSheet('notyet', node, null, '');
  setHistory(push, 'notyet', '/#notyet');
  settle('notyet', '/#notyet', title, focus);
}

hooks.open.push((kind, url, opts) => {
  if (kind !== 'notyet') return null;
  if (!frame()) return mountPanes('notyet', url, opts) ?? true;
  showNotyet(opts.push !== false, opts.focus ?? 'heading');
  return true;
});
hooks.mountNotyet = (opts) => showNotyet(opts.push !== false, opts.focus ?? 'heading');

hooks.clicks.push((summary, e) => {
  if (!summary.parentElement?.matches('#notyet')) return false;
  if (!summary.closest('main > .phome')) return false;
  e.preventDefault();
  openInSheet('/#notyet');
  return true;
});

/** Ignore and Undo answer with / (the fragment is not in a fetch's URL): the sheet reads #notyet from that page. */
hooks.posted.push((form, res, doc) => {
  if (!form.closest('.desk-notyet')) return false;
  if (res.redirected && pathKey(res.url) !== '/') return false; // Add as project: the usual swap to the project
  const node = notyetSheet(doc);
  if (!node) { location.assign('/'); return true; }
  const err = doc.querySelector('.plist > .error');
  if (err) node.querySelector('h1').after(document.importNode(err, true));
  ++sheetGen;
  fillSheet('notyet', node, null, '');
  history.replaceState({ desk: { kind: 'notyet' } }, '', '/#notyet');
  focusSheet('notyet');
  return true;
});

/** A fresh load of /#notyet on the desktop opens the sheet (app.js opened the fold in place; it closes again). */
function notyetArrival() {
  if (!besideOn() || location.hash !== '#notyet' || location.search !== '' || location.pathname !== '/' || screen() !== 'overview') return;
  const fold = document.querySelector('main > .phome #notyet');
  if (!fold) return;
  fold.open = false;
  mountPanes('notyet', location.href, { push: false });
}
setups.push(() => notyetArrival());

// ---- For you in the sheet: the approval (design §4.3) ----

hooks.clicks.push((summary, e) => {
  if (!summary.parentElement?.matches('details.fy-approval') || !summary.closest('main > .phome')) return false;
  e.preventDefault();
  openInSheet('/approvals');
  return true;
});

/** After approve or reject the sheet shows /approvals again; with nothing left it moves on to what waits next. */
hooks.swapped.push((kind, root) => {
  if (kind !== 'approval' || root.querySelector('.approval-card')) return;
  const gen = sheetGen;
  fetchSide('/approvals?pane=side', undefined).then((text) => {
    if (gen !== sheetGen) return;
    const next = text ? new DOMParser().parseFromString(text, 'text/html').querySelector('.desk-next a[href]') : null;
    if (next) openInSheet(new URL(next.getAttribute('href'), location.href).href, { push: false });
    else if (homeNode) restoreOverview(null);
    else location.assign('/');
  }).catch(() => {});
});

hooks.actions.push((action, e) => {
  const s = sheet();
  if (action === 'edit') {
    if (s?.dataset.kind !== 'approval') return false;
    const edit = s.querySelector('.approval-card details.edit-first');
    const area = edit?.closest('form')?.querySelector('textarea[name="content"]');
    if (!edit || !area) return false;
    e.preventDefault();
    edit.open = true;
    area.focus();
    area.setSelectionRange(area.value.length, area.value.length);
    return true;
  }
  if (action === 'submit') {
    // keyAction gave submit only with focus in a text field of an allowlisted form in the sheet: its first plain submit
    // (Approve, Save decision), never a formaction button (Reject).
    const form = document.activeElement?.form;
    if (!form || !form.closest('.desk-sheet') || !cmdEnterForm(form.getAttribute('action') ?? '')) return false;
    const primary = form.querySelector('button[type="submit"]:not([formaction]), button:not([type]):not([formaction])');
    if (!primary) return false;
    e.preventDefault();
    form.requestSubmit(primary);
    return true;
  }
  return false;
});

// ---- Pages (design §4.5): .pnav as the list pane, the page in the sheet with its rail, scroll-spy ----

/** After a sheet shows a URL with a #fragment: that part at the top of the sheet. */
/**
 * The id a sheet's address asks it to scroll to, or null. #panel (a project's own wrapper) and #notyet only say which
 * sheet is open: scrolling to them put the heading under the sticky crumb bar, so the sheet stays at its top.
 */
export function sheetScrollId(href, base = 'http://localhost/') {
  let hash = '';
  try { hash = new URL(href, base).hash; } catch { return null; }
  if (hash.length < 2) return null;
  let id = hash.slice(1);
  try { id = decodeURIComponent(id); } catch { /* as is */ }
  return id === 'panel' || id === 'notyet' ? null : id;
}

function scrollToHash(href) {
  const id = sheetScrollId(href, location.href);
  const t = id ? document.getElementById(id) : null;
  if (t && sheet()?.contains(t)) t.scrollIntoView({ block: 'start' });
}

/** The page's crumb (area, project, title) from its own p.crumb and h1, led by the area's ring from the list. */
function pageCrumbOf(node) {
  const crumb = node.querySelector('.pmain > p.crumb');
  const parts = (crumb?.textContent ?? '').split('›').map((x) => x.trim()).filter(Boolean);
  const title = node.querySelector('.pmain > h1')?.textContent.trim() ?? '';
  const area = parts[0] ?? 'Pages';
  const h2 = [...(listPane()?.querySelectorAll(':scope > h2, :scope > details > summary') ?? [])].find((h) => h.textContent.replace(/\d+/g, '').trim() === area);
  const ring = h2?.querySelector('.ring')?.cloneNode(true) ?? null;
  return { parts: pageCrumb(area, parts[1] ?? null, title), ring };
}

/**
 * The page in the sheet: its article (.pmain) in the main column, its rail (.paside) in the side column, the live box
 * moved into the rail after Ask an AI, and the contents lists replaced by copies (app.js watches the page's own, now
 * detached; the spy here is the only one).
 */
function placePage(node, main, aside) {
  const pmain = node.querySelector(':scope > .pmain');
  const paside = node.querySelector(':scope > aside.paside');
  if (!pmain) { main.append(node); return; }
  pmain.querySelector(':scope > p.crumb')?.remove();
  const live = pmain.querySelector(':scope > section.live-full');
  const sticky = paside?.querySelector(':scope > .sticky');
  if (live && sticky) {
    const ask = sticky.querySelector(':scope > #ask_ai');
    if (ask) ask.after(live); else sticky.append(live);
  }
  for (const t of [...pmain.querySelectorAll('.toc'), ...(paside ? paside.querySelectorAll('.toc') : [])]) t.replaceWith(t.cloneNode(true));
  main.append(pmain);
  if (paside) aside.append(paside);
}

/** The bar's narrow actions (shown under 820 px of sheet): Ask an AI to update, then Edit, the one black pill. */
function pageBar(kind, node, s) {
  s.querySelector('.desk-acts > .desk-narrow')?.remove();
  if (kind !== 'page') return;
  const edit = s.querySelector('.desk-aside .paside > .sticky > a.button.primary');
  const ask = s.querySelector('.desk-aside details#ask_ai') ? el('button', { type: 'button', class: 'desk-ask', text: 'Ask an AI to update' }) : null;
  ask?.addEventListener('click', () => askAI());
  const pill = edit ? el('a', { class: 'button primary', href: edit.getAttribute('href'), text: 'Edit' }) : null;
  if (edit && prefs().keys && !edit.querySelector('kbd')) {
    edit.setAttribute('aria-keyshortcuts', 'E');
    edit.append(el('kbd', { 'aria-hidden': 'true', text: 'E' }));
  }
  if (!ask && !pill) return;
  s.querySelector('.desk-acts').prepend(el('span', { class: 'desk-narrow' }, ask, pill));
  requestAnimationFrame(() => spySheet());
}
hooks.filled.push(pageBar);
// A page brought into the sheet arrives after app.js looked for diagrams: draw them here (round 2 section 12).
hooks.filled.push((_kind, node) => {
  for (const holder of node.querySelectorAll('[data-diagrams]')) {
    try { import(holder.dataset.diagrams).then((m) => m.setUpDiagrams(holder), () => {}); } catch { /* no module loader */ }
  }
});

/** Opens the rail's own Ask an AI note, in view inside the sheet, its text field focused (nothing is fetched). */
function askAI() {
  const d = sheet()?.querySelector('details#ask_ai');
  if (!d) return;
  d.open = true;
  const ta = d.querySelector('textarea');
  (ta ?? d).scrollIntoView({ block: 'nearest' });
  ta?.focus({ preventScroll: true });
}

/** Scroll-spy: the rail's contents link of the section at the top of the sheet carries aria-current. */
function spySheet() {
  const s = sheet();
  if (!s || s.dataset.kind !== 'page') return;
  const links = [...s.querySelectorAll('.desk-aside .toc a[href^="#"]')];
  const top = s.getBoundingClientRect().top;
  const tops = links.map((a) => {
    let id = a.getAttribute('href').slice(1);
    try { id = decodeURIComponent(id); } catch { /* as is */ }
    const t = document.getElementById(id);
    return t && s.contains(t) ? t.getBoundingClientRect().top - top : Number.POSITIVE_INFINITY;
  });
  // At the foot of the sheet a section that cannot reach the top is read there: the one a contents link just jumped
  // to (the #hash), while it is in view, else the last.
  const atEnd = s.scrollTop > 0 && s.scrollTop + s.clientHeight >= s.scrollHeight - 2;
  const jumped = links.findIndex((a) => a.getAttribute('href') === location.hash);
  const at = !atEnd ? spyIndex(tops, 80) : jumped >= 0 && tops[jumped] < s.clientHeight ? jumped : links.length - 1;
  links.forEach((a, i) => { if (i === at) a.setAttribute('aria-current', 'true'); else a.removeAttribute('aria-current'); });
}
function watchSpy(s, signal) {
  let queued = false;
  s.addEventListener('scroll', () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; spySheet(); });
  }, { passive: true, signal });
}

/** Pages: the tree link of the page shown carries aria-current="page" (a white row), its fold opened. */
function markPage(href) {
  const pn = listPane();
  if (!pn) return;
  const key = pathKey(href);
  let row = null;
  for (const a of pn.querySelectorAll('a[aria-current]')) a.removeAttribute('aria-current');
  for (const a of pn.querySelectorAll(':scope > ul a[href], :scope > details a[href]')) if (!row && pathKey(a.href) === key) row = a;
  if (!row) return;
  row.setAttribute('aria-current', 'page');
  for (let d = row.parentElement?.closest('details'); d; d = d.parentElement?.closest('details')) if (!d.open) d.open = true;
  row.scrollIntoView({ block: 'nearest' });
}

/** The list's header (Pages, the count, New page) and each area's count. */
function pnavHeader(pn) {
  const n = pn.querySelectorAll(':scope > ul a[href], :scope > details a[href]').length;
  pn.prepend(el('div', { class: 'desk-list-h' }, el('h1', {}, 'Pages', el('span', { class: 'n', text: String(n) })), el('a', { href: '/pages/new', text: 'New page' })));
  for (const h2 of pn.querySelectorAll(':scope > h2')) {
    const ul = h2.nextElementSibling;
    if (ul && ul.tagName === 'UL') h2.append(el('span', { class: 'n', text: String(ul.querySelectorAll('a[href]').length) }));
  }
}

/** The two closed folds at the foot of /pages (May be out of date, Projects without a page), fetched once per page. */
let pagesFoot = null;
async function liftFoot(pn) {
  try {
    if (pagesFoot === null) {
      const r = await fetch('/pages', { headers: { Accept: 'text/html' }, credentials: 'same-origin' });
      if (!r.ok || r.redirected) return;
      pagesFoot = await r.text();
    }
    const ul = new DOMParser().parseFromString(pagesFoot, 'text/html').querySelector('main ul.nopage-group');
    if (!ul || !pn.isConnected || pn.querySelector(':scope > .nopage-group')) return;
    pn.append(document.importNode(ul, true));
  } catch { /* offline: the list has no foot folds */ }
}

/** A load of /pages/:id on a wide window with beside on: the panes, the page's own nodes moved in (nothing fetched). */
function mountPage(signal) {
  if (!besideOn() || sheetKind(location.href, location.href) !== 'page') return;
  const wrap = document.querySelector('main > .pages-wrap.on-page.with-aside');
  const pn = wrap?.querySelector(':scope > nav.pnav');
  if (!wrap || !pn) return;
  history.replaceState({ desk: { kind: 'page', place: 'pages' } }, '');
  pn.classList.add('desk-list');
  pnavHeader(pn);
  const s = buildSheet('pages');
  const f = el('div', { class: 'desk-panes', 'data-place': 'pages' }, pn, s);
  wrap.replaceWith(f);
  applyNolist(f);
  watchSpy(s, signal);
  fillSheet('page', wrap, null, '', location.href);
  touched = true;
  shownKey = pathKey(location.href);
  markSelected(location.href);
  scrollToHash(location.href);
  requestAnimationFrame(() => spySheet());
  liftFoot(pn);
}

/** On a list overview (/pages, /facts) after Esc from its sheet: focus on the row of what was open. */
function listArrival() {
  const place = placeOfPath(location.pathname);
  if (frame() || (place !== 'pages' && place !== 'facts')) return;
  let back = null;
  try {
    back = sessionStorage.getItem('desk.return'); sessionStorage.removeItem('desk.return');
    // Back from the panes' first page: the page it left, if that was just now and in this place.
    const left = JSON.parse(sessionStorage.getItem('desk.left') ?? 'null'); sessionStorage.removeItem('desk.left');
    if (!back && left && Date.now() - left.at < 10000 && placeOfPath(new URL(left.href, location.href).pathname) === place) back = left.href;
  } catch { /* storage off */ }
  if (!back) return;
  // A fact's links differ by their `from`: its path is enough.
  const key = place === 'facts' ? new URL(back, location.href).pathname : pathKey(back);
  const a = [...document.querySelectorAll('main a[href]')].find((x) => x.getClientRects().length > 0 && (place === 'facts' ? new URL(x.href).pathname : pathKey(x.href)) === key);
  a?.focus();
}

PLACE.pages = {
  overview: () => '/pages',
  rows: () => [...(listPane()?.querySelectorAll(':scope > ul a[href], :scope > details[open] a[href]') ?? [])].filter((a) => a.getClientRects().length > 0),
  mark: (href) => markPage(href),
  canMount: () => false,
  mount: null,
};
hooks.refresh.pages = () => markSelected(location.href);

hooks.actions.push((action, e) => {
  if (action !== 'edit') return false;
  const s = sheet();
  if (s?.dataset.kind !== 'page') return false;
  const edit = s.querySelector('.desk-aside .paside > .sticky > a.button.primary');
  if (!edit) return false;
  e.preventDefault();
  edit.click();
  return true;
});

setups.push((signal) => {
  mountPage(signal);
  listArrival();
  window.addEventListener('pagehide', () => {
    const place = framePlace();
    if (place !== 'pages' && place !== 'facts') return;
    try { sessionStorage.setItem('desk.left', JSON.stringify({ href: location.href, at: Date.now() })); } catch { /* storage off */ }
  }, { signal });
  window.addEventListener('pageshow', (e) => { if (e.persisted) listArrival(); }, { signal });
});

// ---- Facts (design §4.6): the /facts list as the list pane, a fact in the sheet, Near it, Delete… always asks ----

/** /facts (any filter) with no panes yet: its own list becomes the list pane when a fact opens. */
function factsOverview() {
  return !document.querySelector('main > .desk-panes') && location.pathname === '/facts' ? document.querySelector('main > .narrow:has(> ul.cards.list), main > .narrow:has(> section.fgroup), main > .narrow:has(> p.empty)') : null;
}

/** A fact's side column: This decision over time, Where it shows (Near it comes from the side fragment). */
function splitFact(node, aside) {
  const h = node.querySelector(':scope > h3:has(+ ol.chain)');
  const chain = node.querySelector(':scope > ol.chain');
  const where = node.querySelector(':scope > section.where');
  if (h && chain) aside.append(el('section', { class: 'desk-chain' }, h, chain));
  if (where) aside.append(where);
}

/** The fact sheet's bar: Edit (an outlined pill, e) and Delete… (always asks); none for a deleted fact. */
function factBar(kind, node, s) {
  for (const b of s.querySelectorAll('.desk-acts > :is(.desk-edit, .desk-delete)')) b.remove();
  if (kind !== 'fact' || !node.querySelector('#edit')) return;
  const edit = el('button', { type: 'button', class: 'desk-edit', 'aria-keyshortcuts': prefs().keys ? 'E' : null }, 'Edit', prefs().keys ? el('kbd', { 'aria-hidden': 'true', text: 'E' }) : null);
  edit.addEventListener('click', () => openEdit());
  const del = node.querySelector('#edit form.danger') ? el('button', { type: 'button', class: 'desk-delete', 'aria-haspopup': 'dialog', text: 'Delete…' }) : null;
  del?.addEventListener('click', () => confirmDelete(del));
  s.querySelector('.desk-acts').prepend(...[edit, del].filter(Boolean));
}
hooks.filled.push(factBar);

/** The Edit fold open, its text focused with the caret at the end: what E and the Edit button do. */
export function openEditFold(d) {
  const ta = d?.querySelector('textarea');
  if (!d || !ta) return false;
  d.open = true;
  ta.scrollIntoView({ block: 'nearest' });
  ta.focus({ preventScroll: true });
  ta.setSelectionRange(ta.value.length, ta.value.length);
  return true;
}

/** e, or Edit: the fact's Edit fold open, its text focused with the caret at the end. */
function openEdit() {
  return openEditFold(sheet()?.querySelector('details#edit'));
}

/** Delete… asks first; only its Delete posts the fact's own delete form. */
let confirmDialog = null;
function confirmDelete(from) {
  if (!confirmDialog) {
    const yes = el('button', { type: 'button', class: 'danger', text: 'Delete' });
    const no = el('button', { type: 'button', class: 'secondary', autofocus: true, text: 'Cancel' });
    confirmDialog = add(el('dialog', { class: 'desk-confirm', 'aria-labelledby': 'desk-confirm-h' },
      el('h2', { id: 'desk-confirm-h', text: 'Delete this fact?' }),
      el('p', { text: 'It leaves search for you and your assistants. Assistants that try to save it again will ask you first. You can bring it back from its History.' }),
      el('div', { class: 'actions' }, no, yes)));
    no.addEventListener('click', () => confirmDialog.close());
    yes.addEventListener('click', () => {
      confirmDialog.close();
      sheet()?.querySelector('#edit form.danger')?.requestSubmit();
    });
    confirmDialog.addEventListener('close', () => { if (confirmDialog.returnFocus?.isConnected) confirmDialog.returnFocus.focus(); });
    document.body.append(confirmDialog);
  }
  confirmDialog.returnFocus = from;
  confirmDialog.showModal();
}

/** Facts: the white row on the fact shown (by path: a link's `from` may differ). */
function markFact(href) {
  const pn = listPane();
  if (!pn) return;
  for (const r of pn.querySelectorAll('.is-selected')) { r.classList.remove('is-selected'); r.removeAttribute('aria-current'); }
  const want = new URL(href, location.href).pathname;
  const row = [...pn.querySelectorAll('a.card-link[href]')].find((a) => new URL(a.href).pathname === want);
  if (!row) return;
  row.classList.add('is-selected');
  row.setAttribute('aria-current', 'true');
  row.scrollIntoView({ block: 'nearest' });
}

/** The list pane from a Facts page: its own .narrow, a list pane now. */
function asFactsList(narrow) {
  narrow.classList.add('desk-list');
  openDeskFolds(narrow);
  return narrow;
}

/** From /facts: the page's own list becomes the list pane (kept for Esc), the fact is fetched into the sheet. */
async function mountFacts(kind, url, opts = {}) {
  const { push = true, focus = 'heading' } = opts;
  const narrow = factsOverview();
  if (!narrow) { location.assign(url); return; }
  const gen = ++sheetGen;
  openAbort?.abort();
  const ctl = openAbort = new AbortController();
  let got;
  try { got = await load(kind, url, gen, ctl.signal); } catch (e) { if (!isAbort(e) && gen === sheetGen) location.assign(url); return; }
  if (!got || gen !== sheetGen) return;
  if (!got.root) { location.assign(url); return; }
  const overview = pathKey(location.href);
  history.replaceState({ desk: { kind: 'overview', place: 'facts' } }, '');
  const s = buildSheet('facts');
  s.querySelector('.desk-x').setAttribute('href', overview);
  const f = el('div', { class: 'desk-panes', 'data-place': 'facts', 'data-overview': overview });
  narrow.replaceWith(f);
  f.append(asFactsList(narrow), s);
  homeNode = narrow;
  applyNolist(f);
  const title = fillSheet(kind, got.root, got.side, '', got.href);
  setHistory(push, kind, got.href);
  settle(kind, got.href, title, focus);
}

/** A load of /memories/:id with beside on: the panes, the list it came from fetched, the fact's own page in the sheet. */
async function mountFact() {
  if (!besideOn() || sheetKind(location.href, location.href) !== 'fact') return;
  const root = document.querySelector('main > .narrow:has(> h1.fact-text)');
  if (!root) return;
  history.replaceState({ desk: { kind: 'fact', place: 'facts' } }, '');
  const src = listSource('facts', location.href);
  const gen = ++sheetGen;
  let text = null, side = null;
  try {
    const sideP = fetchSide(sideUrl('fact', location.href, location.href), undefined);
    sideP.catch(() => {});
    const r = await fetch(src, { headers: { Accept: 'text/html' }, credentials: 'same-origin' });
    if (!r.ok || r.redirected) return;
    text = await r.text();
    side = await sideP;
  } catch { return; }
  if (gen !== sheetGen) return;
  const n = new DOMParser().parseFromString(text, 'text/html').querySelector('main > .narrow');
  const mainEl = root.parentElement;
  if (!n || !mainEl) return;
  const s = buildSheet('facts');
  s.querySelector('.desk-x').setAttribute('href', src);
  const f = el('div', { class: 'desk-panes', 'data-place': 'facts', 'data-overview': src }, asFactsList(document.importNode(n, true)), s);
  mainEl.replaceChildren(f);
  applyNolist(f);
  const title = fillSheet('fact', root, side, '', location.href);
  touched = true;
  shownKey = pathKey(location.href);
  settle('fact', location.href, title, 'keep');
}

/** After a post: the list fetched again, the same scroll, the filter as it was. */
async function refreshFacts() {
  const cur = listPane();
  const src = frame()?.dataset.overview;
  if (!cur || !src) return;
  let text;
  try {
    const r = await fetch(src, { headers: { Accept: 'text/html' }, credentials: 'same-origin' });
    if (!r.ok || r.redirected) return;
    text = await r.text();
  } catch { return; }
  const n = new DOMParser().parseFromString(text, 'text/html').querySelector('main > .narrow');
  const now = listPane();
  if (!n || now !== cur) return;
  const fresh = document.importNode(n, true);
  fresh.classList.add('desk-list');
  const was = cur.querySelector('details.filter-fold')?.open;
  const top = cur.scrollTop;
  const fold = fresh.querySelector('details.filter-fold');
  if (fold && was) fold.open = true;
  if (homeNode === cur) homeNode = fresh;
  cur.replaceWith(fresh);
  fresh.scrollTop = top;
  labelList();
  markSelected(location.href);
}

PLACE.facts = {
  overview: () => frame()?.dataset.overview || '/facts',
  rows: () => [...(listPane()?.querySelectorAll('a.card-link[href]') ?? [])].filter((a) => a.getClientRects().length > 0),
  mark: (href) => markFact(href),
  canMount: () => !!factsOverview(),
  mount: (kind, url, opts) => mountFacts(kind, url, opts),
};
hooks.refresh.facts = () => refreshFacts();
/** Back on /facts from the panes: the list is the page's again, focus on the fact's row. */
hooks.restored.facts = (home, href) => {
  home.classList.remove('desk-list');
  if (home.id === 'desk-list') home.removeAttribute('id');
  if (home.getAttribute('role') === 'region') { home.removeAttribute('role'); home.removeAttribute('aria-label'); }
  home.removeAttribute('tabindex');
  for (const r of home.querySelectorAll('.is-selected')) { r.classList.remove('is-selected'); r.removeAttribute('aria-current'); }
  if (!href) return;
  const want = new URL(href, location.href).pathname;
  [...home.querySelectorAll('a.card-link[href]')].find((a) => new URL(a.href).pathname === want)?.focus();
};

hooks.actions.push((action, e) => {
  if (action === 'filter') {
    const q = [...document.querySelectorAll('.desk-list input[name="q"], main > .narrow details.filter-fold input[name="q"], main > .narrow form.frow-filters input[name="q"]')].find((x) => x.getClientRects().length > 0);
    if (!q) return false;
    e.preventDefault();
    q.focus();
    q.select();
    return true;
  }
  if (action === 'edit' && sheet()?.dataset.kind === 'fact') {
    if (!openEdit()) return false;
    e.preventDefault();
    return true;
  }
  if (action === 'down' && factsOverview()) {
    const a = factsOverview().querySelector('a.card-link[href]');
    if (!a) return false;
    e.preventDefault();
    if (besideOn()) openInSheet(a.href); else location.assign(a.href);
    return true;
  }
  return false;
});
hooks.esc.push(() => { if (!confirmDialog?.open) return false; confirmDialog.close(); return true; });

setups.push(() => {
  // On /facts the filter is open on the desktop (DESK_FOLDS); tear-down closes it again.
  const narrow = factsOverview();
  if (narrow) openDeskFolds(narrow);
  mountFact();
});

// ---- Week (design §4.7): Decided capped at nine with its count, the decision peek, ← → ----

/** Decided on a week page: its fold open (DESK_FOLDS), its count, and "N more ›" when there are more than nine. */
function decidedCap() {
  const review = document.querySelector('main > .review');
  const ul = review?.querySelector(':scope > section.rv-sec ul.decisions');
  if (!ul) return;
  openDeskFolds(review);
  const n = ul.querySelectorAll('.row.decision').length;
  const h2 = ul.closest('section')?.querySelector('.panel-head h2');
  if (h2 && !h2.querySelector('.n')) h2.append(add(el('span', { class: 'n', text: String(n) })));
  const label = capLabel(n);
  if (!label || ul.parentElement.querySelector(':scope > .desk-more')) return;
  const more = add(el('button', { type: 'button', class: 'desk-more', text: label }));
  more.addEventListener('click', () => {
    ul.classList.add('desk-all');
    more.remove();
    ul.querySelector('details.more .fold-list > li:nth-child(7) a[href]')?.focus();
  });
  ul.after(more);
  restores.push(() => ul.classList.remove('desk-all'));
}

let peekDialog = null;
let peekRow = null;
let peekGen = 0;
/** Each decision's own link (not its "replaced on" link to the fact that holds now). */
const DECISION_LINK = 'main > .review .decisions .row.decision a[href^="/memories/"]:not(.replaced-on)';
const decisionLinks = () => [...document.querySelectorAll(DECISION_LINK)].filter((a) => a.getClientRects().length > 0);

function closePeek() {
  if (!peekDialog?.open) return false;
  peekDialog.close();
  for (const r of document.querySelectorAll('main > .review .row.decision.is-selected')) r.classList.remove('is-selected');
  if (peekRow?.isConnected) peekRow.focus({ preventScroll: true });
  return true;
}

/** A decision in a peek over the right side: its canonical page's fact (no Edit, History or picker), no history entry. */
async function openPeek(a) {
  if (!peekDialog) {
    const x = el('button', { type: 'button', class: 'desk-x', 'aria-label': 'Close (Esc)' }, svgX());
    x.addEventListener('click', () => closePeek());
    peekDialog = add(el('dialog', { class: 'desk-peek', 'aria-labelledby': 'desk-peek-crumb' },
      el('div', { class: 'desk-bar' }, el('nav', { class: 'desk-crumb', id: 'desk-peek-crumb', 'aria-label': 'Where you are' }), el('a', { class: 'desk-peek-open', text: 'Open in Facts' }), x),
      el('div', { class: 'desk-peek-body' })));
    document.body.append(peekDialog);
    restores.push(() => { for (const r of document.querySelectorAll('.row.decision.is-selected')) r.classList.remove('is-selected'); });
  }
  const gen = ++peekGen;
  peekRow = a;
  for (const r of document.querySelectorAll('main > .review .row.decision.is-selected')) r.classList.remove('is-selected');
  a.closest('.row.decision')?.classList.add('is-selected');
  const project = a.closest('.row.decision')?.querySelector('.pj')?.textContent.trim() || 'No project';
  const crumb = peekDialog.querySelector('.desk-crumb');
  crumb.replaceChildren(el('span', { text: 'Decided' }), el('span', { class: 'desk-sep', 'aria-hidden': 'true', text: '›' }), el('b', { text: project }));
  peekDialog.querySelector('.desk-peek-open').setAttribute('href', a.getAttribute('href'));
  const body = peekDialog.querySelector('.desk-peek-body');
  if (!peekDialog.open) peekDialog.show();
  let node = null;
  try {
    const r = await fetch(a.href, { headers: { Accept: 'text/html' }, credentials: 'same-origin' });
    if (r.ok && !r.redirected) node = new DOMParser().parseFromString(await r.text(), 'text/html').querySelector('main > .narrow');
  } catch { /* offline: the line below */ }
  if (gen !== peekGen || !peekDialog.open) return;
  const keys = prefs().keys ? el('p', { class: 'desk-keyline' },
    el('span', {}, el('kbd', { text: '↑' }), ' ', el('kbd', { text: '↓' }), ' next decision'), el('span', { class: 'desk-sep', text: ' · ' }), el('span', {}, el('kbd', { text: 'Esc' }), ' close')) : null;
  if (node) body.replaceChildren(document.importNode(node, true), ...(keys ? [keys] : []));
  else body.replaceChildren(el('p', { class: 'desk-fail' }, 'Couldn’t load this. ', el('a', { href: a.href.split('#')[0], text: 'Open it as its own page ›' })));
  const h = body.querySelector('h1.fact-text');
  if (h) { h.setAttribute('tabindex', '-1'); h.focus({ preventScroll: true }); } else peekDialog.focus();
  peekDialog.scrollTop = 0;
}

function stepPeek(dir) {
  const links = decisionLinks();
  if (links.length === 0) return;
  const at = links.indexOf(peekRow);
  const next = links[stepIndex(at, dir, links.length)];
  if (!next || next === peekRow) return;
  next.scrollIntoView({ block: 'nearest' });
  openPeek(next);
}

hooks.actions.push((action, e) => {
  if (screen() !== 'week') return false;
  if (action === 'esc' && closePeek()) { e.preventDefault(); return true; }
  if ((action === 'down' || action === 'up') && peekDialog?.open) { e.preventDefault(); stepPeek(action === 'down' ? 1 : -1); return true; }
  if (action === 'older' || action === 'newer') {
    const arrow = [...document.querySelectorAll('main .rv-head a.week-arrow')].find((x) => (action === 'older' ? x.textContent.trim().startsWith('‹') : x.textContent.trim().endsWith('›')));
    if (!arrow) return false;
    e.preventDefault();
    arrow.click();
    return true;
  }
  return false;
});

setups.push((signal) => {
  if (!document.querySelector('main > .review')) return;
  decidedCap();
  document.addEventListener('click', (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || !besideOn()) return;
    const a = e.target instanceof Element ? e.target.closest(DECISION_LINK) : null;
    if (!a) return;
    e.preventDefault();
    openPeek(a);
  }, { signal });
});

// ---- Settings (design §4.9): the index as the list pane following the scroll, every section in one centred sheet ----

/** The section at the top of the Settings sheet (or the one the hash names), marked in the index and the crumb. */
function settingsSpy(byHash = null) {
  const s = sheet();
  const pn = listPane();
  if (!s || !pn || s.dataset.kind !== 'settings') return;
  const sections = [...s.querySelectorAll('.desk-main > section[id]')];
  const top = s.getBoundingClientRect().top;
  const atEnd = s.scrollTop > 0 && s.scrollTop + s.clientHeight >= s.scrollHeight - 2;
  const tops = sections.map((x) => x.getBoundingClientRect().top - top);
  let at = spyIndex(tops, 80);
  // At the foot a short section cannot reach the top: the one asked for (the hash), while in view, else the last.
  const asked = sections.findIndex((x) => x.id === (byHash ?? location.hash.slice(1)));
  if (byHash) at = Math.max(0, asked);
  else if (atEnd) at = asked >= 0 && tops[asked] < s.clientHeight ? asked : sections.length - 1;
  const id = sections[at]?.id;
  for (const r of pn.querySelectorAll('.settings-index a.row')) {
    const on = r.getAttribute('href') === `#${id}`;
    r.classList.toggle('is-selected', on);
    if (on) r.setAttribute('aria-current', 'true'); else r.removeAttribute('aria-current');
  }
  const row = pn.querySelector(`.settings-index a.row[href="#${id}"] .txt`);
  setCrumb(['Settings', row?.textContent.trim() || sections[at]?.querySelector('h2')?.textContent.trim() || 'Settings']);
}

/** Scrolls the sheet to a section, the hash replaced (no history entry), the index and crumb following. */
function settingsGo(id, focus = false) {
  const t = document.getElementById(id);
  const s = sheet();
  if (!t || !s?.contains(t)) return;
  t.scrollIntoView({ block: 'start' });
  history.replaceState(history.state, '', `#${id}`);
  settingsSpy(id);
  if (focus) { const h = t.querySelector('h2'); if (h) { h.setAttribute('tabindex', '-1'); h.focus({ preventScroll: true }); } }
}

function mountSettings(signal) {
  if (!besideOn() || location.pathname !== '/settings') return;
  const root = document.querySelector('main > .settings');
  const body = root?.querySelector(':scope > .settings-body');
  const index = body?.querySelector(':scope > ul.settings-index');
  if (!root || !body || !index) return;
  // Work mode has no This device row: the This Mac section desk.js added gets one, before Connections.
  if (document.getElementById('this-device') && !index.querySelector('a[href="#this-device"]')) {
    index.prepend(el('li', {}, el('a', { class: 'row', href: '#this-device' }, el('span', { class: 'txt', text: 'This Mac' }), el('span', { class: 'st', text: prefs().keys ? 'Shortcuts on' : 'Shortcuts off' }), el('span', { class: 'chev' }))));
  }
  const list = el('div', { class: 'desk-list', 'data-place': 'settings' }, ...[body.querySelector(':scope > h1'), index, body.querySelector(':scope > .lede'), body.querySelector(':scope > .error')].filter(Boolean));
  const s = buildSheet('settings');
  s.querySelector('.desk-hide')?.remove();
  s.querySelector('.desk-x')?.remove();
  s.querySelector('.desk-main').append(...body.querySelectorAll(':scope > section'));
  s.dataset.kind = 'settings';
  const nav = root.querySelector(':scope > .settings-nav');
  const f = el('div', { class: 'desk-panes', 'data-place': 'settings' }, list, s, ...(nav ? [nav] : []));
  root.replaceWith(f);
  touched = true;
  history.replaceState({ desk: { kind: 'settings', place: 'settings' } }, '');
  index.addEventListener('click', (e) => {
    const a = e.target instanceof Element ? e.target.closest('a.row[href^="#"]') : null;
    if (!a || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    settingsGo(a.getAttribute('href').slice(1));
  }, { signal });
  let queued = false;
  s.addEventListener('scroll', () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; settingsSpy(); });
  }, { passive: true, signal });
  const hash = location.hash.slice(1);
  if (hash && document.getElementById(hash)) requestAnimationFrame(() => settingsGo(hash));
  else settingsSpy();
}

PLACE.settings = {
  overview: () => '/settings',
  rows: () => [...(listPane()?.querySelectorAll('.settings-index a.row') ?? [])],
  mark: () => settingsSpy(),
  canMount: () => false,
  mount: null,
  /** ↑ ↓ in the index: the next section, in the sheet (no history entry). */
  step: (dir) => {
    const rows = PLACE.settings.rows();
    const at = rows.findIndex((r) => r === document.activeElement || r.classList.contains('is-selected'));
    const next = rows[stepIndex(at, dir, rows.length)];
    if (!next) return;
    next.focus();
    settingsGo(next.getAttribute('href').slice(1));
  },
};

setups.push((signal) => mountSettings(signal));

// ---- The ⌘K palette (design §4.10): /search parsed in a dialog, a preview, and the safe Do group ----

let palette = null;
let palReturn = null;
let palItems = [];
let palAt = -1;
let palTimer = 0;
let palAbort = null;
const palLatest = createLatest();
let graphOverview = null;
const AREA_NAMES = { apps: 'Apps', home: 'Home & infrastructure', tools: 'Tools & AI', work: 'Work', personal: 'Personal', start: 'Start here' };
const onGraph = () => document.body.classList.contains('graph-on');
const workMode = () => !document.querySelector('nav.side a.side-sub[href="/growth"]');

function svgFind() {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', 'desk-pal-icon');
  const c = document.createElementNS(NS, 'circle');
  c.setAttribute('cx', '11'); c.setAttribute('cy', '11'); c.setAttribute('r', '7');
  const path = document.createElementNS(NS, 'path');
  path.setAttribute('d', 'm20 20-3.5-3.5');
  svg.append(c, path);
  return svg;
}

function buildPalette() {
  const input = el('input', { type: 'text', class: 'desk-pal-q', placeholder: 'Search or jump to', 'aria-label': 'Search or jump to', autocomplete: 'off', spellcheck: 'false',
    role: 'combobox', 'aria-expanded': 'true', 'aria-controls': 'desk-pal-res', 'aria-autocomplete': 'list' });
  const d = add(el('dialog', { class: 'desk-palette', 'aria-label': 'Search or jump to' },
    el('div', { class: 'desk-pal-in' }, svgFind(), input, el('kbd', { text: 'esc' })),
    el('div', { class: 'desk-pal-body' }, el('div', { class: 'desk-pal-res', id: 'desk-pal-res', role: 'listbox', 'aria-label': 'Results' }), el('aside', { class: 'desk-pal-prev', 'aria-live': 'polite' })),
    el('div', { class: 'desk-pal-foot' },
      el('span', {}, el('kbd', { text: '↑' }), ' ', el('kbd', { text: '↓' }), ' move'), el('span', { class: 'desk-sep', text: ' · ' }),
      el('span', {}, el('kbd', { text: '↵' }), ' open beside the list'), el('span', { class: 'desk-sep', text: ' · ' }),
      el('span', {}, el('kbd', { text: '⌘↵' }), ' open as its own page'),
      el('span', { class: 'desk-pal-scope', text: 'Searches projects, pages, facts and page sections' }))));
  input.addEventListener('input', () => {
    clearTimeout(palTimer);
    palTimer = setTimeout(() => palSearch(input.value), 120);
  });
  d.addEventListener('keydown', (e) => {
    if (e.isComposing) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closePalette(); return; }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); palSelect(palAt + (e.key === 'ArrowDown' ? 1 : -1)); return; }
    if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); palChoose(palItems[palAt], e.metaKey || e.ctrlKey); }
  });
  d.addEventListener('close', () => {
    clearTimeout(palTimer);
    palAbort?.abort();
    const back = palReturn;
    palReturn = null;
    if (back && back.isConnected) back.focus({ preventScroll: true });
  });
  // A click on the scrim (the dialog itself, outside its card) closes it.
  d.addEventListener('click', (e) => { if (e.target === d) closePalette(); });
  document.body.append(d);
  return d;
}

function openPalette(q = '', from = null) {
  palette ??= buildPalette();
  const input = palette.querySelector('.desk-pal-q');
  if (palette.open) { input.focus(); return; }
  palReturn = from ?? (document.activeElement !== document.body ? document.activeElement : null);
  input.value = q;
  palette.showModal();
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
  palSearch(q);
}
function closePalette() {
  if (palette?.open) palette.close();
}

/** One group's rows from the /search page: title, sub, meta and where it goes. */
function searchGroups(doc) {
  return [...doc.querySelectorAll('main section.search-group')].map((g) => ({
    label: g.querySelector('h2')?.textContent.trim() ?? '',
    rows: [...g.querySelectorAll('a.row[href]')].map((a) => {
      const txt = a.querySelector('.txt');
      const b = txt?.querySelector(':scope > b');
      const first = [...(txt?.childNodes ?? [])].find((n) => n.nodeType === 3 && n.textContent.trim() !== '');
      return { title: (b?.textContent ?? first?.textContent ?? a.textContent).trim(), sub: txt?.querySelector(':scope > .sub')?.textContent.trim() ?? '', meta: [...(txt?.querySelectorAll(':scope > .meta-line > li') ?? [])].map((li) => li.textContent.trim()).filter(Boolean).join(' · '), href: a.getAttribute('href') };
    }),
  }));
}

async function palSearch(q) {
  const n = palLatest.next();
  palAbort?.abort();
  const ctl = palAbort = new AbortController();
  const t = String(q).trim();
  const doRows = paletteDo(t, { work: workMode() }).map((x) => ({ title: x.label, href: x.href, idea: x.idea, key: x.key, sub: '', meta: '' }));
  if (t === '') { palRender([{ label: 'Do', rows: doRows }], t); return; }
  let groups = [], failed = false, empty = false;
  try {
    const [page, graph] = await Promise.all([
      fetch(`/search?q=${encodeURIComponent(t)}`, { headers: { Accept: 'text/html' }, credentials: 'same-origin', signal: ctl.signal }),
      onGraph() ? fetch(`/graph/find.json?q=${encodeURIComponent(t)}`, { headers: { Accept: 'application/json' }, credentials: 'same-origin', signal: ctl.signal }).then((r) => (r.ok ? r.json() : null)).catch((e) => { if (isAbort(e)) throw e; return null; }) : null,
    ]);
    if (!page.ok || page.redirected) throw new Error('search');
    const doc = new DOMParser().parseFromString(await page.text(), 'text/html');
    groups = searchGroups(doc);
    empty = !!doc.querySelector('main p.empty');
    if (graph?.projects?.length) groups.unshift({ label: 'In the graph', rows: graph.projects.map((x) => ({ title: x.name, sub: `${x.hits} ${x.hits === 1 ? 'match' : 'matches'}`, meta: '', node: x.name })) });
  } catch (e) {
    if (isAbort(e)) return;
    failed = true;
  }
  if (!palLatest.isLatest(n) || !palette?.open) return;
  const order = paletteOrder([...groups.map((g) => g.label), 'Do'], onGraph());
  const all = [...groups, { label: 'Do', rows: doRows }];
  const shown = order.map((l) => all.find((g) => g.label === l)).filter((g) => g && g.rows.length > 0);
  palRender(shown, t, failed ? 'Couldn’t search right now.' : empty || groups.every((g) => g.rows.length === 0) ? `Nothing matches “${t}”.` : null);
}

function palRender(groups, q, note = null) {
  const res = palette.querySelector('.desk-pal-res');
  const kids = [];
  palItems = [];
  if (note) kids.push(el('p', { class: 'desk-pal-note', text: note }));
  for (const g of groups) {
    const box = el('div', { class: 'desk-pal-group', role: 'group', 'aria-label': g.label }, el('p', { class: 'desk-pal-h', 'aria-hidden': 'true', text: g.label }));
    for (const r of g.rows) {
      const i = palItems.length;
      const title = el('span', { class: 'desk-pal-t' });
      // Only results are marked; the Do group's own words are not search hits.
      for (const part of g.label === 'Do' ? [{ text: r.title, hit: false }] : markParts(r.title, q)) title.append(part.hit ? el('mark', { text: part.text }) : part.text);
      const side = r.sub || r.meta.split(' · ')[0] || '';
      const opt = el('div', { role: 'option', id: `desk-pal-opt-${i}`, 'aria-selected': 'false', class: 'desk-pal-opt' }, title, side ? el('span', { class: 'desk-pal-s', text: side }) : null, r.key ? el('kbd', { text: r.key }) : null);
      opt.addEventListener('pointermove', () => { if (palAt !== i) palSelect(i); });
      opt.addEventListener('click', (e) => palChoose(r, e.metaKey || e.ctrlKey));
      palItems.push(r);
      box.append(opt);
    }
    kids.push(box);
  }
  res.replaceChildren(...kids);
  palSelect(palItems.length ? 0 : -1);
}

function palSelect(i) {
  if (!palette) return;
  const n = palItems.length;
  palAt = n === 0 ? -1 : Math.min(n - 1, Math.max(0, i));
  const input = palette.querySelector('.desk-pal-q');
  for (const o of palette.querySelectorAll('[role="option"]')) o.setAttribute('aria-selected', String(o.id === `desk-pal-opt-${palAt}`));
  if (palAt < 0) { input.removeAttribute('aria-activedescendant'); palette.querySelector('.desk-pal-prev').replaceChildren(); return; }
  input.setAttribute('aria-activedescendant', `desk-pal-opt-${palAt}`);
  palette.querySelector(`#desk-pal-opt-${palAt}`)?.scrollIntoView({ block: 'nearest' });
  palPreview(palItems[palAt]);
}

/** The preview: a project's card from /graph.json (fetched once), else the row's own title, sub and meta. */
async function palPreview(r) {
  const prev = palette.querySelector('.desk-pal-prev');
  const name = r.node ?? (r.href ? new URL(r.href, location.href).searchParams.get('project') : null);
  // replaceChildren() writes a null as the text "null": only the parts there are.
  const put = (...kids) => prev.replaceChildren(...kids.filter(Boolean));
  const plain = () => put(el('p', { class: 'desk-pal-pt', text: r.title }), r.sub ? el('p', { class: 'desk-pal-ps', text: r.sub }) : null, r.meta ? el('p', { class: 'desk-pal-pm', text: r.meta }) : null);
  if (!name || (r.href && new URL(r.href, location.href).pathname !== '/')) { plain(); return; }
  plain();
  try {
    graphOverview ??= fetch('/graph.json', { headers: { Accept: 'application/json' }, credentials: 'same-origin' }).then((x) => (x.ok ? x.json() : null)).catch(() => null);
    const g = await graphOverview;
    const p = g?.projects?.find((x) => x.name === name);
    if (!p || palItems[palAt] !== r) return;
    const area = AREA_NAMES[p.area] ?? (p.area ? p.area : 'Unsorted');
    put(
      el('p', { class: 'desk-pal-pk', text: [area, p.onTheGo ? 'On the go' : p.state === 'idea' ? 'Idea' : p.state === 'parked' ? 'Parked' : 'Open'].filter(Boolean).join(' · ') }),
      el('p', { class: 'desk-pal-pt', text: p.name }),
      p.oneLiner ? el('p', { class: 'desk-pal-ps', text: p.oneLiner }) : null,
      p.next ? el('p', { class: 'desk-pal-pn' }, el('span', { class: 'desk-pal-pl', text: 'Next' }), p.next) : null,
      p.waiting ? el('p', { class: 'desk-pal-pm', text: `Waiting on you · ${p.waiting}` }) : null);
  } catch { /* the plain preview stays */ }
}

/** ↵ opens the row (beside the list where it can), ⌘↵ as its own page; an idea only fills the idea field. Never a post. */
function palChoose(r, own) {
  if (!r) return;
  if (r.idea !== undefined) {
    closePalette();
    ideaJump(r.idea);
    return;
  }
  if (r.node) {
    if (own) { location.assign(`/graph?project=${encodeURIComponent(r.node)}`); return; }
    closePalette();
    document.querySelector('.graph')?.dispatchEvent(new CustomEvent('graph:select', { detail: { name: r.node } }));
    return;
  }
  if (!r.href) return;
  const url = new URL(r.href, location.href).href;
  const kind = sheetKind(url, location.href);
  const place = kind ? sheetPlace(kind) : null;
  const beside = !own && besideOn() && kind && (framePlace() ? framePlace() === place : !!placeOf(place)?.canMount());
  palReturn = null;
  closePalette();
  if (beside) openInSheet(url); else location.assign(url);
}

/** The idea field on Projects, holding the text, focused: the owner presses Add idea. */
function ideaJump(text) {
  const fill = () => {
    const f = document.getElementById('idea-text');
    if (!f) return false;
    f.value = text;
    f.dispatchEvent(new Event('input', { bubbles: true }));
    f.focus();
    f.setSelectionRange(text.length, text.length);
    return true;
  };
  if (document.querySelector('main > .phome:not(.has-panel)') && fill()) return;
  if (homeNode && framePlace() === 'projects') { restoreOverview(null); if (fill()) return; }
  try { sessionStorage.setItem('desk.idea', text); } catch { /* storage off: the field stays empty */ }
  location.assign('/');
}

/** On the home after the palette's idea jump: the text in the field, focused. */
function ideaArrival() {
  if (!document.querySelector('main > .phome:not(.has-panel)')) return;
  let text = null;
  try { text = sessionStorage.getItem('desk.idea'); sessionStorage.removeItem('desk.idea'); } catch { /* storage off */ }
  if (text === null) return;
  const f = document.getElementById('idea-text');
  if (!f) return;
  f.value = text;
  f.dispatchEvent(new Event('input', { bubbles: true }));
  f.focus();
  f.setSelectionRange(text.length, text.length);
}

setups.push((signal) => {
  // ⌘K before app.js's own (which focuses the search field): the window, in the capture phase.
  window.addEventListener('keydown', (e) => {
    if (keyAction(e, keyContext()) !== 'palette') return;
    e.preventDefault();
    e.stopImmediatePropagation();
    openPalette();
  }, { signal, capture: true });
  const field = document.querySelector('nav.side .side-find input[name="q"]');
  const form = field?.form;
  if (field) {
    // A press or typing opens it, never focus: closing returns focus to the field, which would open it again.
    field.addEventListener('pointerdown', (e) => { if (e.button !== 0) return; e.preventDefault(); openPalette(field.value, field); }, { signal });
    field.addEventListener('keydown', (e) => {
      if (e.isComposing || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'Enter') { e.preventDefault(); openPalette(field.value, field); return; }
      if (e.key.length === 1) { e.preventDefault(); openPalette(field.value + e.key, field); }
    }, { signal });
  }
  form?.addEventListener('submit', (e) => { e.preventDefault(); openPalette(field.value, field); }, { signal });
  ideaArrival();
});

// ---- Polish (design §6): Skip to content first; the list pane a landmark VoiceOver can reach after the sidebar ----

const PLACE_NAMES = { projects: 'Projects', pages: 'Pages', facts: 'Facts', settings: 'Settings' };
/** The list pane: id="desk-list", focusable, and a labelled region where it is not already a nav. */
function labelList() {
  const pn = listPane();
  if (!pn) return;
  pn.id = 'desk-list';
  pn.setAttribute('tabindex', '-1');
  if (pn.tagName !== 'NAV' && !pn.hasAttribute('role')) {
    pn.setAttribute('role', 'region');
    pn.setAttribute('aria-label', PLACE_NAMES[framePlace()] ?? 'List');
  }
}

function skipLink() {
  const main = document.querySelector('main');
  if (!main || document.querySelector('a.desk-skip')) return;
  if (!main.id) {
    main.id = 'desk-main-start';
    restores.push(() => { if (main.id === 'desk-main-start') main.removeAttribute('id'); });
  }
  const a = add(el('a', { class: 'desk-skip', href: listPane() ? '#desk-list' : `#${main.id}`, text: 'Skip to content' }));
  a.addEventListener('click', (e) => {
    e.preventDefault();
    labelList();
    const t = listPane() ?? document.querySelector('main');
    if (!t) return;
    if (!t.hasAttribute('tabindex')) t.setAttribute('tabindex', '-1');
    t.focus();
  });
  document.body.prepend(a);
}

setups.push(() => {
  labelList();
  skipLink();
});

// ---- Set-up and tear-down ----


function setup() {
  if (ac) return;
  ac = new AbortController();
  document.documentElement.classList.add('desk-on');
  document.addEventListener('keydown', onKey, { signal: ac.signal });
  addHint();
  thisMac();
  for (const s of setups) s(ac.signal);
}

function teardown() {
  if (!ac) return;
  ac.abort();
  ac = null;
  if (touched) {
    // The sheet moved page content: the canonical page of the current URL is the phone layout's truth. A reload, because
    // replacing the location with the same URL and a #fragment (#panel, #notyet) is a same-document jump: nothing loads.
    location.reload();
    return;
  }
  for (const n of inserted) n.remove();
  inserted.clear();
  for (const r of restores.splice(0)) r();
  // The dialogs went with the inserted nodes: the next set-up builds them again (a removed dialog cannot be shown).
  hideToast();
  palAbort?.abort();
  keysDialog = palette = peekDialog = peekRow = confirmDialog = palReturn = null;
  document.documentElement.classList.remove('desk-on');
}

function start() {
  if (wideQ.matches) setup();
  wideQ.addEventListener('change', (e) => (e.matches ? setup() : teardown()));
}

if (browser) start();
