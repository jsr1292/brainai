/** What Settings calls the device you are on: never "This Mac" on a Windows computer. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { thisDevice } from './settingsViews.js';

test('thisDevice names a Windows computer "This computer", and keeps the Mac, iPhone and iPad names', () => {
  assert.equal(thisDevice('Windows · Edge'), 'This computer');
  assert.equal(thisDevice('Mac · Chrome'), 'This Mac');
  assert.equal(thisDevice('iPhone · Safari'), 'This iPhone');
  assert.equal(thisDevice('iPad · Safari'), 'This iPad');
  assert.equal(thisDevice('Linux · Firefox'), 'This device');
});
