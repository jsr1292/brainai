import { test } from 'node:test';
import assert from 'node:assert/strict';
import { looksLikeAssistantSuggestion, MIXED_SOURCE_REASON } from './mixedSource.js';

test('text that carries an assistant suggestion is recognised, in English and Spanish', () => {
  for (const t of [
    'Decision: nightly backups go to B2. I suggest restic with 30-day retention.',
    'We recommend borg for the nightly job',
    'I propose a systemd timer',
    'we could use rclone here',
    'Backups to B2, restic suggested by the assistant',
    'Use restic (recommended by Claude)',
    "Claude's suggestion: keep 30 days",
    "Codex's recommendation is a cron job",
    'Suggestion: use restic',
    'Recommendation: 30-day retention',
    'Los backups van a B2. Te sugiero restic.',
    'Sugerencia: retención de 30 días',
    'Recomiendo usar borg',
    'restic, sugerido por el asistente',
    'Nightly backups go to B2 (decided). Suggested tool: restic with a systemd timer',
    'backups go to B2. Suggested approach (restic, systemd timer) still open',
    'Recommended: restic',
    'Herramienta sugerida: restic',
  ]) assert.ok(looksLikeAssistantSuggestion(t), t);
});

test('the owner\'s own decisions and ordinary text do not match', () => {
  for (const t of [
    'The owner decided to use B2 for nightly backups',
    'owner chose restic',
    'Harbor runs on a Hetzner box in Falkenstein; backups go to Backblaze B2',
    'The owner wants nightly backups and keeps everything on the Hetzner box',
    'Decided: SQLite, not Postgres',
    'The suggestions page lists held saves',
    'Recommended reading list lives in the wiki',
    'El dueño decidió usar B2',
    'Los backups van a Backblaze B2',
    'The owner proposed moving to Hetzner',
    'we could not reach the server on 2026-11-18',
    'Opción sugerido por el dueño: B2',
  ]) assert.equal(looksLikeAssistantSuggestion(t), false, t);
});

test("wording inside the owner's own quoted words is the owner's, not a sign of mixing", () => {
  const quote = 'I suggest we keep everything on the Hetzner box';
  assert.equal(looksLikeAssistantSuggestion(`Harbor: ${quote}.`, quote), false);
  assert.equal(looksLikeAssistantSuggestion(`Harbor: ${quote}. I recommend restic on top.`, quote), true);
  assert.equal(looksLikeAssistantSuggestion(`Harbor: ${quote}.`), true);
});

test('the hold reason is plain', () => {
  assert.equal(MIXED_SOURCE_REASON, "Marked as your words but reads like it includes an assistant's suggestion");
});

test('a short quote never masks a suggestion in the rest of the text', () => {
  assert.equal(looksLikeAssistantSuggestion('We could use restic nightly', 'could'), true);
  assert.equal(looksLikeAssistantSuggestion('I suggest restic. B2 it is', 'suggest'), true);
  assert.equal(looksLikeAssistantSuggestion('I suggest restic', 'I suggest'), true);
  assert.equal(looksLikeAssistantSuggestion('B2 it is, I suggest we keep everything on the Hetzner box', 'I suggest we keep everything on the Hetzner box'), false);
});
