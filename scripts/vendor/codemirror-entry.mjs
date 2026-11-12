// The page editor's CodeMirror 6 entry (UI round, task 1): re-exports only, no app logic. scripts/vendor-codemirror.sh
// bundles this into one committed ES module the browser loads as /static/vendor/codemirror-<version>/editor.mjs,
// so CodeMirror stays a dev-only dependency and no page ever imports a bare specifier.

export { EditorView, keymap, placeholder, drawSelection, Decoration, ViewPlugin } from '@codemirror/view';
export { EditorState, EditorSelection } from '@codemirror/state';
export { history, historyKeymap, defaultKeymap, indentWithTab } from '@codemirror/commands';
export { markdown, markdownLanguage } from '@codemirror/lang-markdown';
export { syntaxHighlighting, HighlightStyle } from '@codemirror/language';
export { tags } from '@lezer/highlight';
export { autocompletion, startCompletion, closeBrackets } from '@codemirror/autocomplete';
