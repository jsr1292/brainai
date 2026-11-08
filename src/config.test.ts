import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DEFAULT_BACKUP_KEEP, DEFAULT_DUPLICATE_THRESHOLD, DEFAULT_MIN_RECALL_SIMILARITY, DEFAULT_RECALL_CONFIDENT_SIMILARITY, DEFAULT_RECALL_WINDOW, loadConfig } from './config.js';

test('loadConfig requires https PUBLIC_URL except localhost', () => {
  assert.throws(() => loadConfig({}));
  assert.throws(() => loadConfig({ PUBLIC_URL: 'http://memory.example.com' }));
  assert.throws(() => loadConfig({ PUBLIC_URL: 'not a url' }));
  assert.equal(loadConfig({ PUBLIC_URL: 'http://localhost:3000' }).port, 3000);
  assert.equal(loadConfig({ PUBLIC_URL: 'https://memory.example.com', PORT: '8080' }).port, 8080);
});

test('loadConfig defaults and overrides', () => {
  const c = loadConfig({ PUBLIC_URL: 'https://memory.example.com' });
  assert.equal(c.publicUrl.href, 'https://memory.example.com/');
  assert.equal(c.dataDir, './data');
  assert.equal(c.modelDir, './models');
  assert.equal(c.port, 3000);
  assert.equal(c.duplicateThreshold, DEFAULT_DUPLICATE_THRESHOLD);
  assert.equal(c.minRecallSimilarity, DEFAULT_MIN_RECALL_SIMILARITY);
  assert.equal(c.recallConfidentSimilarity, DEFAULT_RECALL_CONFIDENT_SIMILARITY);
  assert.equal(c.recallWindow, DEFAULT_RECALL_WINDOW);
  const o = loadConfig({ PUBLIC_URL: 'https://m.example.com', DATA_DIR: '/d', MODEL_DIR: '/m', DUPLICATE_THRESHOLD: '0.8', MIN_RECALL_SIMILARITY: '0.75', RECALL_CONFIDENT_SIMILARITY: '0.9' });
  assert.deepEqual([o.dataDir, o.modelDir, o.duplicateThreshold, o.minRecallSimilarity, o.recallConfidentSimilarity], ['/d', '/m', 0.8, 0.75, 0.9]);
});

test('loadConfig rejects bad PORT, DUPLICATE_THRESHOLD and recall similarities', () => {
  const base = { PUBLIC_URL: 'https://memory.example.com' };
  assert.throws(() => loadConfig({ ...base, PORT: 'abc' }));
  assert.throws(() => loadConfig({ ...base, PORT: '70000' }));
  assert.throws(() => loadConfig({ ...base, DUPLICATE_THRESHOLD: '2' }));
  assert.throws(() => loadConfig({ ...base, DUPLICATE_THRESHOLD: 'x' }));
  assert.throws(() => loadConfig({ ...base, MIN_RECALL_SIMILARITY: '1.5' }), /MIN_RECALL_SIMILARITY/);
  assert.throws(() => loadConfig({ ...base, MIN_RECALL_SIMILARITY: 'x' }), /MIN_RECALL_SIMILARITY/);
  assert.throws(() => loadConfig({ ...base, MIN_RECALL_SIMILARITY: '0' }), /MIN_RECALL_SIMILARITY/);
  assert.throws(() => loadConfig({ ...base, RECALL_CONFIDENT_SIMILARITY: 'x' }), /RECALL_CONFIDENT_SIMILARITY/);
  assert.equal(loadConfig({ ...base, RECALL_WINDOW: '0.03' }).recallWindow, 0.03);
  assert.throws(() => loadConfig({ ...base, RECALL_WINDOW: '-1' }), /RECALL_WINDOW/);
  assert.throws(() => loadConfig({ ...base, MIN_RECALL_SIMILARITY: '0.9', RECALL_CONFIDENT_SIMILARITY: '0.8' }), /RECALL_CONFIDENT_SIMILARITY/);
});

test('loadConfig defaults suit a stranger: this machine only, no tunnel header trusted, no backups (the Docker image and the owner set the rest)', () => {
  const c = loadConfig({ PUBLIC_URL: 'https://memory.example.com' });
  assert.deepEqual([c.mode, c.host, c.trustCfConnectingIp, c.backupDir, c.backupKeep], ['personal', '127.0.0.1', false, null, DEFAULT_BACKUP_KEEP]);
  const tunnel = loadConfig({ PUBLIC_URL: 'https://memory.example.com', HOST: '0.0.0.0', TRUST_CF_CONNECTING_IP: 'true' });
  assert.deepEqual([tunnel.host, tunnel.trustCfConnectingIp], ['0.0.0.0', true]);
});

test('loadConfig work mode listens on the laptop only and ignores the tunnel header', () => {
  const c = loadConfig({ PUBLIC_URL: 'http://localhost:3100', MEMORY_MODE: 'work', BACKUP_DIR: 'C:/Backups', BACKUP_KEEP: '7' });
  assert.deepEqual([c.mode, c.host, c.trustCfConnectingIp, c.backupDir, c.backupKeep], ['work', '127.0.0.1', false, 'C:/Backups', 7]);
  const o = loadConfig({ PUBLIC_URL: 'http://localhost:3100', MEMORY_MODE: 'work', HOST: '0.0.0.0', TRUST_CF_CONNECTING_IP: 'true' });
  assert.deepEqual([o.host, o.trustCfConnectingIp], ['0.0.0.0', true]);
});

