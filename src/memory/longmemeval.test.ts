import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeService } from '../testing/helpers.js';
import { benchQuestion, categoryOf, checkLmePinned, factsOf, lmeDate, parseLongMemEval, rankResults, scoreLme, splitText, stratified } from './longmemeval.js';

// Made up, in the shape of LongMemEval's longmemeval_s_cleaned.json (Wu et al.): never the real data.
const FIXTURE = JSON.stringify([
  {
    question_id: 'q1', question_type: 'multi-session', question: 'What is the name of the cat adopted by the user?', question_date: '2023/06/01 (Thu) 10:00',
    answer: 'Pixel', answer_session_ids: ['answer_a'],
    haystack_session_ids: ['noise_1', 'answer_a'], haystack_dates: ['2023/05/01 (Mon) 09:00', '2023/05/20 (Sat) 02:21'],
    haystack_sessions: [
      [{ role: 'user', content: 'Give me a recipe for lentil soup.' }, { role: 'assistant', content: 'Boil lentils with onion and carrot.' }],
      [{ role: 'user', content: 'I adopted a grey cat called Pixel last week.', has_answer: true }, { role: 'assistant', content: 'Lovely, congratulations. ' + 'Cats like routine. '.repeat(80) }],
    ],
  },
  {
    question_id: 'q2_abs', question_type: 'single-session-user', question: 'Which violin teacher does the user have?', question_date: '2023/06/01 (Thu) 10:00',
    answer: 'not mentioned', answer_session_ids: ['answer_b_abs'],
    haystack_session_ids: ['answer_b_abs'], haystack_dates: ['2023/05/02 (Tue) 08:00'],
    haystack_sessions: [[{ role: 'user', content: 'I started learning the piano.', has_answer: true }]],
  },
]);

test('parseLongMemEval reads the questions, sessions and answer labels; abstention questions are their own category', () => {
  const qs = parseLongMemEval(FIXTURE);
  assert.equal(qs.length, 2);
  assert.deepEqual(qs[0]!.answerSessions, ['answer_a']);
  assert.equal(qs[0]!.sessions[1]![0]!.hasAnswer, true);
  assert.equal(qs[0]!.sessions[0]![0]!.hasAnswer, false);
  assert.deepEqual(qs.map(categoryOf), ['multi-session', 'abstention']);
  assert.throws(() => parseLongMemEval('[{"a":1}]'), /not the LongMemEval data/);
});

test('factsOf saves one fact per turn with speaker and date, and cuts a long turn into pieces of at most 1000 characters that keep the labels', () => {
  const facts = factsOf(parseLongMemEval(FIXTURE)[0]!);
  assert.equal(facts[0]!.text, 'User on 2023/05/01 (Mon) 09:00: Give me a recipe for lentil soup.');
  assert.ok(facts.every((f) => f.text.length <= 1000));
  const long = facts.filter((f) => f.sessionId === 'answer_a' && f.turn === 1);
  assert.ok(long.length >= 2, 'the long assistant turn is split');
  assert.ok(long.every((f) => f.text.startsWith('Assistant on 2023/05/20 (Sat) 02:21: ') && !f.hasAnswer));
  assert.equal(facts.find((f) => f.hasAnswer)!.sessionId, 'answer_a');
  assert.equal(splitText('a b c', 100).length, 1);
  assert.ok(splitText('word '.repeat(50), 40).every((p) => p.length <= 40));
});

test('rankResults gives the first answer session, the first answer turn, and where every answer session is covered', () => {
  const f = (sessionId: string, hasAnswer = false) => ({ text: '', sessionId, turn: 0, hasAnswer, date: '' });
  const hits = [f('x'), f('a'), undefined, f('a', true), f('b')];
  assert.deepEqual(rankResults(hits, ['a', 'b']), { rank: 2, turnRank: 4, allRank: 5 });
  assert.deepEqual(rankResults(hits, ['z']), { rank: null, turnRank: 4, allRank: null });
});

test('scoreLme counts hits at 1, 8 and 20 per category and the weak and empty rates', () => {
  const r = (id: string, category: string, rank: number | null, weak = false, empty = false) => ({ id, category, rank, turnRank: rank, allRank: rank, weak, empty, facts: 1 });
  const s = scoreLme([r('1', 'multi-session', 1), r('2', 'multi-session', 9, true), r('3', 'abstention', null, true), r('4', 'abstention', null, false, true)]);
  assert.equal(s.byCategory['multi-session']!.hit1, 0.5);
  assert.equal(s.byCategory['multi-session']!.hit8, 0.5);
  assert.equal(s.byCategory['multi-session']!.hit20, 1);
  assert.equal(s.byCategory['abstention']!.weak, 0.5);
  assert.equal(s.byCategory['abstention']!.empty, 0.5);
  assert.equal(s.overall.questions, 4);
  assert.ok(Math.abs(s.overall.mrr - (1 + 1 / 9) / 4) < 1e-9);
});

test('benchQuestion saves the turns in a fresh brain, recalls the question and finds the answer session', async () => {
  const { service } = makeService();
  const [q1, q2] = parseLongMemEval(FIXTURE);
  const r = await benchQuestion(q1!, service, { limit: 8, weakBelow: -4 });
  assert.equal(r.category, 'multi-session');
  // the fake embedder matches words, so the long assistant turn about cats may come first; the answer session is among the first two
  assert.ok(r.rank !== null && r.rank <= 2);
  assert.ok(r.turnRank !== null && r.turnRank <= 3);
  assert.equal(r.allRank, r.rank);
  assert.ok(r.facts >= 5 && r.unsaved === 0);
  const { service: fresh } = makeService();
  const a = await benchQuestion(q2!, fresh, { limit: 8, weakBelow: -4 });
  assert.equal(a.category, 'abstention');
  assert.equal(a.facts, 1);
});

test('stratified takes n per category, spread through the file; dates and the pinned hash are checked', () => {
  const qs = parseLongMemEval(JSON.stringify(Array.from({ length: 10 }, (_, i) => ({ question_id: `q${i}`, question_type: 'multi-session', question: '', answer_session_ids: [], haystack_session_ids: [], haystack_dates: [], haystack_sessions: [] }))));
  assert.deepEqual(stratified(qs, 3).map((q) => q.id), ['q0', 'q3', 'q6']);
  assert.equal(lmeDate('2023/05/20 (Sat) 02:21')!.toISOString(), '2023-05-20T02:21:00.000Z');
  assert.equal(lmeDate('nonsense'), null);
  assert.throws(() => checkLmePinned(new Uint8Array([1, 2, 3])), /does not match the pinned version/);
});
