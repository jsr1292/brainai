import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runWithLocale } from '../i18n/core.js';
import { errorText } from '../web/errorText.js';
import { ProjectError } from './types.js';
import { normalizePlaces } from './places.js';

test('a ProjectError shows in Spanish through errorText while .message stays English', () => {
  let err: unknown;
  try { normalizePlaces(['a', 'b', 'c', 'd', 'e']); } catch (e) { err = e; }
  assert.ok(err instanceof ProjectError);
  assert.equal(err.message, 'At most 4 places');
  assert.equal(runWithLocale('es', () => errorText(err)), 'Como máximo 4 lugares');
  assert.equal(runWithLocale('en', () => errorText(err)), 'At most 4 places');
});
