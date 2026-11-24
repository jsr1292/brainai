/*
 * The page editor's local draft copy: the title and text of an editor, kept on this device so a save that never arrived
 * (the session ended, the server was down, the window restarted) does not lose what was typed. It lives in localStorage
 * and is never sent anywhere; the same origin only. It expires after a day. Pure helpers: the storage is passed in, so
 * they run in node. editor-cm.js writes and offers the copy; app.js clears it on a page the server confirmed.
 */

const PREFIX = 'brain-draft:';
/** A draft older than this is dropped, unread. */
export const DRAFT_TTL_MS = 24 * 60 * 60 * 1000;

/** The storage, or null where it is off or blocked (a private window, cleared site data). */
export function draftStorage() {
  try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; }
}

/** One key per editor: the form's action ("/pages" for a new page, "/pages/<id>" for a page), plus the section's anchor. */
export function draftKey(action, section) {
  return PREFIX + String(action || '') + (section ? '#' + section : '');
}

/** The saved copy for a key, or null: nothing, broken, or expired (an expired one is removed). */
export function readDraft(storage, key, now = Date.now()) {
  if (!storage) return null;
  try {
    const raw = storage.getItem(key);
    if (raw === null || raw === undefined) return null;
    const d = JSON.parse(raw);
    if (!d || typeof d.body !== 'string' || typeof d.title !== 'string' || typeof d.at !== 'number' || now - d.at > DRAFT_TTL_MS) {
      storage.removeItem(key);
      return null;
    }
    return d;
  } catch { return null; }
}

/** Keeps a copy: { title, body, base (the version it was written on), saving (a save was sent and is not confirmed) }. */
export function writeDraft(storage, key, d, now = Date.now()) {
  if (!storage) return;
  try {
    storage.setItem(key, JSON.stringify({ title: String(d.title ?? ''), body: String(d.body ?? ''), base: Number(d.base) || 0, saving: !!d.saving, at: now }));
  } catch { /* storage full or off: the copy is lost, the page works as before */ }
}

export function clearDraft(storage, key) {
  if (!storage) return;
  try { storage.removeItem(key); } catch { /* nothing to do */ }
}

const body = (s) => String(s ?? '').replace(/\r\n/g, '\n');
/** The server trims a title and turns a newline into a space, so "Foo " and "Foo" are the same title. */
const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

/** Whether a stored copy holds something other than what the editor opened with. */
export function differs(d, title, text) {
  return !!d && (body(d.body) !== body(text) || norm(d.title) !== norm(title));
}

/**
 * A page the server confirmed (the reading page after a save): the copies of its editors whose save was sent are done.
 * A save from base N always gives exactly version N+1, written by the owner; anything else (another version, an agent's
 * save) proves nothing about the copy. A new page's copy goes only on the page with its title, at version 1.
 */
export function clearConfirmed(storage, page, version, title, by) {
  if (!storage || !page || by !== 'owner') return;
  try {
    const own = PREFIX + '/pages/' + page;
    const created = PREFIX + '/pages';
    const done = [];
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (key === null || !(key === own || key.startsWith(own + '#') || key === created)) continue;
      let d = null;
      try { d = JSON.parse(storage.getItem(key)); } catch { /* unreadable: leave it */ }
      if (!d || d.saving !== true) continue;
      if (key === created ? Number(version) === 1 && norm(d.title) === norm(title) : Number(version) === Number(d.base) + 1) done.push(key);
    }
    for (const key of done) storage.removeItem(key);
  } catch { /* nothing to do */ }
}

/** Removes every draft copy that is expired or unreadable, or all of them (a logout). Keys are collected first. */
export function sweepDrafts(storage, now = Date.now(), all = false) {
  if (!storage) return;
  try {
    const keys = [];
    for (let i = 0; i < storage.length; i++) { const k = storage.key(i); if (k !== null && k.startsWith(PREFIX)) keys.push(k); }
    for (const k of keys) {
      let drop = all;
      if (!drop) { try { const d = JSON.parse(storage.getItem(k)); drop = !d || typeof d.at !== 'number' || now - d.at > DRAFT_TTL_MS; } catch { drop = true; } }
      if (drop) storage.removeItem(k);
    }
  } catch { /* nothing to do */ }
}
