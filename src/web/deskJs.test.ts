/*
 * desk.js, the desktop-only module (desktop design §5, §6): its pure helpers run here in node; the page part is guarded
 * by `typeof document`, so importing it has no side effects.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const d = await import(new URL('./static/desk.js', import.meta.url).href);
const ctx = { typing: false, keysOn: true, screen: 'panes', inSheetForm: false, inList: true, toast: false, dialog: false };
const k = (key: string, code: string, mods = {}) => ({ key, code, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods });

test('no single key ever submits; ⌘↵ submits only from a text field in an allowlisted sheet form', () => {
  for (const [key, code] of [['Enter', 'Enter'], ['x', 'KeyX'], ['e', 'KeyE'], ['a', 'KeyA'], ['r', 'KeyR'], ['Delete', 'Delete'], [' ', 'Space']]) {
    assert.notEqual(d.keyAction(k(key!, code!), ctx), 'submit');
    assert.notEqual(d.keyAction(k(key!, code!), { ...ctx, inSheetForm: true }), 'submit');
  }
  assert.equal(d.keyAction(k('Enter', 'Enter', { metaKey: true }), ctx), null);
  assert.equal(d.keyAction(k('Enter', 'Enter', { metaKey: true }), { ...ctx, inSheetForm: true, typing: true }), 'submit');
  assert.equal(d.keyAction(k('Enter', 'Enter', { ctrlKey: true }), { ...ctx, inSheetForm: true, typing: true }), 'submit');
  // focus on Reject, "Keep it", a checkbox or Archive: not typing, so nothing
  assert.equal(d.keyAction(k('Enter', 'Enter', { metaKey: true }), { ...ctx, inSheetForm: true, typing: false }), null);
  assert.equal(d.keyAction(k('Enter', 'Enter', { metaKey: true, repeat: true }), { ...ctx, inSheetForm: true, typing: true }), null);
});

test('cmdEnterForm allows approve, decide and save forms only', () => {
  for (const a of ['/suggestions/s1/approve', '/discussions/d1/decide', '/discussions/d1/note', '/projects/wildlog/info', 'https://b.test/suggestions/s1/approve'])
    assert.equal(d.cmdEnterForm(a), true, a);
  for (const a of ['/suggestions/s1/reject', '/discussions/d1/delete', '/projects/wildlog/state', '/projects/wildlog/pin', '/projects/wildlog/unpin',
    '/projects/wildlog/waiting/0/done', '/projects/wildlog/done/0/undo', '/folders/add', '/folders/ignore', '/projects/ideas', ''])
    assert.equal(d.cmdEnterForm(a), false, a);
});

test('held keys and IME composition do nothing, except held arrows', () => {
  for (const [key, code] of [['x', 'KeyX'], ['1', 'Digit1'], ['n', 'KeyN'], ['?', 'Slash'], ['Escape', 'Escape']])
    assert.equal(d.keyAction(k(key!, code!, { repeat: true }), ctx), null, code);
  assert.equal(d.keyAction(k('ArrowDown', 'ArrowDown', { repeat: true }), ctx), 'down');
  assert.equal(d.keyAction(k('j', 'KeyJ', { repeat: true }), ctx), 'down');
  for (const [key, code] of [['x', 'KeyX'], ['1', 'Digit1'], ['Escape', 'Escape'], ['ArrowDown', 'ArrowDown']])
    assert.equal(d.keyAction(k(key!, code!, { isComposing: true }), ctx), null, code);
});

test('arrows step the list only with focus in the list; in the sheet they scroll it', () => {
  assert.equal(d.keyAction(k('ArrowDown', 'ArrowDown'), { ...ctx, inList: true }), 'down');
  assert.equal(d.keyAction(k('ArrowUp', 'ArrowUp'), { ...ctx, inList: true }), 'up');
  assert.equal(d.keyAction(k('ArrowDown', 'ArrowDown'), { ...ctx, inList: false }), null);
  assert.equal(d.keyAction(k('ArrowUp', 'ArrowUp'), { ...ctx, inList: false }), null);
  assert.equal(d.keyAction(k('j', 'KeyJ'), { ...ctx, inList: false }), null);
  assert.equal(d.keyAction(k('ArrowDown', 'ArrowDown'), { ...ctx, screen: 'overview', inList: false }), 'down');
  assert.equal(d.keyAction(k('ArrowUp', 'ArrowUp'), { ...ctx, screen: 'overview' }), null);
  assert.equal(d.keyAction(k('ArrowDown', 'ArrowDown'), { ...ctx, screen: 'other' }), null);
});

test('single keys never fire while typing or with shortcuts off; Esc and ⌘\\ still work', () => {
  for (const [key, code] of [['1', 'Digit1'], ['?', 'Slash'], ['x', 'KeyX'], ['n', 'KeyN'], ['\\', 'Backslash'], ['ArrowDown', 'ArrowDown']]) {
    assert.equal(d.keyAction(k(key!, code!), { ...ctx, typing: true }), null, code);
    assert.equal(d.keyAction(k(key!, code!), { ...ctx, keysOn: false }), null, code);
  }
  assert.equal(d.keyAction(k('Escape', 'Escape'), { ...ctx, keysOn: false }), 'esc');
  assert.equal(d.keyAction(k('Escape', 'Escape'), { ...ctx, typing: true }), 'blur');
  assert.equal(d.keyAction(k('\\', 'Backslash', { metaKey: true }), { ...ctx, keysOn: false }), 'hide-list');
  assert.equal(d.keyAction(k('\\', 'Backslash', { metaKey: true }), { ...ctx, screen: 'overview' }), null);
  assert.equal(d.keyAction(k('k', 'KeyK', { metaKey: true }), ctx), 'palette', '⌘K opens the palette (D34; before, app.js focused the search field)');
});

test('keys read event.code, so a Spanish layout works; ? reads event.key', () => {
  assert.equal(d.keyAction(k('!', 'Digit1'), ctx), 'place1');
  assert.equal(d.keyAction(k('4', 'Digit4'), { ...ctx, screen: 'other' }), 'place4');
  assert.equal(d.keyAction(k('5', 'Digit5'), ctx), null);
  assert.equal(d.keyAction(k('º', 'Backslash'), ctx), 'hide-list');
  assert.equal(d.keyAction(k('?', 'Minus', { shiftKey: true }), ctx), 'keys');
  assert.equal(d.keyAction(k('j', 'KeyJ'), { ...ctx, screen: 'overview' }), 'down');
  assert.equal(d.keyAction(k('k', 'KeyK'), { ...ctx, screen: 'overview' }), null);
  assert.equal(d.keyAction(k('\\', 'Backslash'), { ...ctx, screen: 'other' }), null);
  assert.equal(d.keyAction(k('x', 'KeyX'), { ...ctx, screen: 'other' }), null);
  assert.equal(d.keyAction(k('x', 'KeyX'), ctx), 'tick');
  assert.equal(d.keyAction(k('e', 'KeyE'), ctx), 'edit');
  assert.equal(d.keyAction(k('n', 'KeyN'), { ...ctx, screen: 'overview' }), 'idea');
  assert.equal(d.keyAction(k('n', 'KeyN'), { ...ctx, screen: 'other' }), null);
  assert.equal(d.keyAction(k('z', 'KeyZ'), ctx), null);
  assert.equal(d.keyAction(k('z', 'KeyZ'), { ...ctx, toast: true }), 'undo');
  assert.equal(d.keyAction(k('1', 'Digit1'), { ...ctx, dialog: true }), null);
  assert.equal(d.keyAction(k('?', 'Slash'), { ...ctx, dialog: true }), 'keys');
  assert.equal(d.keyAction(k('Escape', 'Escape'), { ...ctx, dialog: true }), 'esc');
});

test('isTyping: text fields yes, buttons and checkboxes no', () => {
  for (const type of [undefined, '', 'text', 'search', 'email', 'number', 'password', 'url'])
    assert.equal(d.isTyping({ tagName: 'INPUT', type }), true, String(type));
  for (const type of ['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color'])
    assert.equal(d.isTyping({ tagName: 'INPUT', type }), false, type);
  assert.equal(d.isTyping({ tagName: 'TEXTAREA' }), true);
  assert.equal(d.isTyping({ tagName: 'SELECT' }), true);
  assert.equal(d.isTyping({ tagName: 'DIV', isContentEditable: true }), true);
  for (const tagName of ['BUTTON', 'A', 'BODY', 'SUMMARY']) assert.equal(d.isTyping({ tagName }), false, tagName);
  assert.equal(d.isTyping(null), false);
});

test('prefs default on, off is stored as "off", on removes the key, a throwing storage means on', () => {
  const mem = new Map<string, string>();
  const storage = { getItem: (key: string) => mem.get(key) ?? null, setItem: (key: string, v: string) => { mem.set(key, v); }, removeItem: (key: string) => { mem.delete(key); } };
  assert.deepEqual(d.readPrefs(storage), { keys: true, beside: true });
  d.writePref(storage, 'keys', false);
  assert.equal(mem.get('desk.keys'), 'off');
  assert.deepEqual(d.readPrefs(storage), { keys: false, beside: true });
  d.writePref(storage, 'beside', false);
  assert.deepEqual(d.readPrefs(storage), { keys: false, beside: false });
  d.writePref(storage, 'keys', true);
  assert.equal(mem.has('desk.keys'), false);
  assert.deepEqual(d.readPrefs(storage), { keys: true, beside: false });
  assert.deepEqual(d.readPrefs(null), { keys: true, beside: true });
  const throwing = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); }, removeItem: () => { throw new Error('denied'); } };
  assert.deepEqual(d.readPrefs(throwing), { keys: true, beside: true });
  assert.doesNotThrow(() => d.writePref(throwing, 'keys', false));
  assert.equal(d.PREF.nolist('projects'), 'desk.nolist.projects');
});

test('deskFoldWanted opens "" when wide and "xl" only from 1920', () => {
  assert.equal(d.deskFoldWanted('', true, false), true);
  assert.equal(d.deskFoldWanted('', false, false), false);
  assert.equal(d.deskFoldWanted('xl', true, true), true);
  assert.equal(d.deskFoldWanted('xl', true, false), false);
  assert.equal(d.deskFoldWanted('xl', false, true), false);
  assert.equal(d.deskFoldWanted(undefined, true, true), false);
});

// ---- Task 6: the sheet beside the list ----

test('sheetKind knows the four sheets and nothing else', () => {
  const B = 'https://b.test/';
  assert.equal(d.sheetKind('/?project=ferngrid#panel', B), 'project');
  assert.equal(d.sheetKind('https://b.test/?project=a%20b', B), 'project');
  assert.equal(d.sheetKind('/approvals', B), 'approval');
  assert.equal(d.sheetKind('/discussions/ab12', B), 'discussion');
  assert.equal(d.sheetKind('/#notyet', B), 'notyet');
  for (const h of ['/', '/?project=', '/discussions', '/approvals?pane=side', '/?project=a&pane=side', '/?pane=projects', '/pages/x', 'https://other.test/?project=a', '/discussions/ab12/files/x', '/discussions/ab12?pane=side', '/settings', '/memories/m1/history'])
    assert.equal(d.sheetKind(h, B), null, h);
});

test('sideUrl asks the fragment of the same route', () => {
  const B = 'https://b.test/';
  assert.equal(d.sideUrl('project', '/?project=a b#panel', B), '/?project=a%20b&pane=side');
  assert.equal(d.sideUrl('approval', '/approvals', B), '/approvals?pane=side');
  assert.equal(d.sideUrl('approval', '/approvals', B, 's 1'), '/approvals?pane=side&id=s%201');
  assert.equal(d.sideUrl('discussion', '/discussions/ab12', B), '/discussions/ab12?pane=side');
  assert.equal(d.sideUrl('notyet', '/#notyet', B), null);
});

test('crumbs read as in the mockup', () => {
  assert.deepEqual(d.crumbParts('project', 'ferngrid'), ['Projects', 'ferngrid']);
  assert.deepEqual(d.crumbParts('approval', ''), ['Inbox']);
  assert.deepEqual(d.crumbParts('discussion', 'ledgerline'), ['Projects', 'ledgerline', 'Discussion']);
  assert.deepEqual(d.crumbParts('discussion', ''), ['Projects', 'Discussions', 'Discussion']);
  assert.deepEqual(d.crumbParts('notyet', ''), ['Projects', 'Not in the brain yet']);
});

test('stepIndex clamps; history replaces only when the URL is the same', () => {
  assert.equal(d.stepIndex(-1, 1, 5), 0);
  assert.equal(d.stepIndex(0, 1, 5), 1);
  assert.equal(d.stepIndex(4, 1, 5), 4);
  assert.equal(d.stepIndex(0, -1, 5), 0);
  assert.equal(d.stepIndex(3, -1, 5), 2);
  assert.equal(d.stepIndex(-1, -1, 5), 0);
  assert.equal(d.historyMode('https://b.test/?project=a#panel', 'https://b.test/?project=a'), 'replace');
  assert.equal(d.historyMode('https://b.test/?project=a', 'https://b.test/?project=b'), 'push');
  assert.equal(d.historyMode('https://b.test/approvals', 'https://b.test/approvals'), 'replace');
});

// ---- Task 7: forms in the sheet ----

test('requestFor follows the button that was pressed: Reject posts to its own formaction', () => {
  const form = { action: 'https://b.test/suggestions/s1/approve', method: 'post' };
  const reject = { formAction: 'https://b.test/suggestions/s1/reject', formMethod: 'post', hasAttribute: (n: string) => n === 'formaction' };
  const approve = { formAction: 'https://b.test/suggestions/s1/approve', formMethod: 'post', hasAttribute: () => false };
  assert.deepEqual(d.requestFor(form, reject), { url: 'https://b.test/suggestions/s1/reject', method: 'post' });
  assert.deepEqual(d.requestFor(form, approve), { url: 'https://b.test/suggestions/s1/approve', method: 'post' });
  assert.deepEqual(d.requestFor(form, null), { url: 'https://b.test/suggestions/s1/approve', method: 'post' });
  const getter = { formAction: 'https://b.test/x', formMethod: 'get', hasAttribute: (n: string) => n === 'formmethod' };
  assert.equal(d.requestFor(form, getter).method, 'get');
  assert.equal(d.requestFor({ action: 'https://b.test/search', method: 'get' }, null).method, 'get');
});

test('postOutcome: a redirect to a sheet swaps, to anything else goes there, an answer in place stays', () => {
  const B = 'https://b.test/?project=a';
  assert.deepEqual(d.postOutcome({ redirected: true, url: 'https://b.test/?project=a', ok: true }, B), { do: 'swap', url: 'https://b.test/?project=a' });
  assert.deepEqual(d.postOutcome({ redirected: true, url: 'https://b.test/approvals', ok: true }, B), { do: 'swap', url: 'https://b.test/approvals' });
  assert.deepEqual(d.postOutcome({ redirected: true, url: 'https://b.test/discussions', ok: true }, B), { do: 'go', url: 'https://b.test/discussions' });
  assert.deepEqual(d.postOutcome({ redirected: true, url: 'https://b.test/review', ok: true }, B), { do: 'go', url: 'https://b.test/review' });
  assert.deepEqual(d.postOutcome({ redirected: false, url: 'https://b.test/projects/a/state', ok: false }, B), { do: 'inplace' });
  assert.deepEqual(d.postOutcome({ redirected: false, url: 'https://b.test/suggestions/s/approve', ok: true }, B), { do: 'inplace' });
});

test('toastText quotes the item and cuts it at 60 characters', () => {
  assert.equal(d.toastText('item 1'), 'Ticked “item 1”');
  const long = 'x'.repeat(61);
  assert.equal(d.toastText(long), `Ticked “${'x'.repeat(60)}…”`);
  assert.equal(d.toastText('y'.repeat(60)), `Ticked “${'y'.repeat(60)}”`);
});

// ---- Review fixes ----

const deskSrc = readFileSync(new URL('./static/desk.js', import.meta.url), 'utf8');
const fnBody = (name: string) => {
  const at = deskSrc.indexOf(`function ${name}(`);
  assert.ok(at >= 0, name);
  return deskSrc.slice(at, deskSrc.indexOf('\n}\n', at));
};

test('narrowing with a sheet open reloads even when the URL has a #fragment (#panel, #notyet): location.reload, never replace(href)', () => {
  // location.replace(location.href) with a fragment is a same-document jump: nothing reloads, the desk DOM stays.
  assert.ok(!/location\.replace\(location\.href\)/.test(deskSrc), 'no location.replace(location.href)');
  assert.ok(/location\.reload\(\)/.test(fnBody('teardown')), 'teardown reloads');
  assert.ok(/location\.reload\(\)/.test(fnBody('onPop')), 'onPop falls back to a reload');
});

test('after any post from the list or the sheet, the kept overview is dropped: Esc, ✕, Overview and n load / fresh', () => {
  // The overview kept aside is a snapshot from before the sheet opened: after a tick, approval or decision it would
  // show answered suggestions with live Approve and Reject forms.
  assert.ok(/homeNode = null/.test(fnBody('forgetHome')), 'forgetHome drops the snapshot');
  const submit = fnBody('onSubmit');
  const sent = submit.indexOf('await fetch(req.url');
  assert.ok(sent > 0, 'onSubmit posts with fetch');
  const forget = submit.indexOf('forgetHome()');
  assert.ok(forget > 0 && forget < sent, 'the snapshot is dropped before the post goes out (an answer may never come)');
});

test('arrows keep stepping after a project opens: the sheet heading desk.js focused counts as the list, a link in the sheet does not', () => {
  const node = (tagName: string, inList = false) => ({ tagName, closest: (sel: string) => (inList && sel === '.phome.has-panel > .plist' ? {} : null) });
  const heading = node('H2');
  assert.equal(d.listFocus(null, null), true);
  assert.equal(d.listFocus(node('BODY'), null), true);
  assert.equal(d.listFocus(node('HTML'), null), true);
  assert.equal(d.listFocus(node('A', true), null), true);
  // Opened by a click or by ↓: focus lands on the sheet's heading, and ↑ ↓ go on stepping, as in Mail.
  assert.equal(d.listFocus(heading, heading), true);
  // Clicked or tabbed into the sheet: the keys scroll it.
  assert.equal(d.listFocus(heading, null), false);
  assert.equal(d.listFocus(node('A'), heading), false);
});

test('arrows step from the row with keyboard focus, else from the selected one', () => {
  assert.equal(d.stepStart(2, 5), 2);
  assert.equal(d.stepStart(-1, 5), 5);
  assert.equal(d.stepStart(-1, -1), -1);
});

test('the approval sheet shows one suggestion: the one in ?id= when it still waits, else the first', () => {
  assert.equal(d.approvalPick(['a', 'b', 'c'], 'b'), 'b');
  assert.equal(d.approvalPick(['a', 'b', 'c'], undefined), 'a');
  assert.equal(d.approvalPick(['a', 'b'], 'gone'), 'a');
  assert.equal(d.approvalPick([], 'b'), undefined);
  assert.equal(d.approvalIdOf('https://b.test/approvals?id=s%201'), 's 1');
  assert.equal(d.approvalIdOf('/approvals'), undefined);
});

test('the approval crumb ends in the suggestion\'s kind, as in the mockup (Inbox › Profile)', () => {
  assert.deepEqual(d.crumbParts('approval', 'Profile'), ['Inbox', 'Profile']);
  assert.deepEqual(d.crumbParts('approval', ''), ['Inbox']);
});

test('the approval sheet is shaped as the mockup: the sentence is the h1, the writer leads the meta line, Suggested then Replaces struck through, key hints on the pills', () => {
  const shape = fnBody('shapeApproval');
  assert.ok(/el\('h1'/.test(shape), 'the head becomes the h1');
  assert.ok(/'Suggested'/.test(shape) && /'Replaces'/.test(shape), 'Suggested and Replaces labels');
  assert.ok(/classList\.add\('replaced'\)/.test(shape), 'the replaced text is marked for the strike');
  assert.ok(/'⌘↵'/.test(shape) && /aria-keyshortcuts/.test(shape), 'Approve carries ⌘↵');
  assert.ok(/text: 'E'/.test(shape), 'Edit first carries E');
  assert.ok(/shapeApproval\(/.test(fnBody('fillSheet')), 'fillSheet shapes an approval');
});

test('foldKey keys a fold by its id, else by its summary without counts', () => {
  assert.equal(d.foldKey('Not in the brain yet 2', 'notyet'), '#notyet');
  assert.equal(d.foldKey('Parked 3', ''), 'Parked');
  assert.equal(d.foldKey(' Quiet 4 ', ''), 'Quiet');
  assert.equal(d.foldKey('Done 1,204', ''), 'Done');
  assert.notEqual(d.foldKey('Parked 3', ''), d.foldKey('Personal 3', ''));
});

// ---- D34: places (pages, facts, settings) ----

test('sheetKind knows pages and facts, never their sub-pages', () => {
  const B = 'https://b.test/';
  const id = '0f8fad5b-d9cb-469f-a165-70867728950e';
  assert.equal(d.sheetKind(`/pages/${id}`, B), 'page');
  assert.equal(d.sheetKind(`/pages/${id}#storage`, B), 'page');
  for (const h of ['/pages/new', '/pages/moved', `/pages/${id}/edit`, `/pages/${id}/history`, '/pages']) assert.equal(d.sheetKind(h, B), null, h);
  assert.equal(d.sheetKind('/memories/m1?from=%2Ffacts', B), 'fact');
  for (const h of ['/memories/new', '/memories/m1/history', '/facts']) assert.equal(d.sheetKind(h, B), null, h);
});

test('sheetPlace and placeOfPath', () => {
  assert.deepEqual(['project', 'approval', 'discussion', 'notyet', 'page', 'fact'].map(d.sheetPlace), ['projects', 'projects', 'projects', 'projects', 'pages', 'facts']);
  assert.deepEqual(['/', '/pages', '/pages/x', '/facts', '/memories/x', '/review', '/review/now', '/growth', '/graph', '/settings', '/search'].map(d.placeOfPath),
    ['projects', 'pages', 'pages', 'facts', 'facts', 'week', 'week', 'week', 'graph', 'settings', 'other']);
});

test('listSource: a fact keeps the Facts list it came from, nothing else', () => {
  assert.equal(d.listSource('facts', '/memories/m1?from=%2Ffacts%3Fkind%3Dprofile'), '/facts?kind=profile');
  assert.equal(d.listSource('facts', '/memories/m1?from=%2Freview'), '/facts');
  assert.equal(d.listSource('facts', '/memories/m1?from=https%3A%2F%2Fevil.test%2Ffacts'), '/facts');
  assert.equal(d.listSource('projects', '/'), '/?pane=projects');
  assert.equal(d.listSource('settings', '/settings'), null);
});

test('sameDocAnchor: a #link to the page shown jumps, it is never refetched', () => {
  const B = 'https://b.test/';
  const id = '0f8fad5b-d9cb-469f-a165-70867728950e';
  const shown = `/pages/${id}`; // a pathKey: pathname + search
  assert.equal(d.sameDocAnchor(`/pages/${id}#storage`, shown, B), true);
  assert.equal(d.sameDocAnchor(`#ask_ai`, shown, `https://b.test/pages/${id}`), true);
  assert.equal(d.sameDocAnchor(`/pages/${id}`, shown, B), false);
  assert.equal(d.sameDocAnchor(`/pages/${id}#`, shown, B), false);
  assert.equal(d.sameDocAnchor('/pages/1f8fad5b-d9cb-469f-a165-70867728950e#storage', shown, B), false);
});

test('postOutcome keeps a redirect in its place', () => {
  const B = 'https://b.test/';
  const r = (url: string) => ({ redirected: true, url: new URL(url, B).href });
  assert.equal(d.postOutcome(r('/?project=ferngrid#panel'), B, 'facts').do, 'go');
  assert.equal(d.postOutcome(r('/?project=ferngrid#panel'), B, 'projects').do, 'swap');
  assert.equal(d.postOutcome(r('/memories/m1?from=%2Ffacts'), B, 'facts').do, 'swap');
  assert.equal(d.postOutcome(r('/memories/m1'), B, 'projects').do, 'go');
  assert.equal(d.postOutcome(r('/facts'), B, 'facts').do, 'go');
  assert.equal(d.postOutcome({ redirected: false, url: B }, B, 'facts').do, 'inplace');
});

test('postScope: Settings forms post natively', () => {
  for (const k of ['project', 'approval', 'discussion', 'notyet', 'page', 'fact']) assert.equal(d.postScope(k), true, k);
  for (const k of ['settings', undefined, '']) assert.equal(d.postScope(k), false, String(k));
});

test('DESK_FOLDS never names a never-open fold', () => {
  assert.ok(d.DESK_FOLDS.length > 0);
  for (const s of d.DESK_FOLDS) assert.doesNotMatch(s, /stale|nopage|notyet|panel\.fold|\.review > |asknote|livefold|toc-fold|picker/, s);
});

test('a fact opens read-only: the desktop does not open its editor, and History stays open', () => {
  assert.ok(!d.DESK_FOLDS.some((s: string) => s.includes('#edit')), 'the Edit fold stays folded');
  assert.ok(d.DESK_FOLDS.some((s: string) => s.includes('#history')), 'History stays open');
});

test('E opens the fact\'s editor and puts the caret at the end of its text', () => {
  const ta = { value: 'Cellar', scrolled: false, focused: false, range: null as [number, number] | null,
    scrollIntoView() { this.scrolled = true; }, focus() { this.focused = true; }, setSelectionRange(a: number, b: number) { this.range = [a, b]; } };
  const fold = { open: false, querySelector: (s: string) => (s === 'textarea' ? ta : null) };
  assert.equal(d.openEditFold(fold), true);
  assert.equal(fold.open, true, 'the fold opens');
  assert.equal(ta.focused, true, 'the text is focused');
  assert.deepEqual(ta.range, [6, 6], 'the caret is at the end');
  assert.equal(d.openEditFold(undefined), false, 'no fold, nothing to open');
});

test('spyIndex picks the last heading at or above the line', () => {
  assert.equal(d.spyIndex([], 80), -1);
  assert.equal(d.spyIndex([120, 400, 900], 80), 0);
  assert.equal(d.spyIndex([-300, 60, 500], 80), 1);
  assert.equal(d.spyIndex([-900, -400, 80], 80), 2);
});

test('keyAction: ⌘K always opens the palette, even typing or with keys off', () => {
  for (const c of [ctx, { ...ctx, typing: true }, { ...ctx, keysOn: false }, { ...ctx, screen: 'graph' }])
    assert.equal(d.keyAction(k('k', 'KeyK', { metaKey: true }), c), 'palette');
  assert.equal(d.keyAction(k('k', 'KeyK', { ctrlKey: true }), ctx), 'palette');
  assert.equal(d.keyAction(k('k', 'KeyK', { metaKey: true, shiftKey: true }), ctx), null);
});

test('keyAction: / filters only where a filter is, read by key (Spanish Shift+7 too)', () => {
  assert.equal(d.keyAction(k('/', 'Slash'), { ...ctx, filter: true }), 'filter');
  assert.equal(d.keyAction(k('/', 'Digit7', { shiftKey: true }), { ...ctx, filter: true }), 'filter');
  assert.equal(d.keyAction(k('/', 'Slash'), { ...ctx, filter: false }), null);
  assert.equal(d.keyAction(k('/', 'Slash'), { ...ctx, filter: true, typing: true }), null);
  assert.equal(d.keyAction(k('?', 'Slash', { shiftKey: true }), { ...ctx, filter: true }), 'keys');
});

test('keyAction: ← → step weeks on Week only; arrows on Graph are the graph\'s', () => {
  assert.equal(d.keyAction(k('ArrowLeft', 'ArrowLeft'), { ...ctx, screen: 'week' }), 'older');
  assert.equal(d.keyAction(k('ArrowRight', 'ArrowRight'), { ...ctx, screen: 'week' }), 'newer');
  for (const [key, code] of [['ArrowLeft', 'ArrowLeft'], ['ArrowDown', 'ArrowDown'], ['j', 'KeyJ']])
    assert.equal(d.keyAction(k(key!, code!), { ...ctx, screen: 'graph' }), null, code);
  assert.equal(d.keyAction(k('ArrowDown', 'ArrowDown'), { ...ctx, screen: 'week', peek: true }), 'down');
  assert.equal(d.keyAction(k('ArrowDown', 'ArrowDown'), { ...ctx, screen: 'week', peek: false }), null);
});

test('no single key deletes in a fact sheet', () => {
  for (const [key, code] of [['Delete', 'Delete'], ['Backspace', 'Backspace'], ['d', 'KeyD'], ['x', 'KeyX'], [' ', 'Space']])
    assert.ok(!['submit', 'delete'].includes(d.keyAction(k(key!, code!), { ...ctx, screen: 'panes' })), code);
});

test('pageCrumb: area, project when there is one, title', () => {
  assert.deepEqual(d.pageCrumb('Apps', 'lanternfish', 'Architecture · lanternfish'), ['Apps', 'lanternfish', 'Architecture · lanternfish']);
  assert.deepEqual(d.pageCrumb('Start here', null, 'How this wiki works'), ['Start here', 'How this wiki works']);
});

test('capLabel', () => {
  assert.equal(d.capLabel(71), '62 more ›');
  assert.equal(d.capLabel(10), '1 more ›');
  assert.equal(d.capLabel(9), null);
  assert.equal(d.capLabel(3), null);
});

// ---- D34 Task 7: the ⌘K palette ----
test('paletteDo never posts: only GET jumps and an idea that fills the field', () => {
  const all = d.paletteDo('', { work: false });
  assert.deepEqual(all.map((x: any) => x.label), ['Go to Projects', 'Go to Pages', 'Go to Facts', 'Go to Inbox', 'Go to Last week', 'Go to So far', 'Go to Growth', 'Go to Graph', 'Go to Settings']);
  for (const x of all) { assert.match(x.href, /^\/[\w/]*$/); assert.equal(x.idea, undefined); }
  assert.deepEqual(d.paletteDo('lantern', { work: false })[0], { label: 'Add “lantern” as an idea', idea: 'lantern' });
  assert.ok(!d.paletteDo('grow', { work: true }).some((x: any) => /Growth/.test(x.label)));
  assert.deepEqual(d.paletteDo('week', { work: false }).map((x: any) => x.label), ['Add “week” as an idea', 'Go to Last week']);
  assert.equal(d.paletteDo('x'.repeat(141), { work: false }).some((x: any) => x.idea), false);
  assert.deepEqual(d.paletteDo('ápprov', { work: false }).map((x: any) => x.href).filter(Boolean), ['/approvals']);
});
test('createLatest keeps the newest only', () => {
  const l = d.createLatest(); const a = l.next(); const b = l.next();
  assert.equal(l.isLatest(a), false); assert.equal(l.isLatest(b), true);
});
test('markParts marks every hit of each word, case-insensitive', () => {
  assert.deepEqual(d.markParts('Lanternfish lantern', 'lantern'), [{ text: 'Lantern', hit: true }, { text: 'fish ', hit: false }, { text: 'lantern', hit: true }]);
  assert.deepEqual(d.markParts('abc', ''), [{ text: 'abc', hit: false }]);
});
test('paletteOrder: In the graph first, only on Graph', () => {
  assert.deepEqual(d.paletteOrder(['Facts', 'Do', 'Projects', 'Pages', 'In the graph'], false), ['Projects', 'Pages', 'Facts', 'Do']);
  assert.deepEqual(d.paletteOrder(['Facts', 'Do', 'In the graph'], true), ['In the graph', 'Facts', 'Do']);
});

test("Delete…'s question says assistants will ask before saving the fact again", () => {
  assert.ok(deskSrc.includes("text: 'It leaves search for you and your assistants. Assistants that try to save it again will ask you first. You can bring it back from its History.'"));
});

test('opening a project in the sheet stays at its top: #panel and #notyet only name the sheet, a section hash scrolls', () => {
  // #panel is the project's own wrapper: scrolling to it put the title under the sticky crumb bar.
  assert.equal(d.sheetScrollId('/?project=homelab#panel'), null);
  assert.equal(d.sheetScrollId('/#notyet'), null);
  assert.equal(d.sheetScrollId('/pages/p1'), null);
  assert.equal(d.sheetScrollId('/pages/p1#'), null);
  assert.equal(d.sheetScrollId('/pages/p1#run-and-deploy'), 'run-and-deploy');
  assert.equal(d.sheetScrollId('/pages/p1#caf%C3%A9'), 'café');
});
