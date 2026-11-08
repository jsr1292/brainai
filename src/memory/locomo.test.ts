import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeService } from '../testing/helpers.js';
import { createHash } from 'node:crypto';
import { benchConversation, CATEGORY_NAMES, checkPinned, parseLocomo, scoreRecall } from './locomo.js';

// Made up, in the shape of LoCoMo's locomo10.json (snap-research/locomo): never the real data.
const FIXTURE = JSON.stringify([{
  sample_id: 'demo-1',
  conversation: {
    speaker_a: 'Ana', speaker_b: 'Ben',
    session_1_date_time: '1:56 pm on 8 May, 2023',
    session_1: [
      { speaker: 'Ana', dia_id: 'D1:1', text: 'I adopted a grey cat called Pixel last week.' },
      { speaker: 'Ben', dia_id: 'D1:2', text: 'Lovely! I started learning the violin.' },
      { speaker: 'Ana', dia_id: 'D1:3', text: 'Look at this', img_url: ['x'], blip_caption: 'a photo of a grey cat on a sofa' },
    ],
    session_2_date_time: '10:00 am on 20 May, 2023',
    session_2: [{ speaker: 'Ben', dia_id: 'D2:1', text: 'My violin teacher lives in Porto.' }],
  },
  qa: [
    { question: 'What is the name of the cat Ana adopted?', answer: 'Pixel', evidence: ['D1:1'], category: 4 },
    { question: 'Where does the violin teacher of Ben live?', answer: 'Porto', evidence: ['D2:1', 'D1:2'], category: 1 },
    { question: 'What instrument did Ana learn?', answer: 'none', evidence: [], category: 5, adversarial_answer: 'violin' },
    { question: 'When did Ana adopt the cat?', answer: 'May 2023', evidence: [' D1: 1 '], category: 2 },
    { question: 'What has no evidence?', answer: 'x', evidence: [], category: 3 },
  ],
}]);

test('parseLocomo reads sessions in order with their dates, photo captions and every question', () => {
  const [c] = parseLocomo(FIXTURE);
  assert.equal(c!.id, 'demo-1');
  assert.deepEqual(c!.turns.map((t) => t.diaId), ['D1:1', 'D1:2', 'D1:3', 'D2:1']);
  assert.equal(c!.turns[0]!.text, 'Ana on 8 May, 2023: I adopted a grey cat called Pixel last week.');
  assert.equal(c!.turns[2]!.text, 'Ana on 8 May, 2023: Look at this [shares a photo: a photo of a grey cat on a sofa]');
  assert.equal(c!.qa.length, 5);
  assert.deepEqual(c!.qa[3]!.evidence, ['D1:1']); // spaces in an evidence id are dropped
});

test('parseLocomo refuses something that is not LoCoMo', () => {
  assert.throws(() => parseLocomo('{}'), /not the LoCoMo/);
  assert.throws(() => parseLocomo('nope'), /not valid JSON/);
});

test('scoreRecall counts hits at 1, 5 and 10 and the mean reciprocal rank, overall and by category', () => {
  const s = scoreRecall([
    { category: 4, rank: 1 }, { category: 4, rank: 3 }, { category: 4, rank: null },
    { category: 1, rank: 7 },
  ]);
  assert.deepEqual(s.overall, { questions: 4, hit1: 0.25, hit5: 0.5, hit10: 0.75, mrr: (1 + 1 / 3 + 0 + 1 / 7) / 4 });
  assert.equal(s.byCategory[4]!.questions, 3);
  assert.equal(s.byCategory[1]!.hit10, 1);
  assert.equal(CATEGORY_NAMES[4], 'single-hop');
});

test('benchConversation saves every turn, recalls each answerable question, and skips the adversarial and evidence-less ones', async () => {
  const [c] = parseLocomo(FIXTURE);
  const { service } = makeService();
  const r = await benchConversation(c!, service);
  assert.equal(r.saved, 4);
  assert.deepEqual(r.skipped, { adversarial: 1, noEvidence: 1, unsaved: 0 });
  assert.equal(r.results.length, 3);
  assert.equal(r.results[0]!.rank, 1); // the cat's name: its turn first
  assert.ok(r.results.every((x) => x.rank === null || (x.rank >= 1 && x.rank <= 10)));
});

test('a download that is not the pinned version is refused', () => {
  const bytes = new TextEncoder().encode(FIXTURE);
  const sha = createHash('sha256').update(bytes).digest('hex');
  assert.doesNotThrow(() => checkPinned(bytes, sha));
  assert.throws(() => checkPinned(new TextEncoder().encode(FIXTURE + ' '), sha), /does not match the pinned version/);
});
