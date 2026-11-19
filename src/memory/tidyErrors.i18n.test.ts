import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runWithLocale } from '../i18n/core.js';
import { errorText } from '../web/errorText.js';
import { TidyError } from './tidyService.js';
import { errTidy } from '../i18n/en/errTidy.js';

test('a TidyError shows in Spanish through errorText while its message stays English', () => {
  const e = new TidyError('not_found', 'No such tidy proposal.', { key: 'err.tidy.noProposal' });
  assert.equal(e.message, 'No such tidy proposal.');
  assert.equal(runWithLocale('es', () => errorText(e)), 'No existe esa propuesta de orden.');
  assert.equal(runWithLocale('en', () => errorText(e)), 'No such tidy proposal.');
  assert.equal(errorText(new TidyError('invalid', 'plain')), 'plain');
  assert.equal(errTidy['err.tidy.noProposal'], e.message);
});
