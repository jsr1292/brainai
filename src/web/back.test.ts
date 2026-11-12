import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BACK_ERRORS, backError, backFrom, factBackDefault, safeBack, SAFE_BACK, SUGGESTION_BACK, suggestionBack, withBackError, withFrom, type Back, type BackLookups } from './back.js';

const look: BackLookups = {
  pageTitle: (id) => id === '11111111-2222-3333-4444-555555555555' ? 'wildlog — wine cellar' : undefined,
  projectName: (name) => ['wildlog', 'WildLog'].includes(name) ? 'wildlog' : undefined,
  discussionTitle: (id) => id === 'd1' ? 'Which icon?' : undefined,
};

test('each allowed origin gives its label, address and tab', () => {
  const cases: [string, Back][] = [
    ['/facts', { href: '/facts', label: 'Facts', tab: 'facts' }],
    ['/facts?project=wildlog&kind=decision&page=2', { href: '/facts?kind=decision&project=wildlog&page=2', label: 'Facts', tab: 'facts' }],
    ['/facts?kind=profile', { href: '/facts?kind=profile', label: 'About you', tab: 'facts' }],
    ['/facts?show=replaced', { href: '/facts?show=replaced', label: 'Facts', tab: 'facts' }],
    ['/facts/tidy', { href: '/facts/tidy', label: 'Tidy up', tab: 'facts' }],
    ['/pages', { href: '/pages', label: 'Pages', tab: 'pages' }],
    ['/pages/11111111-2222-3333-4444-555555555555', { href: '/pages/11111111-2222-3333-4444-555555555555', label: 'wildlog — wine cellar', tab: 'pages' }],
    ['/memories/11111111-2222-3333-4444-555555555555', { href: '/memories/11111111-2222-3333-4444-555555555555', label: 'Fact', tab: 'facts' }],
    ['/', { href: '/', label: 'Projects', tab: 'projects' }],
    ['/?project=WildLog', { href: '/?project=wildlog#panel', label: 'wildlog', tab: 'projects' }],
    ['/discussions/d1', { href: '/discussions/d1', label: 'Discussion', tab: 'projects' }],
    ['/approvals', { href: '/approvals', label: 'Inbox', tab: 'inbox' }],
    ['/review', { href: '/review', label: 'Last week', tab: 'week' }],
    ['/review/now', { href: '/review/now', label: 'So far', tab: 'week' }],
    ['/review/2026-10-26', { href: '/review/2026-10-26', label: 'Week of 26 Oct', tab: 'week' }],
    ['/graph', { href: '/graph', label: 'Graph', tab: 'graph' }],
    ['/graph?view=list', { href: '/graph?view=list', label: 'Graph', tab: 'graph' }],
    ['/graph?view=3d&project=WildLog', { href: '/graph?project=wildlog&view=3d', label: 'Graph', tab: 'graph' }],
    ['/search?q=wine%20cellar', { href: '/search?q=wine%20cellar', label: 'Search', tab: null }],
  ];
  for (const [from, want] of cases) assert.deepEqual(backFrom(from, look), want, from);
});
test('anything else is ignored, and a label is never URL text', () => {
  for (const bad of ['//evil.example/facts', 'https://evil.example/', '/facts?from=/facts', '/facts?evil=1', '/facts?kind=nonsense',
    '/facts?page=99999', '/pages/22222222-2222-3333-4444-555555555555', '/?project=nobody', '/discussions/zz', '/settings',
    '/review/all', '/review/../settings', '/graph?view=map', '/graph?project=nobody', '/discussions/d1?x=1', '/search?q=a&from=/x', '/memories/x', '\\evil', 'javascript:alert(1)', '', ['/facts'], undefined])
    assert.equal(backFrom(bad, look), undefined, String(bad));
  assert.equal(backFrom('/search?q=' + 'x'.repeat(500), look)!.href, '/search?q=' + 'x'.repeat(200));
  assert.equal(backFrom('/facts?q=%3Cscript%3E', look)!.label, 'Facts');
});
test('a fact with no origin goes back to its project, else to Facts', () => {
  assert.deepEqual(factBackDefault({ project: 'WildLog' }, look), { href: '/?project=wildlog#panel', label: 'wildlog', tab: 'projects' });
  assert.deepEqual(factBackDefault({ project: 'gone' }, look), { href: '/facts', label: 'Facts', tab: 'facts' });
  assert.deepEqual(factBackDefault({ project: null }, look), { href: '/facts', label: 'Facts', tab: 'facts' });
});
test('approvals return only to Projects or Approvals', () => {
  assert.equal(suggestionBack('/approvals'), '/approvals');
  for (const v of ['/', '/settings', '//evil', '/pages/11111111-2222-3333-4444-555555555555', undefined, ['/approvals']]) assert.equal(suggestionBack(v), '/');
  assert.equal(SAFE_BACK.test('/'), false); assert.equal(SAFE_BACK.test('/approvals'), false);
});
test('withFrom appends the origin once, encoded', () => {
  assert.equal(withFrom('/memories/x', '/facts?kind=profile'), '/memories/x?from=%2Ffacts%3Fkind%3Dprofile');
  assert.equal(withFrom('/pages/x#stack', '/'), '/pages/x?from=%2F#stack');
  assert.equal(withFrom('/memories/x', undefined), '/memories/x');
});

test('SAFE_BACK accepts a page and the review addresses only', () => {
  for (const ok of ['/review', '/review/now', '/review/2026-10-26', '/pages/11111111-2222-3333-4444-555555555555']) assert.ok(SAFE_BACK.test(ok), ok);
  for (const bad of ['//evil.example', 'https://x', '/review/../settings', '/review?x=1', '/review/2026-10-26/open', '/settings', '/review/all', '/pages/x', '']) {
    assert.equal(SAFE_BACK.test(bad), false, bad);
    assert.equal(safeBack(bad), undefined, bad);
  }
  assert.equal(safeBack('/review/now'), '/review/now');
  assert.equal(safeBack(['/review']), undefined);
  assert.equal(safeBack(undefined), undefined);
});

test('only fixed error lines come back, picked by code', () => {
  assert.equal(backError('changed'), 'That changed since this page was made. This is how it stands now.');
  assert.equal(backError('failed'), BACK_ERRORS.failed);
  assert.equal(backError('<script>'), undefined);
  assert.equal(backError(['changed']), undefined);
  assert.equal(backError(undefined), undefined);
  assert.equal(withBackError('/review', 'changed'), '/review?error=changed');
});
