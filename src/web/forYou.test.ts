/** The Projects home's "For you" card: at most three rows, the rest folded behind one closed row. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { HomeSuggestion } from '../projects/service.js';
import type { Memory, Suggestion } from '../memory/types.js';
import { forYouCard, forYouRows, type ApprovalSummary } from './forYou.js';

const sug = (p: string) => ({ project: p, kind: 'pin-late', text: `${p} has something late: put it on the go?`, state: 'open', weeks: null }) as HomeSuggestion;
const aSuggestion = (over: Partial<Suggestion> = {}): Suggestion => ({
  id: 's1', action: 'add', memoryId: null, content: 'Prefers short answers in German when on the phone.', tags: [], kind: 'profile', project: null,
  reason: null, suggestedAt: '2026-11-03T09:00:00Z', suggestedBy: 'ChatGPT', status: 'pending', supersedes: [], deletedMatch: null, keys: null, ...over,
});
const oneWaiting: ApprovalSummary = {
  count: 1, first: { by: 'ChatGPT', kind: 'profile', action: 'create' },
  single: { suggestion: aSuggestion(), current: undefined, replaces: [] as Memory[] },
};
const appr: ApprovalSummary = oneWaiting;
const disc = { id: 'd1', title: 'Postgres or SQLite for shiftboard?' };

test('at most three rows show; the rest fold behind one closed "N suggestions" row', () => {
  const h = forYouCard(forYouRows({ approvals: appr, discussions: [disc], suggestions: [sug('a'), sug('b'), sug('c')] })).value;
  const [shown] = h.split('<li><details class="fold fy-more"');
  // The approval row's card holds its own <li>s (its meta line); only the rows themselves count.
  assert.equal((shown!.replace(/<ul class="meta-line">[\s\S]*?<\/ul>/g, '').match(/<li>/g) ?? []).length, 2, 'two rows before the fold: suggestions always fold');
  assert.match(h, /<summary class="row nolead">3 suggestions<span class="chev">/);
  assert.doesNotMatch(h, /<details class="fy-approval" open/);
  assert.ok(h.indexOf('ChatGPT') < h.indexOf('discussion'));
});

test('one waiting approval opens as the full card in place; the row itself stays quiet', () => {
  const h = forYouCard(forYouRows({ approvals: appr, discussions: [], suggestions: [] })).value;
  assert.match(h, /<li><details class="fy-approval"><summary class="row"><span class="dot"[^>]*><\/span><span class="txt"><b>ChatGPT<\/b> suggests adding to your profile<\/span><span class="chev"><\/span><\/summary><article class="card suggestion approval-card">/);
  assert.match(h, /Prefers short answers in German when on the phone\./);
  assert.match(h, /<input type="hidden" name="back" value="\/">/);
  assert.match(h, /class="primary">Approve</);
  const row = h.slice(0, h.indexOf('</summary>'));
  assert.doesNotMatch(row, /\bprimary\b/, 'the row keeps no black button of its own');
});

test('one discussion waiting on you is named and opens itself', () => {
  const h = forYouCard(forYouRows({ approvals: { count: 0, first: null }, discussions: [disc], suggestions: [] })).value;
  assert.match(h, /<a class="row" href="\/discussions\/d1"><span class="dot"[^>]*><\/span><span class="txt">Waiting on you: <b>Postgres or SQLite for shiftboard\?<\/b><\/span><span class="chev"><\/span><\/a>/);
});

test('two or more waiting become one row to their own page', () => {
  const h = forYouCard(forYouRows({ approvals: { count: 2, first: { by: 'ChatGPT', kind: 'profile', action: 'create' } }, discussions: [], suggestions: [] })).value;
  assert.match(h, /<a class="row" href="\/approvals"><span class="dot"[^>]*><\/span><span class="txt">2 changes wait for your approval<\/span>/);
  assert.doesNotMatch(h, /fy-approval|approval-card/);
});

test('needs-you rows carry the orange dot, suggestions none and no black button', () => {
  const h = forYouCard(forYouRows({ approvals: { count: 2, first: null }, discussions: [disc, { id: 'd2', title: 'Second' }], suggestions: [sug('a')] })).value;
  assert.match(h, /<a class="row" href="\/approvals"><span class="dot"[^>]*><\/span><span class="txt">2 changes wait for your approval<\/span>/);
  assert.match(h, /<a class="row" href="\/discussions"><span class="dot"[^>]*><\/span><span class="txt">2 discussions wait on you<\/span>/);
  assert.doesNotMatch(h, /\/review\//, 'the Monday summary is its own card now, not a For you row');
  assert.doesNotMatch(h, /fy-approval/);
});

test('an empty card is not rendered; three needs-you rows show with no fold; one hidden suggestion reads "1 suggestion"', () => {
  assert.equal(forYouCard([]).value, '');
  const many = forYouCard(forYouRows({ approvals: { count: 3, first: null }, discussions: [disc], suggestions: [] })).value;
  assert.doesNotMatch(many, /fy-more/);
  const mixed = forYouCard(forYouRows({ approvals: appr, discussions: [disc], suggestions: [sug('a')] })).value;
  assert.match(mixed, /1 suggestion<span/);
});

test('a suggestion row names its project in bold and offers a quiet pill and Not now, keeping their POSTs', () => {
  const h = forYouCard(forYouRows({ approvals: { count: 0, first: null }, discussions: [], suggestions: [sug('quillbox')] })).value;
  assert.match(h, /<b>quillbox<\/b> has something late: put it on the go\?/);
  assert.match(h, /<form method="post" action="\/projects\/quillbox\/pin"><button type="submit" class="sm">On the go<\/button><\/form>/);
  assert.match(h, /<form method="post" action="\/projects\/quillbox\/snooze"><button type="submit" class="ghost sm">Not now<\/button><\/form>/);
  const two = forYouCard(forYouRows({ approvals: { count: 2, first: null }, discussions: [], suggestions: [] })).value;
  assert.match(two, /2 changes wait for your approval/);
});

test('suggestions always fold behind their one row, even when the card has room for them', () => {
  const h = forYouCard(forYouRows({ approvals: { count: 0, first: null }, discussions: [], suggestions: [sug('tidewatch'), sug('quillbox'), sug('meshnet')] })).value;
  const [shown] = h.split('<li><details class="fold fy-more"');
  assert.equal((shown!.match(/<li>/g) ?? []).length, 0, 'nothing before the fold');
  assert.doesNotMatch(shown!, /tidewatch|quillbox|meshnet/);
  assert.match(h, /<summary class="row nolead">3 suggestions<span class="chev">/);
  const only = forYouCard(forYouRows({ approvals: { count: 0, first: null }, discussions: [], suggestions: [sug('tidewatch')] })).value;
  assert.match(only, /^<ul class="group foryou"[^>]*><li><details class="fold fy-more"><summary class="row nolead">1 suggestion/);
});
