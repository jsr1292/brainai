import { test } from 'node:test';
import assert from 'node:assert/strict';
import { E5_PROFILE, GEMMA_PROFILE, type EmbeddingProfile } from '../memory/embeddingProfile.js';
import { activeCutOffs, memoryCutOffs } from './cutOffs.js';

/** Configured for Gemma with two .env overrides, as loadConfig gives them. */
const config = { embedModel: GEMMA_PROFILE, duplicateThreshold: 0.8, minRecallSimilarity: 0.31, recallConfidentSimilarity: GEMMA_PROFILE.confident, recallWindow: GEMMA_PROFILE.window };

test('the cut-offs in force are the active model\'s; the .env overrides count only while it is the configured model', () => {
  let active: EmbeddingProfile | null = null;
  const cut = activeCutOffs(config, () => active);
  assert.deepEqual([cut().id, cut().duplicate, cut().minRecall], ['gemma', 0.8, 0.31], 'no model yet: the configured one, overrides applied');
  active = GEMMA_PROFILE;
  assert.equal(cut().duplicate, 0.8);
  active = E5_PROFILE;
  assert.equal(cut(), E5_PROFILE, 'tuned for Gemma, the overrides would be wrong for e5');
  assert.equal(cut(), cut(), 'the same object each time: no allocation per comparison');
});

test('memoryCutOffs reads the active cut-offs at each use', () => {
  let active: EmbeddingProfile = E5_PROFILE;
  const o = memoryCutOffs(() => active, {});
  assert.deepEqual([o.duplicateThreshold, o.minRecallSimilarity, o.recallConfidentSimilarity, o.recallWindow, o.keywordWeight, o.rerankPrior, o.closeFacts], [0.93, 0.75, 0.86, 0.015, 0.5, 0, 0.86]);
  active = GEMMA_PROFILE;
  assert.deepEqual([o.duplicateThreshold, o.minRecallSimilarity, o.recallWindow, o.keywordWeight, o.rerankPrior], [0.78, 0.3, undefined, 0, 1]);
});