test('loadConfig rejects a bad MEMORY_MODE, TRUST_CF_CONNECTING_IP or BACKUP_KEEP', () => {
  const base = { PUBLIC_URL: 'https://memory.example.com' };
  assert.throws(() => loadConfig({ ...base, MEMORY_MODE: 'office' }), /MEMORY_MODE/);
  assert.throws(() => loadConfig({ ...base, TRUST_CF_CONNECTING_IP: 'yes' }), /TRUST_CF_CONNECTING_IP/);
  assert.throws(() => loadConfig({ ...base, BACKUP_KEEP: '0' }), /BACKUP_KEEP/);
});

test('loadConfig reads ASK_COMMANDS: assistant name to a command with {prompt}', () => {
  const base = { PUBLIC_URL: 'https://memory.example.com' };
  assert.deepEqual(loadConfig(base).askCommands, {});
  assert.deepEqual(loadConfig({ ...base, ASK_COMMANDS: '{"Codex":"codex exec \\"{prompt}\\""}' }).askCommands, { Codex: 'codex exec "{prompt}"' });
  assert.throws(() => loadConfig({ ...base, ASK_COMMANDS: 'codex exec' }), /ASK_COMMANDS must be JSON/);
  assert.throws(() => loadConfig({ ...base, ASK_COMMANDS: '["codex"]' }), /ASK_COMMANDS must be JSON/);
  assert.throws(() => loadConfig({ ...base, ASK_COMMANDS: '{"Codex":"codex exec"}' }), /ASK_COMMANDS: the command for Codex must contain \{prompt\}/);
  assert.throws(() => loadConfig({ ...base, ASK_COMMANDS: '{"":"x {prompt}"}' }), /ASK_COMMANDS/);
  assert.throws(() => loadConfig({ ...base, ASK_COMMANDS: '{"--":"x {prompt}"}' }), /ASK_COMMANDS: the name -- needs a letter or digit/);
  assert.throws(() => loadConfig({ ...base, ASK_COMMANDS: '{"Claude Code":"a {prompt}","claude-code":"b {prompt}"}' }), /ASK_COMMANDS: claude-code and Claude Code name the same assistant/);
});

test('the compose file, which publishes no port, trusts the tunnel header for the login limiter (O1 review)', () => {
  const compose = readFileSync(new URL('../docker-compose.yml', import.meta.url), 'utf8');
  assert.doesNotMatch(compose, /^\s*ports:/m);
  assert.match(compose, /- TRUST_CF_CONNECTING_IP=true/);
});

test('LOCAL_MODE runs on this computer only: 127.0.0.1, http://localhost on the same port, no tunnel header', () => {
  const base = { PUBLIC_URL: 'http://localhost:3100', PORT: '3100', LOCAL_MODE: 'true' };
  assert.equal(loadConfig(base).localMode, true);
  assert.equal(loadConfig({ PUBLIC_URL: 'https://m.example.com' }).localMode, false);
  for (const [bad, why] of [
    [{ ...base, HOST: '0.0.0.0' }, /LOCAL_MODE listens on 127\.0\.0\.1 only/],
    [{ ...base, PUBLIC_URL: 'https://m.example.com' }, /LOCAL_MODE needs PUBLIC_URL=http:\/\/localhost:3100/],
    [{ ...base, PUBLIC_URL: 'http://localhost:3000' }, /LOCAL_MODE needs PUBLIC_URL=http:\/\/localhost:3100/],
    [{ ...base, TRUST_CF_CONNECTING_IP: 'true' }, /LOCAL_MODE never trusts cf-connecting-ip/],
    [{ ...base, LOCAL_MODE: 'yes' }, /LOCAL_MODE must be true or false/],
  ] as const) assert.throws(() => loadConfig(bad), why);
});

test('APP_SECRET shorter than 32 characters stops the server', () => {
  assert.throws(() => loadConfig({ PUBLIC_URL: 'https://m.example.com', APP_SECRET: 'short' }), /APP_SECRET must be at least 32 characters/);
  assert.equal(loadConfig({ PUBLIC_URL: 'https://m.example.com', APP_SECRET: 'a'.repeat(32) }).appSecret, 'a'.repeat(32));
  assert.equal(loadConfig({ PUBLIC_URL: 'https://m.example.com' }).appSecret, null);
});

test('loadConfig: recall reranks unless RERANK=off; any other value is refused', () => {
  const base = { PUBLIC_URL: 'https://memory.example.com' };
  assert.equal(loadConfig(base).rerank, true);
  assert.equal(loadConfig({ ...base, RERANK: 'on' }).rerank, true);
  assert.equal(loadConfig({ ...base, RERANK: 'off' }).rerank, false);
  assert.throws(() => loadConfig({ ...base, RERANK: 'maybe' }), /RERANK/);
});
