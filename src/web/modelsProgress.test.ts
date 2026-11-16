import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { setComputer } from '../desktop/computer.js';
import type { ModelStatus } from '../models/manager.js';
import { modelsLine, modelsProgress } from './desktopViews.js';

afterEach(() => setComputer('darwin'));

const status = (o: Partial<ModelStatus>): ModelStatus => ({ choice: { search: 'gemma', rerank: 'mminilm' }, progress: [], searchReady: false, ...o });

test('while downloading with a known total, the bar has the whole percent and the text the MB done of the total', () => {
  const p = modelsProgress(status({ progress: [
    { model: 'gemma', doneBytes: 128_400_000, totalBytes: 300_000_000, state: 'downloading' },
    { model: 'mminilm', doneBytes: 0, totalBytes: 100_000_000, state: 'waiting' },
  ] }));
  assert.equal(p.busy, true);
  assert.deepEqual(p.bar, { value: 32 });
  assert.equal(p.text, 'Downloading the search models… 128 of 400 MB · 32% — keyword search already works');
  assert.equal(p.ready, false);
});

test('a download under 10 MB in total shows one decimal', () => {
  const p = modelsProgress(status({ progress: [{ model: 'mminilm', doneBytes: 1_250_000, totalBytes: 4_500_000, state: 'downloading' }] }));
  assert.equal(p.text, 'Downloading the search models… 1.3 of 4.5 MB · 27% — keyword search already works');
  assert.deepEqual(p.bar, { value: 27 });
});

test('getting ready, loading and re-reading show an indeterminate bar (value null)', () => {
  const loading = modelsProgress(status({ progress: [{ model: 'gemma', doneBytes: 5, totalBytes: 5, state: 'done' }] }));
  assert.equal(loading.busy, true);
  assert.deepEqual(loading.bar, { value: null });
  assert.match(loading.text, /^Getting the search models ready/);
  const reread = modelsProgress(status({ searchReady: true, rereading: true }));
  assert.deepEqual(reread.bar, { value: null });
  assert.match(reread.text, /^Re-reading your memories/);
});

test('no bar when ready, failed or nothing is chosen', () => {
  assert.equal(modelsProgress(status({ searchReady: true })).bar, null);
  assert.equal(modelsProgress(status({ problem: 'no connection', problemWith: 'search' })).bar, null);
  assert.equal(modelsProgress(status({ choice: null })).bar, null);
});

test('ready with a passed test search says so, with the time, and is flagged ready', () => {
  const p = modelsProgress(status({ searchReady: true, checked: { ms: 87 } }));
  assert.equal(p.text, 'Search is ready and working: a test search on this Mac took 87 ms.');
  assert.equal(p.ready, true);
  assert.equal(p.busy, false);
  assert.equal(p.failed, false);
});

test('the ready text on Windows says "this computer", never Mac', () => {
  setComputer('win32');
  const p = modelsProgress(status({ searchReady: true, checked: { ms: 87 } }));
  assert.equal(p.text, 'Search is ready and working: a test search on this computer took 87 ms.');
  assert.doesNotMatch(p.text, /Mac/);
});

test('ready without a test search keeps the plain "ready" text, not flagged ready', () => {
  const p = modelsProgress(status({ searchReady: true }));
  assert.equal(p.text, 'The search models are ready.');
  assert.equal(p.ready, false);
});

test('a failed test search is not ready: the problem shows', () => {
  const p = modelsProgress(status({ searchReady: false, problem: 'the search model loaded but a test search on this computer failed: it gave an empty result', problemWith: 'search' }));
  assert.equal(p.ready, false);
  assert.equal(p.failed, true);
  assert.match(p.text, /test search on this computer failed/);
});

test('a failed test search with the new model in use says the test failed, never "works with the model you had"', () => {
  const p = modelsProgress(status({ searchReady: true, problem: 'the search model loaded but a test search on this computer failed: it gave an empty result', problemWith: 'check' }));
  assert.equal(p.ready, false);
  assert.equal(p.failed, true);
  assert.equal(p.text, 'The search models loaded, but a test search on this Mac failed: it gave an empty result. Keyword search still works.');
  setComputer('win32');
  assert.match(modelsProgress(status({ searchReady: true, problem: 'the search model loaded but a test search on this computer failed: x', problemWith: 'check' })).text, /on this computer failed/);
});

test('the line keeps its attributes, puts the text in a span and a determinate progress element after it', () => {
  const out = modelsLine(status({ progress: [{ model: 'gemma', doneBytes: 50_000_000, totalBytes: 100_000_000, state: 'downloading' }] })).value;
  assert.match(out, /role="status"/);
  assert.match(out, /data-models-progress="\/models\/progress"/);
  assert.match(out, / data-busy/);
  assert.match(out, /<span class="models-text">Downloading the search models… 50 of 100 MB · 50%/);
  assert.match(out, /<progress class="models-bar" max="100" value="50" aria-label="Search models download progress"><\/progress>/);
});

test('an indeterminate line has a progress element with no value attribute', () => {
  const out = modelsLine(status({})).value;
  assert.match(out, /<progress class="models-bar" max="100" aria-label="Search models download progress"><\/progress>/);
  assert.doesNotMatch(out, /<progress[^>]* value=/);
});

test('a ready line has no progress element, and shows the check mark with the ok class', () => {
  const out = modelsLine(status({ searchReady: true, checked: { ms: 40 } })).value;
  assert.doesNotMatch(out, /<progress/);
  assert.match(out, /<span class="ok models-ok">✓<\/span>/);
  assert.match(out, /Search is ready and working/);
});

test('a failed line has no progress element and still links to Settings › Search', () => {
  const out = modelsLine(status({ problem: 'no connection' })).value;
  assert.doesNotMatch(out, /<progress/);
  assert.match(out, /href="\/settings#search"/);
});

test('Home shows nothing when ready (only when busy)', () => {
  assert.equal(modelsLine(status({ searchReady: true, checked: { ms: 40 } }), { onlyWhenBusy: true }).value, '');
});
