import { test } from 'node:test';
import assert from 'node:assert/strict';
import { E5_PROFILE, GEMMA_PROFILE, profileFor } from './embeddingProfile.js';

test('profileFor picks the model by EMBED_MODEL and refuses an unknown one', () => {
  assert.equal(profileFor(undefined).id, 'gemma', 'Gemma is the default search model');
  assert.equal(profileFor('e5'), E5_PROFILE);
  assert.equal(profileFor('gemma'), GEMMA_PROFILE);
  assert.equal(profileFor('gemma').dim, 768);
  assert.throws(() => profileFor('bert'), /EMBED_MODEL must be e5 or gemma, got bert/);
});

test('the e5 profile keeps every value the e5 model was tuned with', () => {
  assert.deepEqual(E5_PROFILE, {
    id: 'e5', dim: 384,
    duplicate: 0.93, minRecall: 0.75, window: 0.015, confident: 0.86, closeFacts: 0.86,
    sameProject: 0.88, related: 0.88, threadFloor: 0.87,
    keywordWeight: 0.5, rerankPrior: 0,
  });
});

test('the Gemma profile searches without a window, by meaning first, with the search order as a prior', () => {
  assert.equal(GEMMA_PROFILE.minRecall, 0.3);
  assert.equal(GEMMA_PROFILE.window, undefined);
  assert.equal(GEMMA_PROFILE.keywordWeight, 0);
  assert.equal(GEMMA_PROFILE.rerankPrior, 1);
  assert.ok(GEMMA_PROFILE.confident >= GEMMA_PROFILE.minRecall);
  assert.ok(GEMMA_PROFILE.closeFacts > GEMMA_PROFILE.confident && GEMMA_PROFILE.closeFacts < GEMMA_PROFILE.duplicate, 'close facts sit between recall\'s confident level and duplicates');
});
