import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { openDb } from '../db.js';
import { UploadLinks } from './uploadLinks.js';

function setup() {
  let ms = Date.parse('2026-11-05T12:00:00Z');
  const db = openDb(':memory:');
  db.prepare(`INSERT INTO pages(id, title, title_key, project, area, body, version, created_at, created_by, updated_at, updated_by, caught_up_at, caught_up_how, caught_up_by)
    VALUES ('P', 'P', 'p', NULL, 'apps', 'b', 1, 'now', 'o', 'now', 'o', 'now', 'created', 'o')`).run();
  return { db, links: new UploadLinks(db, () => new Date(ms)), advance: (n: number) => { ms += n; } };
}

test('an upload link is a one-use, ten-minute token stored only as its hash', () => {
  const { db, links, advance } = setup();
  const token = links.create({ grantId: 'g1', pageId: 'P', alt: 'A label', title: null, by: 'Claude Code' });
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  const rows = db.prepare('SELECT token_hash, grant_id, page_id, alt, created_by, expires_at FROM image_upload_links').all() as Record<string, string>[];
  assert.equal(rows.length, 1);
  assert.notEqual(rows[0]!.token_hash, token);
  assert.equal(rows[0]!.token_hash, createHash('sha256').update(token).digest('hex'));
  assert.equal(rows[0]!.expires_at, '2026-11-05T12:10:00.000Z');
  const row = links.take(token)!;
  assert.deepEqual([row.grantId, row.pageId, row.alt, row.title, row.by], ['g1', 'P', 'A label', null, 'Claude Code']);
  links.markUsed(row.tokenHash, 'img1');
  assert.equal(links.take(token), undefined, 'used');
  const later = links.create({ grantId: 'g1', pageId: 'P', alt: 'x', title: 't', by: 'x' });
  advance(10 * 60_000 + 1);
  assert.equal(links.take(later), undefined, 'expired');
  assert.equal(links.take('not-a-token'), undefined);
});
