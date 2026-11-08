import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Both models and a reranker batch measured at about 840 MB on the mini PC (2026-11-08), before Express, SQLite and
// pages: 1 GB left too little room, and the container was killed under load before batching.
test('docker-compose gives the app at least 1.5 GB of memory', () => {
  const m = /^\s*mem_limit:\s*(\d+)([mg])\s*$/m.exec(readFileSync('docker-compose.yml', 'utf8'));
  assert.ok(m, 'mem_limit is set');
  const mb = Number(m[1]) * (m[2] === 'g' ? 1024 : 1);
  assert.ok(mb >= 1536, `mem_limit is ${m[1]}${m[2]}`);
});
