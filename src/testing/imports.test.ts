import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(import.meta.dirname, '..');

test('test files import Node built-ins at the top, never inline with await import', () => {
  const offenders = (readdirSync(SRC, { recursive: true }) as string[])
    .filter((f) => f.endsWith('.test.ts'))
    .flatMap((f) => readFileSync(join(SRC, f), 'utf8').split('\n').map((line, i) => [f, i + 1, line] as const))
    .filter(([, , line]) => /await import\(['"]node:/.test(line))
    .map(([f, n]) => `${f}:${n}`);
  assert.deepEqual(offenders, []);
});
