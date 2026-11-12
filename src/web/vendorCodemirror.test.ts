/*
 * The page editor's CodeMirror 6 (UI round, task 1): one committed bundle under static/vendor, made by
 * scripts/vendor-codemirror.sh from dev-only dependencies, like the vendored Mermaid. This locks the properties
 * the browser path relies on: one self-contained file (no imports of bare specifiers, so no CDN, no import maps),
 * a sane size, the licence beside it, and the editor API the page editor imports.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { CODEMIRROR_EDITOR } from './vendor.js';

/** Every name scripts/vendor/codemirror-entry.mjs re-exports: the page editor's whole CodeMirror API. */
const EXPORTS = ['EditorView', 'EditorState', 'EditorSelection', 'keymap', 'history', 'historyKeymap', 'defaultKeymap', 'indentWithTab',
  'markdown', 'markdownLanguage', 'syntaxHighlighting', 'HighlightStyle', 'tags', 'autocompletion', 'startCompletion', 'closeBrackets',
  'placeholder', 'drawSelection', 'Decoration', 'ViewPlugin'];

test('the CodeMirror editor is one committed, self-contained bundle with its licence', () => {
  assert.match(CODEMIRROR_EDITOR, /^\/static\/vendor\/codemirror-\d+\.\d+\.\d+\/editor\.mjs$/, 'a versioned vendor path');
  const file = new URL(`./static${CODEMIRROR_EDITOR.replace(/^\/static/, '')}`, import.meta.url);
  assert.ok(existsSync(file), `committed at src/web/static${CODEMIRROR_EDITOR}`);
  const bytes = statSync(file).size;
  assert.ok(bytes < 600_000, `under 600,000 bytes (was ${bytes})`);
  const text = readFileSync(file, 'utf8');
  // No import statements at all (esbuild bundled everything in). The plan's bare `from "…"` scan matches string
  // content inside the library (CSS keyword lists, snippet templates), so the check anchors on statement syntax;
  // the module load in the test below is what really proves no bare specifier survives bundling.
  assert.doesNotMatch(text, /(?:^|[;{}\s])import\s*(?:["'{]|type\b)/, 'no import statements');
  const licence = readFileSync(new URL('./LICENSE', file), 'utf8');
  assert.match(licence, /MIT/);
});

test('the bundle loads as a module and exports the editor API', async () => {
  // Node resolves the whole graph: an import of a bare specifier (a node_modules name or node: URL) fails here.
  const file = new URL(`./static${CODEMIRROR_EDITOR.replace(/^\/static/, '')}`, import.meta.url);
  const m = await import(file.href);
  for (const name of EXPORTS) assert.ok((m as Record<string, unknown>)[name], `exports ${name}`);
});
