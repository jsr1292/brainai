import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizePlaces, placeLabel, MAX_PLACES, MAX_PLACE_CHARS, PLACE_LABELS } from './places.js';
import { ProjectError } from './types.js';

test('places are lowercased, hyphenated, deduplicated and checked', () => {
  assert.deepEqual(normalizePlaces('Mini PC, pi ,PI,'), ['mini-pc', 'pi']);
  assert.deepEqual(normalizePlaces(['Mac', 'cloudflare']), ['mac', 'cloudflare']);
  assert.deepEqual(normalizePlaces(''), []);
  assert.throws(() => normalizePlaces('a, b, c, d, e'), /At most 4 places/);
  assert.throws(() => normalizePlaces('x'.repeat(25)), /24 characters/);
  assert.throws(() => normalizePlaces('mini;pc'), /letters, digits/);
  assert.throws(() => normalizePlaces('mini;pc'), (e) => e instanceof ProjectError && e.code === 'invalid');
  assert.equal(MAX_PLACES, 4);
  assert.equal(MAX_PLACE_CHARS, 24);
});

test('known places have fixed labels; any other shows as written', () => {
  assert.equal(placeLabel('minipc'), 'Mini PC');
  assert.equal(placeLabel('acme'), 'acme');
  assert.deepEqual(PLACE_LABELS, { minipc: 'Mini PC', pi: 'Pi', mac: 'Mac', iphone: 'iPhone', cloudflare: 'Cloudflare', nas: 'NAS' });
});
