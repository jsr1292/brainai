import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLocalReranker, WEAK_SCORE, type Reranker } from './reranker.js';

const enabled = process.env.RUN_MODEL_TESTS === '1';
let shared: Promise<Reranker> | undefined;
const model = () => (shared ??= createLocalReranker({ modelDir: process.env.MODEL_DIR ?? './models', allowRemote: true }));

const FACTS = [
  'The owner\'s devices: an Apple-silicon Mac, an iPhone 12 Pro and an iPad Pro.',
  'Backups run nightly at 03:30 to two disks.',
  'casa uses SQLite for storage.',
];

test('the reranker puts the fact that answers the question above unrelated ones', { skip: !enabled }, async () => {
  const s = await (await model()).score('which phone does the owner have?', FACTS);
  assert.equal(s.length, 3);
  assert.ok(s[0]! > s[1]! && s[0]! > s[2]!, `scores ${s.join(', ')}`);
});

test('the reranker matches a Spanish question to an English fact', { skip: !enabled }, async () => {
  const facts = ['The second SSD is mounted at /mnt/ssd.', 'The NAS is mounted at /mnt/nas over a direct cable.', 'Lives in Berlin.'];
  const s = await (await model()).score('¿dónde está montado el NAS?', facts);
  assert.ok(s[1]! > s[0]! && s[1]! > s[2]!, `scores ${s.join(', ')}`);
});

test('the reranker scores nothing when given nothing', { skip: !enabled }, async () => {
  assert.deepEqual(await (await model()).score('anything', []), []);
});

test('a gibberish question scores below WEAK_SCORE against every fact, a real one above it', { skip: !enabled }, async () => {
  const r = await model();
  for (const q of ['zxqv blorp', 'asdf qwer zxcv']) {
    const best = Math.max(...await r.score(q, FACTS));
    assert.ok(best < WEAK_SCORE, `${q}: best ${best}`);
  }
  assert.ok(Math.max(...await r.score('which phone does the owner have?', FACTS)) >= WEAK_SCORE);
});
