/*
 * editor-cm.js, the page editor's live-styled CodeMirror (UI round, task 3): its pure helpers run here in node; the
 * page part is guarded by `typeof document`, so importing it has no side effects.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CODEMIRROR_EDITOR } from './vendor.js';

const m = await import(new URL('./static/editor-cm.js', import.meta.url).href);
const source = readFileSync(new URL('./static/editor-cm.js', import.meta.url), 'utf8');

test('the editor counts as changed only when the words differ, whatever the line endings', () => {
  assert.equal(m.isDirty('a\r\nb', 'a\nb'), false);
  assert.equal(m.isDirty('a', 'a '), true);
  assert.equal(m.isDirty('same', 'same'), false);
  assert.equal(m.isDirty('', ''), false);
  assert.equal(m.isDirty('a\r\nb', 'a\nc'), true);
});

test('⌘S saves the page, and nothing else does', () => {
  assert.equal(m.saveShortcut({ key: 's', metaKey: true }), true);
  assert.equal(m.saveShortcut({ key: 's', ctrlKey: true }), true);
  assert.equal(m.saveShortcut({ key: 'S', metaKey: true }), true);
  assert.equal(m.saveShortcut({ key: 's', metaKey: true, altKey: true }), false);
  assert.equal(m.saveShortcut({ key: 's', metaKey: true, shiftKey: true }), false);
  assert.equal(m.saveShortcut({ key: 's', metaKey: true, isComposing: true }), false);
  assert.equal(m.saveShortcut({ key: 's' }), false);
  assert.equal(m.saveShortcut({ key: 'a', metaKey: true }), false);
});

test('⌘↵ saves the page too, and never while an IME is composing', () => {
  assert.equal(m.submitShortcut({ key: 'Enter', metaKey: true }), true);
  assert.equal(m.submitShortcut({ key: 'Enter', ctrlKey: true }), true);
  assert.equal(m.submitShortcut({ key: 'Enter', metaKey: true, altKey: true }), false);
  assert.equal(m.submitShortcut({ key: 'Enter', metaKey: true, isComposing: true }), false);
  assert.equal(m.submitShortcut({ key: 'Enter' }), false);
});

test('importing the module does nothing on its own', () => {
  // The import above ran in node, where there is no document: a module that touched one at the top level would
  // have thrown before this test.
  assert.equal(typeof m.mountEditor, 'function');
  assert.equal(typeof m.setUpEditor, 'function');
  assert.doesNotMatch(source, /^(document|window)\./m, 'no document or window at the top level');
});

test('the module loads the committed CodeMirror bundle, not a CDN', () => {
  assert.ok(source.includes(CODEMIRROR_EDITOR), `editor-cm.js loads ${CODEMIRROR_EDITOR}`);
  assert.doesNotMatch(source, /https?:\/\/(?!localhost)/, 'no outside address');
});
