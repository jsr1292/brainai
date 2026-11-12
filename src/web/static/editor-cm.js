/*
 * The page editor's live-styled CodeMirror (UI round, task 3): the plain text box becomes an editor that styles the
 * markdown as it is typed. The page keeps its <form> and its <textarea name="body">: this module mounts CodeMirror
 * over the textarea, writes every change back into the textarea (so what is saved is exactly what is on the screen),
 * and leaves the plain box in place when anything fails: no script, no modules, an old browser.
 *
 * The editor lives in a shadow root on purpose. The page's policy (default-src 'self') refuses an injected <style>
 * element, and CodeMirror puts its styles in a stylesheet that is adopted, not injected, when its root is a shadow
 * root. The colours are the app's own variables, which inherit into the shadow tree, so dark mode follows.
 *
 * app.js imports this module for an editor form with data-cm and calls setUpEditor.
 */

const CM = '/static/vendor/codemirror-6.43.15/editor.mjs';

/** Two texts are the same when they read the same, whatever the line endings. */
export function isDirty(initial, now) {
  return lines(initial) !== lines(now);
}
const lines = (text) => String(text ?? '').replace(/\r\n/g, '\n');

/** ⌘S (Ctrl-S): save the page. Never with Alt or Shift, never while an IME is composing. */
export function saveShortcut(e) {
  if (!e || e.isComposing) return false;
  if (e.altKey || e.shiftKey) return false;
  if (!(e.metaKey || e.ctrlKey)) return false;
  return String(e.key).toLowerCase() === 's';
}

/** ⌘↵ (Ctrl-↵): save the page and go on. */
export function submitShortcut(e) {
  if (!e || e.isComposing) return false;
  if (e.altKey || e.shiftKey) return false;
  if (!(e.metaKey || e.ctrlKey)) return false;
  return e.key === 'Enter';
}

/** The link marks: [[ and ]] around a page or fact name, dimmed like the other markup. */
const LINK = /\[\[([^\]\n]{1,120})\]\]/g;

/**
 * The editor's own look: the page's font and size, the app's colours, the headings big as they are typed. The
 * colours are variables, so the light and dark themes both read right.
 */
