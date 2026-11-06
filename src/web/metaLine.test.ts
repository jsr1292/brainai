/** Meta lines: one list item per part, so a wrapped line never starts with a separator dot. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { html } from './html.js';
import { metaLine } from './metaLine.js';
import { stripProjectPrefix } from './stripProject.js';

test('a meta line is one list item per part, empty parts dropped, no whitespace nodes', () => {
  assert.equal(metaLine(['you', null, html`<time datetime="x">yesterday</time>`, false]).value, '<ul class="meta-line"><li>you</li><li><time datetime="x">yesterday</time></li></ul>');
  assert.equal(metaLine([null]).value, '');
  assert.equal(metaLine(['a'], { big: true }).value, '<ul class="meta-line big"><li>a</li></ul>');
});

test('stripProjectPrefix', () => {
  assert.equal(stripProjectPrefix('wildlog: uses SQLite', 'wildlog'), 'uses SQLite');
  assert.equal(stripProjectPrefix('Wildlog status: 1.4 out', 'wildlog'), '1.4 out');
  assert.equal(stripProjectPrefix('wildlog:', 'wildlog'), 'wildlog:');
  assert.equal(stripProjectPrefix('wildlogx: other', 'wildlog'), 'wildlogx: other');
});
