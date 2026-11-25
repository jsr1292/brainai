import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { E5_PROFILE, GEMMA_PROFILE, profileFor } from './memory/embeddingProfile.js';
import { writeChoice } from './models/choice.js';
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

test('EMBED_MODEL picks the profile whose cut-offs become the defaults; env overrides still win', () => {
  const base = { PUBLIC_URL: 'https://memory.example.com' };
  assert.equal(loadConfig(base).embedModel.id, 'gemma');
  assert.equal(loadConfig({ ...base, EMBED_MODEL: 'e5' }).minRecallSimilarity, 0.75);
  const g = loadConfig({ ...base, EMBED_MODEL: 'gemma' });
  assert.equal(g.embedModel.id, 'gemma');
  assert.equal(g.minRecallSimilarity, 0.3);
  assert.equal(g.recallWindow, undefined);
  assert.equal(loadConfig({ ...base, EMBED_MODEL: 'gemma', MIN_RECALL_SIMILARITY: '0.32' }).minRecallSimilarity, 0.32);
  assert.equal(loadConfig({ ...base, EMBED_MODEL: 'gemma', RECALL_WINDOW: '0.02' }).recallWindow, 0.02);
  assert.throws(() => loadConfig({ ...base, EMBED_MODEL: 'bert' }), /EMBED_MODEL must be e5 or gemma/);
});

test('an e5-tuned floor left in .env stops a Gemma start with a message that says what to do', () => {
  const base = { PUBLIC_URL: 'https://memory.example.com' };
  assert.throws(() => loadConfig({ ...base, MIN_RECALL_SIMILARITY: '0.75' }),
    /MIN_RECALL_SIMILARITY \(0\.75\).*tuned for e5.*remove .*from \.env, or set EMBED_MODEL=e5/s);
  assert.equal(loadConfig({ ...base, EMBED_MODEL: 'e5', MIN_RECALL_SIMILARITY: '0.75' }).minRecallSimilarity, 0.75);
});

test('a search setting left empty (an uncommented line of .env.example) means the model\'s own value', () => {
  const base = { PUBLIC_URL: 'https://memory.example.com' };
  const c = loadConfig({ ...base, DUPLICATE_THRESHOLD: '', MIN_RECALL_SIMILARITY: '', RECALL_WINDOW: '', RECALL_CONFIDENT_SIMILARITY: '' });
  assert.deepEqual([c.duplicateThreshold, c.minRecallSimilarity, c.recallWindow, c.recallConfidentSimilarity], [0.78, 0.3, undefined, 0.35]);
});

test('loadConfig defaults suit a stranger: this machine only, no tunnel header trusted, no backups (the Docker image and the owner set the rest)', () => {
  const c = loadConfig({ PUBLIC_URL: 'https://memory.example.com' });
  assert.deepEqual([c.host, c.trustCfConnectingIp, c.backupDir, c.backupKeep], ['127.0.0.1', false, null, DEFAULT_BACKUP_KEEP]);
  const tunnel = loadConfig({ PUBLIC_URL: 'https://memory.example.com', HOST: '0.0.0.0', TRUST_CF_CONNECTING_IP: 'true' });
  assert.deepEqual([tunnel.host, tunnel.trustCfConnectingIp], ['0.0.0.0', true]);
});

test('BrainAI has one mode: MEMORY_MODE=work stops the start with where the move steps are', () => {
  const base = { PUBLIC_URL: 'http://localhost:3100' };
  assert.throws(() => loadConfig({ ...base, MEMORY_MODE: 'work' }), (e: Error) => e.message.includes('was removed') && e.message.includes('docs/DESKTOP.md'));
  assert.throws(() => loadConfig({ ...base, MEMORY_MODE: 'office' }), /was removed/);
  // Unset or personal loads as before, and the loaded settings carry no mode.
  for (const env of [base, { ...base, MEMORY_MODE: 'personal' }]) {
    const c = loadConfig(env);
    assert.equal('mode' in c, false);
    assert.deepEqual([c.host, c.trustCfConnectingIp], ['127.0.0.1', false]);
  }
  // A backup folder needs no mode.
  const b = loadConfig({ ...base, BACKUP_DIR: 'C:/Backups', BACKUP_KEEP: '7' });
  assert.deepEqual([b.backupDir, b.backupKeep], ['C:/Backups', 7]);
});

test('loadConfig rejects a bad TRUST_CF_CONNECTING_IP or BACKUP_KEEP', () => {
  const base = { PUBLIC_URL: 'https://memory.example.com' };
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

test('the app (LOCAL_MODE) keeps its models in the data folder and takes its search model from models.json', () => {
  const data = mkdtempSync(join(tmpdir(), 'cfg-'));
  const base = { PUBLIC_URL: 'http://localhost:3100', PORT: '3100', LOCAL_MODE: 'true', DATA_DIR: data };
  assert.equal(loadConfig(base).modelDir, join(data, 'models'), 'MODEL_DIR defaults to <data>/models in the app');
  assert.equal(loadConfig({ ...base, MODEL_DIR: '/m' }).modelDir, '/m');
  assert.equal(loadConfig(base).modelChoice, null, 'no models.json yet');
  writeChoice(data, { search: 'e5', rerank: null });
  const c = loadConfig(base);
  assert.deepEqual(c.modelChoice, { search: 'e5', rerank: null });
  assert.equal(c.embedModel.id, 'e5');
  assert.equal(c.duplicateThreshold, profileFor('e5').duplicate, 'the cut-offs are the chosen model\'s');
  // A server (Docker) never reads models.json: EMBED_MODEL and RERANK in .env decide.
  const server = loadConfig({ PUBLIC_URL: 'https://m.example.com', DATA_DIR: data });
  assert.equal(server.modelChoice, null);
  assert.equal(server.embedModel.id, 'gemma');
  assert.equal(server.modelDir, './models');
});

test('OWNER_SAID_WEIGHT: unset means the search model decides (Gemma 1.6, E5 0.8), 0 turns it off, anything that is not a finite number >= 0 is refused', () => {
  const weight = (v?: string) => loadConfig({ PUBLIC_URL: 'http://localhost', OWNER_SAID_WEIGHT: v }).ownerSaidWeight;
  assert.equal(weight(undefined), undefined);
  assert.equal(weight(''), undefined);
  assert.equal(GEMMA_PROFILE.ownerSaidWeight, 1.6);
  assert.equal(E5_PROFILE.ownerSaidWeight, 0.8);
  assert.equal(weight('0'), 0);
  assert.equal(weight('2.4'), 2.4);
  for (const bad of ['-1', 'abc', 'Infinity']) assert.throws(() => weight(bad), new RegExp(`OWNER_SAID_WEIGHT.*got ${bad}`));
});