function editorTheme(cm) {
  return {
    '&': {
      fontFamily: 'var(--text)',
      fontSize: 'var(--t-prose)',
      lineHeight: '1.65',
      color: 'var(--fg)',
      backgroundColor: 'transparent',
    },
    '&.cm-focused': { outline: 'none' },
    '.cm-scroller': { fontFamily: 'var(--text)', lineHeight: '1.65' },
    // The room under the last line is larger than the bottom scroll margin (below): CodeMirror treats the margin as
    // out of view and hides the [[ picker there, so the end of the page must never sit in it.
    '.cm-content': { caretColor: 'var(--fg)', padding: '1rem 1.125rem 7.5rem', minHeight: '14rem' },
    '.cm-line': { padding: '0' },
    '.cm-cursor, .cm-dropCursor': { borderLeftWidth: '2px', borderLeftColor: 'var(--fg)' },
    '.cm-selectionBackground': { backgroundColor: 'color-mix(in srgb, var(--primary) 18%, transparent)' },
    '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground': { backgroundColor: 'color-mix(in srgb, var(--primary) 18%, transparent)' },
    '.cm-placeholder': { color: 'var(--muted)' },
    '.cm-gutters': { display: 'none' },
    '.cm-bracket': { color: 'var(--muted)' },
    '.cm-pagelink': { color: 'var(--accent)' },
    // The picker's own look (the mockup's picker): a card of choices under the cursor, each row a kind, a name
    // and where it lives.
    '.cm-tooltip-autocomplete': { border: '1px solid var(--line-strong)', borderRadius: 'var(--r-card)', backgroundColor: 'var(--surface)', boxShadow: 'var(--shadow-pop)', overflow: 'hidden' },
    // CodeMirror's base theme sets the list's font with '.cm-tooltip.cm-tooltip-autocomplete > ul' (monospace): the same
    // selector here, so ours wins.
    '.cm-tooltip.cm-tooltip-autocomplete > ul': { fontFamily: 'var(--text)', fontSize: 'var(--t-sub)', maxHeight: '16rem', padding: '6px' },
    '.cm-tooltip.cm-tooltip-autocomplete > ul > li': { display: 'grid', gridTemplateColumns: '3.2rem minmax(0, 1fr) auto', gap: '10px', alignItems: 'baseline', padding: '7px 10px', borderRadius: 'var(--r-inset)', color: 'var(--fg)' },
    '.cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]': { backgroundColor: 'var(--raised)', color: 'var(--fg)' },
    '.cm-completionIcon': { display: 'block', width: 'auto', paddingRight: '0', opacity: '1', color: 'var(--muted)', fontSize: 'var(--t-label)', fontWeight: '700', textTransform: 'uppercase', letterSpacing: '0.04em' },
    '.cm-completionIcon-page::after': { content: '"Page"' },
    '.cm-completionIcon-fact::after': { content: '"Fact"' },
    '.cm-completionLabel': { fontWeight: '600', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
    '.cm-completionDetail': { color: 'var(--muted)', fontSize: 'var(--t-meta)', fontStyle: 'normal', marginLeft: '0', maxWidth: '12rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  };
}

/** The markdown as it is typed: headings big, words strong or slanted, code in its own face, links in the accent. */
function highlightStyle(cm) {
  return cm.HighlightStyle.define([
    { tag: cm.tags.heading1, fontSize: '1.6em', fontWeight: '700' },
    { tag: cm.tags.heading2, fontSize: '1.3em', fontWeight: '700' },
    { tag: cm.tags.heading3, fontSize: '1.1em', fontWeight: '650' },
    { tag: cm.tags.heading4, fontSize: '1em', fontWeight: '650' },
    { tag: cm.tags.strong, fontWeight: '700' },
    { tag: cm.tags.emphasis, fontStyle: 'italic' },
    { tag: cm.tags.monospace, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '0.9em', backgroundColor: 'var(--raised)' },
    { tag: cm.tags.link, color: 'var(--accent)' },
    { tag: cm.tags.url, color: 'var(--accent)' },
    { tag: cm.tags.processingInstruction, color: 'var(--muted)', fontWeight: '400' },
  ]);
}

/** The [[ ]] marks around a link, dimmed, with the name itself in the accent colour. */
function linkMarks(cm) {
  const bracket = cm.Decoration.mark({ class: 'cm-bracket' });
  const name = cm.Decoration.mark({ class: 'cm-pagelink' });
  return cm.ViewPlugin.fromClass(class {
    constructor(view) { this.marks = this.build(view); }
    build(view) {
      const marks = [];
      for (const { from, to } of view.visibleRanges) {
        const text = view.state.sliceDoc(from, to);
        for (const hit of text.matchAll(LINK)) {
          const start = from + hit.index;
          marks.push(bracket.range(start, start + 2));
          marks.push(name.range(start + 2, start + 2 + hit[1].length));
          marks.push(bracket.range(start + 2 + hit[1].length, start + 2 + hit[1].length + 2));
        }
      }
      return cm.Decoration.set(marks, true);
    }
    update(u) {
      if (u.docChanged || u.viewportChanged) this.marks = this.build(u.view);
    }
  }, { decorations: (plugin) => plugin.marks });
}

/* ---- The [[ link picker (UI round, task 4) ---- */

/** What is before the cursor when the picker should offer something: the [[ and the word after it. */
const LINK_BEFORE = /\[\[([^\]\n]{0,80})$/;

/** The server's answer: the pages and the facts whose names hold the word. */
function linkTargets(q) {
  return fetch(`/pages/link-targets.json?q=${encodeURIComponent(q)}`, { credentials: 'same-origin', headers: { accept: 'application/json' } })
    .then((res) => (res.ok ? res.json() : []))
    .then((items) => (Array.isArray(items) ? items : []))
    .catch(() => []);
}

/** One thing the picker offers: what it is, where it lives, and the text that makes the link. */
function linkOption(item) {
  return {
    label: item.label,
    detail: item.detail,
    type: item.kind,
    /** The text that makes the link: the server has already written it. */
    insert: item.insert,
    // Choosing a thing puts the whole link in, and takes a "]]" that was already there with it.
    apply: (view, completion, from, to) => {
      const closes = view.state.sliceDoc(to, to + 2) === ']]';
      const text = completion.insert;
      view.dispatch({
        changes: { from, to: closes ? to + 2 : to, insert: text },
        selection: { anchor: from + text.length },
        scrollIntoView: true,
      });
    },
  };
}

/**
 * The completion source: it offers what the server has for the word being typed. It asks once, after a pause, so
 * typing does not send a request for every letter.
 */
function linkSource() {
  let timer = null;
  let waiting = [];
  const ask = (q, from) => new Promise((resolve) => {
    waiting.push({ resolve, from });
    if (timer) clearTimeout(timer);
    timer = setTimeout(async () => {
      timer = null;
      const items = await linkTargets(q);
      const asked = waiting;
      waiting = [];
      for (const one of asked) one.resolve({ from: one.from, options: items.map(linkOption), filter: false });
    }, 200);
  });
  return async (context) => {
    const before = context.state.sliceDoc(Math.max(0, context.pos - 100), context.pos);
    const m = LINK_BEFORE.exec(before);
    if (!m) return null;
    const q = m[1];
    if (q.trim().length < 2) return null; // too short to be worth asking about
    return ask(q, context.pos - m[0].length);
  };
}

/**
 * Mounts the editor over the textarea: the textarea is hidden and kept in step with every change, so the form
 * posts exactly what the editor shows. The editor's own handle (insert, focus, getValue) is on the textarea.
 */
export async function mountEditor(textarea) {
  const cm = await import(CM);
  const form = textarea.form;
  const initial = textarea.value;
  const host = document.createElement('div');
  host.className = 'cm-host';
  textarea.after(host);
  const shadow = host.attachShadow({ mode: 'open' });

  let escaped = false;
  const save = () => {
    const button = form?.querySelector('button[name="intent"][value="save"]');
    if (form && button && typeof form.requestSubmit === 'function') form.requestSubmit(button);
    else if (form) form.submit();
    return true;
  };

  const view = new cm.EditorView({
    parent: shadow,
    root: shadow,
    state: cm.EditorState.create({
      doc: initial,
      extensions: [
        // The theme comes first: CodeMirror gives the earliest theme the last word, so ours beats the base one
        // and the picker's own.
        cm.EditorView.theme(editorTheme(cm)),
        cm.EditorView.lineWrapping,
        // The save bar is sticky at the bottom of the window: keep the line being typed above it.
        cm.EditorView.scrollMargins.of(() => ({ bottom: 96, top: 72 })),
        // The box it replaces had the label; screen readers need it on the editor now.
        cm.EditorView.contentAttributes.of({ 'aria-label': textarea.getAttribute('aria-label') || 'Page text' }),
        cm.history(),
        cm.drawSelection(),
        cm.closeBrackets(),
        cm.markdown(),
        cm.syntaxHighlighting(highlightStyle(cm)),
        linkMarks(cm),
        // Typing [[ offers the pages and facts it can point at.
        cm.autocompletion({ override: [linkSource()] }),
        // The second [ opens the picker.
        cm.EditorView.inputHandler.of((view, from, to, text) => {
          if (text !== '[') return false;
          if (view.state.sliceDoc(Math.max(0, from - 1), from) !== '[') return false;
          setTimeout(() => cm.startCompletion(view), 0);
          return false;
        }),
        cm.keymap.of([
          { key: 'Mod-s', run: save },
          { key: 'Mod-Enter', run: save },
          // Escape then Tab leaves the editor; Tab on its own indents.
          { key: 'Escape', run: () => { escaped = true; return false; } },
          {
            key: 'Tab',
            run: (v) => {
              if (escaped) { escaped = false; return false; }
              return cm.indentWithTab.run(v);
            },
            shift: (v) => cm.indentWithTab.shift(v),
          },
          cm.defaultKeymap,
          cm.historyKeymap,
        ]),
        // Every change goes into the textarea, right away: what is saved is what is on the screen.
        cm.EditorView.updateListener.of((u) => {
          if (u.docChanged) textarea.value = u.state.doc.toString();
        }),
      ],
    }),
  });

  textarea.hidden = true;

  const api = {
    /** Puts text in at the cursor, as its own paragraph. */
    insert(text) {
      const { from, to } = view.state.selection.main;
      const doc = view.state.doc;
      const before = doc.sliceString(doc.lineAt(from).from, from);
      const after = doc.sliceString(to, doc.lineAt(to).to);
      const lead = before === '' ? '' : '\n\n';
      const trail = after === '' ? '' : after.startsWith('\n') ? '\n' : '\n\n';
      view.dispatch({
        changes: { from, to, insert: lead + text + trail },
        selection: { anchor: from + lead.length + text.length },
        scrollIntoView: true,
      });
      view.focus();
    },
    focus() { view.focus(); },
    getValue() { return view.state.doc.toString(); },
    /** The editor's own DOM, for the picture handler, which pastes and drops into it. */
    dom: view.contentDOM,
  };
  textarea.editorApi = api;
  // editor-pics.js listens for this to move its paste and drop handlers onto the editor.
  textarea.dispatchEvent(new CustomEvent('cm:ready', { bubbles: true }));
  return api;
}

/** The Area field belongs to a page without a project: it goes when a project is chosen. */
function wireArea(form) {
  const project = form.querySelector('select[name="project"]');
  const area = form.querySelector('[data-area-for-no-project]');
  if (!project || !area) return;
  const field = area.closest('label') || area;
  const sync = () => { field.hidden = project.value !== ''; };
  project.addEventListener('change', sync);
  sync();
}

/**
 * Sets the editor on a form: the live editor over the text box, ⌘S and ⌘↵ to save, and a question before leaving
 * with unsaved changes.
 */
export async function setUpEditor(form) {
  const textarea = form.querySelector('textarea[name="body"][data-editor]');
  if (!textarea) return;
  const title = form.querySelector('input[name="title"]');
  const startText = textarea.value;
  const startTitle = title ? title.value : '';
  let submitting = false;

  try {
    await mountEditor(textarea);
  } catch {
    return; // no CodeMirror (offline, an old browser): the plain box from task 2 stays and works.
  }

  const dirty = () => isDirty(startText, textarea.value) || (title ? title.value !== startTitle : false);

  // Leaving the page asks, but only when there is something to lose.
  window.addEventListener('beforeunload', (e) => {
    if (submitting || !dirty()) return;
    e.preventDefault();
    e.returnValue = '';
  });
  form.addEventListener('submit', () => { submitting = true; });

  // Cancel asks too, in plain words.
  const cancel = form.querySelector('.psavebar a[href]');
  if (cancel) {
    cancel.addEventListener('click', (e) => {
      if (!dirty()) return;
      if (!window.confirm('This page has changes that are not saved. Leave without saving?')) e.preventDefault();
    });
  }

  wireArea(form);
}
