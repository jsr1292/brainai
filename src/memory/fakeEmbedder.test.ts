import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeEmbedder } from './fakeEmbedder.js';
import { EMBEDDING_DIM, cosine } from './embedder.js';

test('fake embedder: same words → 1, accents and case ignored, unrelated → low', async () => {
  const e = createFakeEmbedder();
  const a = await e.embed('Mini PC runs Ubuntu', 'passage');
  assert.equal(a.length, EMBEDDING_DIM);
  assert.ok(Math.abs(cosine(a, await e.embed('ubuntu runs mini pc', 'query')) - 1) < 1e-6);
  assert.ok(Math.abs(cosine(await e.embed('contraseña', 'passage'), await e.embed('CONTRASENA', 'passage')) - 1) < 1e-6);
  assert.ok(cosine(a, await e.embed('likes short answers', 'passage')) < 0.3);
});
