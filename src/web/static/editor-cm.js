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

const T = typeof globalThis.T === 'function' ? globalThis.T : (key, english, params) => { const s = english !== undefined ? english : key; return params ? s.replace(/\{(\w+)\}/g, (m, n) => (Object.prototype.hasOwnProperty.call(params, n) ? String(params[n]) : m)) : s; };

import { draftKey, draftStorage, readDraft, writeDraft, clearDraft, differs, sweepDrafts } from './draft.js';

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
        cm.EditorView.contentAttributes.of({ 'aria-label': textarea.getAttribute('aria-label') || T('client.editor.pageText', 'Page text') }),
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
          if (u.docChanged) {
            textarea.value = u.state.doc.toString();
            textarea.dispatchEvent(new CustomEvent('cm:change'));
          }
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
    /** Replaces the whole text (a saved draft put back). */
    setValue(text) { view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: String(text) } }); },
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
  const title = form.querySelector('[name="title"]');
  const startText = textarea.value;
  const startTitle = title ? title.value : '';

  // The title is a one-line field that wraps (a long name is shown whole): Enter saves, as it did when this was an input (not
  // while an IME is composing), a newline never gets in, and the box grows with its text where the browser has no field-sizing.
  if (title && title.tagName === 'TEXTAREA') {
    const sizing = typeof CSS !== 'undefined' && CSS.supports('field-sizing', 'content');
    const grow = () => { title.style.height = 'auto'; title.style.height = title.scrollHeight + 'px'; };
    title.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || e.isComposing || e.keyCode === 229) return;
      e.preventDefault();
      const save = form.querySelector('button[name="intent"][value="save"]');
      if (typeof form.requestSubmit === 'function') form.requestSubmit(save ?? undefined); else form.submit();
    });
    title.addEventListener('input', () => {
      if (/[\r\n]/.test(title.value)) {
        const at = title.selectionStart;
        title.value = title.value.replace(/\s*[\r\n]+\s*/g, ' ');
        if (typeof at === 'number') title.setSelectionRange(at, at);
      }
      if (!sizing) grow();
    });
    if (!sizing) {
      grow();
      window.addEventListener('resize', grow);
      if (document.fonts && document.fonts.ready) document.fonts.ready.then(grow);
    }
  }

  try {
    await mountEditor(textarea);
  } catch {
    return; // no CodeMirror (offline, an old browser): the plain box from task 2 stays and works.
  }

  editorGuard(form, textarea, title, {
    win: window, doc: document, storage: draftStorage(), now: () => Date.now(), startText, startTitle,
    fromPost: document.body.dataset.fresh === 'off', confirm: (m) => window.confirm(m),
  });

  wireArea(form);
}

/** "14:02", or the day and time for a copy from another day. */
function draftTime(at, doc, now) {
  const lang = (doc.documentElement && doc.documentElement.lang) || undefined;
  const d = new Date(at);
  const today = new Date(now);
  const sameDay = d.getFullYear() === today.getFullYear() && d.getMonth() === today.getMonth() && d.getDate() === today.getDate();
  try {
    return sameDay ? d.toLocaleTimeString(lang, { hour: '2-digit', minute: '2-digit' }) : d.toLocaleString(lang, { weekday: 'short', hour: '2-digit', minute: '2-digit' });
  } catch { return d.toISOString().slice(11, 16); }
}

/**
 * What keeps the editor's text safe, with the DOM and storage passed in (so it runs in node):
 * - a question before leaving with unsaved text (the window closing, or Cancel). A page the server sent back after a
 *   Preview, a refused save or a conflict (data-fresh="off") starts out as unsaved: its text is a draft only it has;
 * - one submit at a time: the pressed button shows it is busy and a second send does nothing (for 10 s, then it lets go);
 * - a draft copy on this device (draft.js), written as you type and when you send, cleared once the server confirmed the
 *   save (app.js, on the page it lands on) and offered back, in place, when the editor opens and the copy differs.
 */
