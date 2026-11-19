import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runWithLocale } from '../i18n/core.js';
import { MemoryError } from '../memory/service.js';
import { checkFile, FileRefused } from '../import/fileUpload.js';
import { errorText } from './errorText.js';

test('a discussions MemoryError shows in Spanish, its message stays English', () => {
  const e = new MemoryError('not_found', 'No discussion with id "d1".', undefined, { key: 'err.disc.notFound', params: { id: 'd1' } });
  assert.equal(runWithLocale('es', () => errorText(e)), 'No hay ningún debate con el id "d1".');
  assert.equal(runWithLocale('en', () => errorText(e)), 'No discussion with id "d1".');
  assert.equal(e.message, 'No discussion with id "d1".');
});

test('a refused file shows in Spanish, its message stays English', () => {
  let err: unknown;
  try { checkFile('a.pdf', Buffer.from('x')); } catch (e) { err = e; }
  assert.ok(err instanceof FileRefused);
  assert.equal(runWithLocale('es', () => errorText(err)), 'Los archivos PDF aún no son compatibles. Por ahora guárdalo como .txt o .md.');
  assert.equal((err as Error).message, 'PDF files are not supported yet. Save it as .txt or .md for now.');
});
