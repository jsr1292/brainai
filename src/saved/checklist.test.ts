/** The checklist of what BrainAI could not remove, and the web-app names it starts from. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../db.js';
import { checklist, webAppNames } from './checklist.js';

test('checklist for a server lists web apps, pasted text, tunnel, alert, key, left tools, then kept lines', () => {
  const lines = checklist({
    install: 'server',
    webApps: ['Claude', 'ChatGPT', 'Pocket Agent'],
    tunnel: { hostname: 'brain.example.test', deleted: false },
    leftTools: [{ name: 'Codex', reason: 'its settings file is in use' }],
    kept: ['Keep the Mac folder ~/wildlog'],
  });
  assert.deepEqual(lines, [
    'Claude (claude.ai and the phone app): Settings › Connectors › BrainAI › Remove',
    'ChatGPT: Settings › Apps & Connectors › BrainAI › Delete',
    'Pocket Agent: remove BrainAI from its connector or MCP settings',
    "The text you pasted into each app's instructions to use BrainAI",
    'Cloudflare: delete the tunnel and the public address brain.example.test (Zero Trust › Networks › Tunnels)',
    'Your uptime alert, if you set one up',
    'The off-site key on your own computer (memory-offsite-key.txt), once you no longer need the Google Drive copies',
    'Codex: its settings file is in use',
    'Keep the Mac folder ~/wildlog',
  ]);
});

test('checklist for the app leaves the tunnel out once it is deleted, and has no server lines', () => {
  const lines = checklist({ install: 'app', webApps: ['Grok'], tunnel: { hostname: 'x.example.test', deleted: true }, leftTools: [], kept: [] });
  assert.deepEqual(lines, ['Grok: Settings › Connectors › BrainAI › Remove', "The text you pasted into each app's instructions to use BrainAI"]);
  const open = checklist({ install: 'app', webApps: [], tunnel: { hostname: 'x.example.test', deleted: false }, leftTools: [], kept: [] });
  assert.ok(open.some((l) => l.startsWith('Cloudflare: delete the tunnel and the public address x.example.test')));
});

test('webAppNames gives each connected app once and leaves out revoked grants', () => {
  const db = openDb(':memory:');
  const client = (id: string, name: string) => db.prepare("INSERT INTO oauth_clients(client_id, client_name, metadata, is_cimd, created_at) VALUES (?, ?, ?, 0, 'x')").run(id, name, JSON.stringify({ client_id: id, client_name: name, redirect_uris: ['https://a.example.test/cb'] }));
  const grant = (id: string, c: string, at: string, revoked: string | null) => db.prepare('INSERT INTO oauth_grants(id, client_id, created_at, revoked_at) VALUES (?, ?, ?, ?)').run(id, c, at, revoked);
  client('c1', 'Claude'); client('c2', 'Pocket Agent'); client('c3', 'Old Thing');
  grant('g1', 'c1', '2026-01-01', null); grant('g2', 'c1', '2026-02-01', null);
  grant('g3', 'c2', '2026-03-01', null); grant('g4', 'c3', '2026-03-02', '2026-04-01');
  assert.deepEqual(webAppNames(db).sort(), ['Claude', 'Pocket Agent']);
  db.close();
});