export function editorGuard(form, textarea, title, env) {
  const { win, doc, storage, now, startText, startTitle, fromPost, confirm } = env;
  sweepDrafts(storage, now());
  // A runtime mark for app.js's global post guard: this form is guarded here, so that guard leaves it alone (without CodeMirror it has no mark and is covered there).
  if (form.dataset) form.dataset.guarded = '1';
  const action = form.getAttribute('action') || '';
  const sectionField = form.querySelector('input[name="section"]');
  const key = draftKey(action, sectionField ? sectionField.value : '');
  const baseField = form.querySelector('input[name="base"]');
  let base = baseField ? Number(baseField.value) || 0 : 0;
  let submitting = false;
  let sentAt = 0;
  let busy = null;
  let offered = false;
  let leaving = false;
  /** A repeat send is stopped for this long; after it the lock lets go (a stopped navigation never fires pageshow). */
  const LOCK_MS = 10000;
  const locked = () => submitting && now() - sentAt <= LOCK_MS;

  const titleNow = () => (title ? title.value : '');
  const dirty = () => fromPost || isDirty(startText, textarea.value) || titleNow() !== startTitle;
  const keep = (saving) => writeDraft(storage, key, { title: titleNow(), body: textarea.value, base, saving }, now());

  // Typing keeps the copy up to date (after a short pause), unless the offered copy has not been answered yet.
  let timer = null;
  const later = () => {
    if (offered || locked() || leaving) return;
    win.clearTimeout(timer);
    timer = win.setTimeout(() => {
      if (offered || locked() || leaving) return;
      if (dirty()) keep(false); else clearDraft(storage, key);
    }, 400);
  };
  textarea.addEventListener('cm:change', later);
  textarea.addEventListener('input', later);
  if (title) title.addEventListener('input', later);
  win.addEventListener('pagehide', () => { if (!offered && !locked() && !leaving && dirty()) { win.clearTimeout(timer); keep(false); } });

  // The offer: a copy from before (a save that never arrived) that differs from what the editor opened with.
  const found = readDraft(storage, key, now());
  if (differs(found, titleNow(), textarea.value)) {
    offered = true;
    // A page drawn from a POST is the server saying nothing was saved: the copy is not "sent" any more.
    if (fromPost && found.saving) writeDraft(storage, key, { ...found, saving: false }, found.at);
    const line = doc.createElement('p');
    line.className = 'draft-line';
    line.setAttribute('role', 'status');
    const note = doc.createElement('span');
    note.textContent = T('client.draft.line', 'You have unsaved text from {time}.', { time: draftTime(found.at, doc, now()) }) + ' ';
    const put = doc.createElement('button');
    put.type = 'button';
    put.className = 'quiet-btn';
    put.textContent = T('client.draft.restore', 'Put it back');
    const drop = doc.createElement('button');
    drop.type = 'button';
    drop.className = 'quiet-btn';
    drop.textContent = T('client.draft.discard', 'Discard');
    line.append(note, put, doc.createTextNode(' \u00b7 '), drop);
    const anchor = form.querySelector('section.ed');
    if (anchor && typeof anchor.before === 'function') anchor.before(line); else form.prepend(line);
    put.addEventListener('click', () => {
      offered = false;
      // The text was written on an older version: send that version, so a page saved since answers with the conflict screen.
      // (On a page drawn from a POST the owner has already seen both texts: keep its base, or it would loop on the conflict.)
      if (!fromPost && baseField && found.base && found.base !== base) { baseField.value = String(found.base); base = found.base; }
      if (title) { title.value = found.title; title.dispatchEvent(new Event('input')); }
      if (textarea.editorApi && typeof textarea.editorApi.setValue === 'function') textarea.editorApi.setValue(found.body); else textarea.value = found.body;
      line.remove();
      keep(false);
      if (textarea.editorApi) textarea.editorApi.focus();
    });
    drop.addEventListener('click', () => {
      offered = false;
      clearDraft(storage, key);
      line.remove();
      if (textarea.editorApi) textarea.editorApi.focus();
    });
  } else if (fromPost) {
    keep(false); // a Preview, a refused save or a conflict: the text on this page is a draft only this page has
  }

  // Leaving the page asks, but only when there is something to lose.
  win.addEventListener('beforeunload', (e) => {
    if (leaving || locked() || !dirty()) return;
    e.preventDefault();
    e.returnValue = '';
  });

  // Leaving on purpose (a confirmed Cancel, "Discard mine"): no second question, and the text is not kept.
  // An offered copy nobody answered stays: only Discard throws it away.
  const leave = (force) => { leaving = true; win.clearTimeout(timer); if (force === true || !offered) clearDraft(storage, key); };

  // One submit at a time. The copy is written as the form goes; a save that the server confirms clears it (app.js).
  form.addEventListener('submit', (e) => {
    if (locked()) { e.preventDefault(); return; }
    submitting = true;
    sentAt = now();
    win.clearTimeout(timer);
    // ⌘S and Enter in the title send with the hidden Save button: the busy state goes on the one that is shown.
    const shown = form.querySelector('.psavebar button[name="intent"][value="save"]');
    const sub = e.submitter;
    busy = sub && !(sub.classList && sub.classList.contains('visually-hidden')) ? sub : shown || sub || null;
    if (busy) busy.setAttribute('aria-busy', 'true');
    const intent = sub && sub.value ? sub.value : 'save';
    keep(intent === 'save');
  });
  // Back to this page from a failed send (the page kept in memory): the form can be sent again.
  win.addEventListener('pageshow', () => {
    submitting = false;
    if (busy) { busy.removeAttribute('aria-busy'); busy = null; }
  });

  // Cancel asks too, in plain words.
  const cancel = form.querySelector('.psavebar a[href]');
  if (cancel) {
    cancel.addEventListener('click', (e) => {
      if (dirty() && !confirm(T('client.editor.leave', 'This page has changes that are not saved. Leave without saving?'))) { e.preventDefault(); return; }
      leave(false);
    });
  }
  // The conflict page's "Discard mine" is a choice already made: it leaves without a question.
  const discardMine = doc.querySelector ? doc.querySelector('.conflict .actions a[href]') : null;
  if (discardMine) discardMine.addEventListener('click', () => leave(true));
  return { dirty, key };
}
