// T(key, english): the page's text in the owner's language, from static/i18n.js (loaded before this file); a page without it reads English.
const T = typeof globalThis.T === 'function' ? globalThis.T : (key, english, params) => { const s = english !== undefined ? english : key; return params ? s.replace(/\{(\w+)\}/g, (m, n) => (Object.prototype.hasOwnProperty.call(params, n) ? String(params[n]) : m)) : s; };

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

// An old /settings#… bookmark names a screen that moved: send it to that screen's new home. On any page, a #hash
// naming a <details> (such as /#notyet) opens it — the fragment never reaches the server, so only the page can.
const MOVED = { approvals: '/approvals', activity: '/review/now#latest', growth: '/growth', tidy: '/facts/tidy', facts: '/facts', moved: '/pages/moved' };
if (typeof location !== 'undefined' && location.pathname !== undefined) {
  const hash = (location.hash || '').slice(1);
  if (location.pathname === '/settings' && Object.prototype.hasOwnProperty.call(MOVED, hash)) {
    location.replace(MOVED[hash]);
  } else if (hash && typeof document.getElementById === 'function') {
    const target = document.getElementById(hash);
    if (target && String(target.tagName).toUpperCase() === 'DETAILS') target.open = true;
  }
}

// Desktop only (D1): the folds the wide layout shows open (data-desk-open="", or "xl" from 1920 px) are opened here,
// synchronously, so they are open in the first frame; when the window narrows, app.js closes what it opened. It never
// touches a fold it did not open, nor one the owner closed while wide. Below 1100 px it does nothing.
if (typeof matchMedia === 'function' && typeof document.querySelectorAll === 'function') {
  const folds = [...document.querySelectorAll('details[data-desk-open]')];
  if (folds.length > 0) {
    const wide = matchMedia('(min-width: 1100px)'), xl = matchMedia('(min-width: 1920px)');
    const mine = new Set(); // opened by app.js
    const left = new Set(); // closed by the owner while wide: kept closed until the window goes narrow
    const expected = new Map(); // the state app.js just set: its toggle event is not the owner's
    const want = (d) => wide.matches && (d.dataset.deskOpen === '' || (d.dataset.deskOpen === 'xl' && xl.matches));
    const set = (d, open) => { expected.set(d, open); d.open = open; };
    const sync = () => {
      if (!wide.matches) left.clear();
      for (const d of folds) {
        if (want(d)) { if (!d.open && !left.has(d)) { set(d, true); mine.add(d); } }
        else if (mine.has(d)) { mine.delete(d); if (d.open) set(d, false); }
      }
    };
    for (const d of folds) {
      d.addEventListener('toggle', () => {
        const ours = expected.has(d) && expected.get(d) === d.open;
        expected.delete(d);
        if (ours) return;
        // The owner's own toggle: app.js lets go of the fold, and keeps a closed one closed while wide.
        mine.delete(d);
        if (d.open) left.delete(d); else if (wide.matches) left.add(d);
      });
    }
    sync();
    for (const q of [wide, xl]) if (typeof q.addEventListener === 'function') q.addEventListener('change', sync);
  }
}

// Desktop only (D2): desk.js adds the keys, the sheet beside the list and This Mac. It is imported only when the window
// is 1100 px or wider, at load or the first time it widens, so a phone never downloads it. Its URL (fingerprinted) is
// on <body data-desk>; a failed import leaves every link and form working as on any other width.
if (typeof matchMedia === 'function' && document.body && document.body.dataset && document.body.dataset.desk) {
  const deskUrl = document.body.dataset.desk;
  const wideDesk = matchMedia('(min-width: 1100px)');
  let deskLoaded = false;
  const loadDesk = () => {
    if (deskLoaded) return;
    deskLoaded = true;
    try { import(deskUrl).catch(() => {}); } catch { /* no module loader: the page works without it */ }
  };
  if (wideDesk.matches) loadDesk();
  else if (typeof wideDesk.addEventListener === 'function') {
    const onWiden = (e) => {
      if (!e.matches) return;
      if (typeof wideDesk.removeEventListener === 'function') wideDesk.removeEventListener('change', onWiden);
      loadDesk();
    };
    wideDesk.addEventListener('change', onWiden);
  }
}

// The phone's search row: with the keyboard up, a tap on Cancel or a search pointer must not lose to the field's
// blur (the keyboard would close and the tap land nowhere), so pointerdown keeps the focus until the click arrives;
// Cancel's click is what finally blurs the field. html.js says script ran, so CSS can draw Cancel only when it works.
if (document.documentElement && document.documentElement.classList) document.documentElement.classList.add('js');
document.addEventListener('pointerdown', (e) => {
  if (!(e.target instanceof Element)) return;
  if (e.target.closest('.find-cancel, .find-hints a')) e.preventDefault();
});
document.addEventListener('click', (e) => {
  if (!(e.target instanceof Element) || !e.target.closest('.find-cancel')) return;
  const search = document.querySelector('.find input');
  if (search && typeof search.blur === 'function') search.blur();
});

// Times keep the server's words (one date language: "12 min ago", "yesterday", "26 Oct"); the tooltip gets the full
// date in the viewer's own time zone. A calendar date (class "day", such as a due date) stays as written.
for (const t of document.querySelectorAll('time[datetime]:not(.day)')) {
  const date = new Date(t.dateTime);
  if (Number.isNaN(date.getTime())) continue;
  const tag = T.lang === 'es' ? 'es-ES' : T.lang && T.lang !== 'en' ? T.lang : 'en-GB';
  try { t.title = date.toLocaleString(tag, { dateStyle: 'full', timeStyle: 'short' }); } catch { t.title = date.toLocaleString('en-GB', { dateStyle: 'full', timeStyle: 'short' }); }
}

// Keep the contents rail aligned with the section the reader has reached.
if (typeof IntersectionObserver !== 'undefined') {
  const links = [...document.querySelectorAll('.toc a[href^="#"]')];
  if (links.length) {
    const byHeading = new Map();
    for (const link of links) {
      // By id, not querySelector: an anchor may start with a digit (#2026-plan), which is not a valid CSS selector
      // and would throw, stopping the rest of this script.
      const heading = document.getElementById(link.getAttribute('href').slice(1));
      if (heading) byHeading.set(heading, link);
    }
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        for (const link of links) link.removeAttribute('aria-current');
        byHeading.get(entry.target)?.setAttribute('aria-current', 'true');
      }
    }, { rootMargin: '-64px 0px -70% 0px' });
    for (const heading of byHeading.keys()) observer.observe(heading);
  }
}

// "Copy" buttons on a discussion: copy the request to paste into an assistant, and say so for two seconds.
// A screen reader does not announce a button's text changing, so the same words go to a hidden status message too.
// The region is on the page before any copy, or the first message may not be read out.
let copyStatus = null;
function copyStatusRegion() {
  if (!copyStatus) {
    copyStatus = document.createElement('p');
    copyStatus.className = 'visually-hidden';
    copyStatus.setAttribute('role', 'status');
    document.body.append(copyStatus);
  }
  return copyStatus;
}
if (document.querySelector('button[data-copy]')) copyStatusRegion();
document.addEventListener('click', (e) => {
  const button = e.target instanceof Element ? e.target.closest('button[data-copy]') : null;
  if (!button) return;
  // The original markup, kept once: some buttons hold more than text (Continue in Claude Code shows the command).
  const original = button.dataset.original ?? button.innerHTML;
  button.dataset.original = original;
  const say = (shown, spoken) => {
    const status = copyStatusRegion();
    button.textContent = shown;
    status.textContent = spoken;
    clearTimeout(Number(button.dataset.timer));
    // Cleared with the button, so the next copy is a change and is read out again.
    button.dataset.timer = String(setTimeout(() => { button.innerHTML = original; status.textContent = ''; }, 2000));
  };
  // Inside a promise, so a missing clipboard (a page not served over HTTPS) lands in the failure branch too.
  Promise.resolve().then(() => navigator.clipboard.writeText(button.dataset.copy)).then(
    () => say(T('copy.done', 'Copied'), T('copy.done', 'Copied')),
    () => {
      say(T('copy.failed', 'Could not copy'), T('copy.failedSpoken', 'Could not copy. The text is selected in a box after the button: copy it from there.'));
      showToCopy(button);
    },
  );
});
// The text may be on the page nowhere else (a discussion's request), so a failed copy shows it in a read-only box
// after the button, selected, to copy by hand. A second failure reuses the box.
function showToCopy(button) {
  let box = button.nextElementSibling;
  if (!box || box.className !== 'copy-fallback') {
    box = document.createElement('input');
    box.type = 'text';
    box.readOnly = true;
    box.className = 'copy-fallback';
    box.setAttribute('aria-label', T('copy.boxLabel', 'Text to copy'));
    button.after(box);
  }
  box.value = button.dataset.copy;
  box.focus();
  box.select();
  box.setSelectionRange(0, box.value.length);
}

// ⌘K (Ctrl+K off the Mac) jumps to the search field in view from any screen, unless you are typing somewhere: the
// header's on the phone, the sidebar's on the desktop (where the header is hidden).
document.addEventListener('keydown', (e) => {
  if (e.key.toLowerCase() !== 'k' || !(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
  const target = e.target instanceof Element ? e.target : null;
  if (target && target.closest('input, textarea, select, [contenteditable]')) return;
  const search = [...document.querySelectorAll('form[role="search"] input[name="q"]')].find((f) => f.getClientRects().length > 0);
  if (!search) return;
  e.preventDefault();
  search.focus();
  search.select();
});

// Fresh on return: the installed app, opened again after more than two minutes away, loads its page anew in place
// (a same-URL replace: it cross-fades and adds no history entry, where a reload would flash blank), keeping the scroll.
// Never over a focused or edited field, a draft or a page drawn from a form POST, never offline.
// The hash goes: the same URL plus a fragment would only jump.
const scrollKey = (url) => `scroll:${url}`;
// On a wide window the page does not scroll: the sheet and the list panes do (desk.css). The place is the window's
// scroll plus each of those panes' scrollTop, found by a stable selector. It is stored as a plain number when only the
// window scrolled (the old format, still read) and as JSON {y, p:{selector: top}} otherwise.
const SCROLL_PANES = ['#desk-sheet', '.desk-list', '.plist', '.ppanel', '.inbox-list', '.inbox-pane'];
const paneAt = (sel) => (document.querySelector ? document.querySelector(sel) : null);
// Settings: content above a section (the added-tools line in Connections) arrives later and would shift a bare scrollTop,
// so the sheet's place is the section at its top (the one the index marks) and where that section's top sits.
const settingsAnchor = () => {
  const sheet = paneAt('#desk-sheet');
  if (!sheet || !sheet.dataset || sheet.dataset.kind !== 'settings' || !sheet.querySelectorAll) return null;
  const top = sheet.getBoundingClientRect().top;
  let pick = null;
  for (const sec of sheet.querySelectorAll('.desk-main > section[id]')) {
    const d = sec.getBoundingClientRect().top - top;
    if (!pick || d <= 80) pick = { id: sec.id, d: Math.round(d) }; else break;
  }
  return pick;
};
const savePlace = () => {
  const p = {};
  for (const sel of SCROLL_PANES) {
    const pane = paneAt(sel);
    if (pane && pane.scrollTop > 0) p[sel] = Math.round(pane.scrollTop);
  }
  const a = settingsAnchor();
  if (a) delete p['#desk-sheet'];
  return Object.keys(p).length || a ? JSON.stringify({ y: scrollY, p, ...(a ? { a } : {}) }) : String(scrollY);
};
const readPlace = (saved) => {
  try {
    const v = JSON.parse(saved);
    if (typeof v === 'number') return { y: v, p: {}, a: null };
    if (v && typeof v === 'object') return { y: Number(v.y) || 0, p: v.p && typeof v.p === 'object' ? v.p : {}, a: v.a && typeof v.a.id === 'string' ? { id: v.a.id, d: Number(v.a.d) || 0 } : null };
  } catch { /* not JSON: fall through */ }
  return { y: Number(saved) || 0, p: {}, a: null };
};
// The panes are put back for up to 3 s: desk.js builds them after load ('desk:ready', also after its async mounts) and
// content arrives later still, so a pane is applied again whenever its content height changes. It stops at the first
// touch, wheel, key or press (the reader has taken over) and at the time limit, and a place left over is dropped, so it
// can never land on a later desk set-up. One chain of frames runs at a time.
const RESTORE_MS = 3000;
const nowMs = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());
const TAKEOVER = ['wheel', 'touchstart', 'keydown', 'pointerdown'];
let pending = null;
let applied = {};
let chain = false;
const stopRestore = () => {
  pending = null; applied = {}; chain = false;
  if (typeof document.removeEventListener === 'function') for (const t of TAKEOVER) document.removeEventListener(t, stopRestore, true);
};
const applyPane = (sel, want) => {
  const pane = paneAt(sel);
  if (!pane) return;
  const h = Number(pane.scrollHeight) || 0;
  if (applied[sel] === h) return; // nothing changed since the last apply
  applied[sel] = h;
  const a = sel === '#desk-sheet' ? pending.a : null;
  const sec = a && document.getElementById ? document.getElementById(a.id) : null;
  if (sec && pane.contains(sec)) pane.scrollTop += sec.getBoundingClientRect().top - pane.getBoundingClientRect().top - a.d;
  else pane.scrollTop = want;
};
const applyAll = () => {
  for (const sel of Object.keys(pending.p)) applyPane(sel, Number(pending.p[sel]) || 0);
  if (pending.a && !('#desk-sheet' in pending.p)) applyPane('#desk-sheet', 0);
};
const restorePanes = () => {
  if (!pending) return;
  // The limit holds here too: a hidden window runs no frames, so a late desk:ready must not apply an old place.
  if (nowMs() > pending.until) { stopRestore(); return; }
  applyAll();
  if (chain || typeof requestAnimationFrame !== 'function') return;
  chain = true;
  if (typeof document.addEventListener === 'function') for (const t of TAKEOVER) document.addEventListener(t, stopRestore, { capture: true, passive: true });
  const tick = () => {
    if (!pending) { chain = false; return; }
    if (nowMs() > pending.until) { stopRestore(); return; }
    applyAll();
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
};
if (typeof addEventListener === 'function') {
  addEventListener('pageshow', () => {
    const key = scrollKey(location.href.split('#')[0]);
    let saved = null;
    try { saved = sessionStorage.getItem(key); sessionStorage.removeItem(key); } catch { /* storage off */ }
    if (saved === null) return;
    const place = readPlace(saved);
    const before = history.scrollRestoration;
    history.scrollRestoration = 'manual';
    scrollTo(0, place.y);
    history.scrollRestoration = before;
    if (!Object.keys(place.p).length && !place.a) return;
    pending = { p: { ...place.p }, a: place.a, until: nowMs() + RESTORE_MS };
    applied = {};
    restorePanes();
  });
}
// desk.js says when its panes are built or filled (it is imported after load): the place held back goes in then.
document.addEventListener('desk:ready', () => restorePanes());
const installed = (typeof matchMedia === 'function' && matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true;
const AWAY_MS = 120000;
let hiddenAt = null;
const edited = (f) => (f.type === 'checkbox' || f.type === 'radio' ? f.checked !== f.defaultChecked
  : f.tagName === 'SELECT' ? [...f.options].some((o) => o.selected !== o.defaultSelected)
  : f.value !== f.defaultValue);
if (installed) {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') { hiddenAt = Date.now(); return; }
    const was = hiddenAt;
    hiddenAt = null;
    if (was === null || Date.now() - was <= AWAY_MS || !navigator.onLine) return;
    const active = document.activeElement;
    if (active && active.matches && active.matches('input, textarea, select, [contenteditable]')) return;
    for (const f of document.querySelectorAll('input, textarea, select')) if (edited(f)) return;
    // A page drawn from a form POST (preview, refused note, conflict) puts the draft back as the field's own text,
    // so it never looks edited: the server marks it, and any textarea holding text is kept as it is.
    if (document.body && document.body.dataset.fresh === 'off') return;
    for (const t of document.querySelectorAll('textarea')) if (t.value.trim() !== '') return;
    const url = location.href.split('#')[0];
    try { sessionStorage.setItem(scrollKey(url), savePlace()); } catch { /* storage off: the place is lost, the page is fresh */ }
    location.replace(url);
  });
}

// A picture opens full size in viewer.js (round 2 section 12), imported on the first tap from the URL on the nearest
// [data-viewer] (a page, a preview, or a page desk.js showed beside its list). If the module can't load, the link
// opens the picture's file as it would without script.
document.addEventListener('click', (e) => {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  const link = e.target && e.target.closest ? e.target.closest('a.pic') : null;
  const holder = link && link.closest('[data-viewer]');
  if (!holder) return;
  e.preventDefault();
  try {
    import(holder.dataset.viewer).then((m) => m.openViewer(link), () => { location.href = link.href; });
  } catch { location.href = link.href; }
});

// The editor's pictures (round 2 section 12): editor-pics.js shows the Add picture button and handles the file
// input, paste and drop. Without it (no modules, or the import fails) the editor works as before, without pictures.
for (const form of document.querySelectorAll('form.peditor[data-pics]')) {
  try { import(form.dataset.pics).then((m) => m.setUpEditor(form), () => {}); } catch { /* no module loader */ }
}

// The page editor's live-styled CodeMirror (UI round, task 3): editor-cm.js mounts the editor over the text box,
// keeps the box in step with it, and adds ⌘S. Without it (no modules, or the import fails) the plain text box from
// task 2 stays and works.
for (const form of document.querySelectorAll('form.peditor[data-cm]')) {
  try { import(form.dataset.cm).then((m) => m.setUpEditor(form), () => {}); } catch { /* no module loader */ }
}

// Diagrams (round 2 section 12): diagrams.js draws the page's ```mermaid blocks as they scroll into view. Without
// it (no modules, or the import fails) each diagram stays as its text.
for (const holder of document.querySelectorAll('[data-diagrams]')) {
  try { import(holder.dataset.diagrams).then((m) => m.setUpDiagrams(holder), () => {}); } catch { /* no module loader */ }
}

// The Facts filters apply as you change them (UI round, task 6): a select goes at once, the search box waits for a
// pause in typing. The Show button stays in the markup for the path without script; with script on, style.css hides it.
// Listened for on the document, so the desk's list pane (drawn after this ran) filters the same way.
let filterTimer = null;
const filterGo = (form) => { if (filterTimer !== null) { clearTimeout(filterTimer); filterTimer = null; } form.submit(); };
document.addEventListener('change', (e) => { const f = e.target instanceof HTMLSelectElement ? e.target.closest('form.frow-filters') : null; if (f) filterGo(f); });
document.addEventListener('input', (e) => {
  const f = e.target instanceof HTMLInputElement && e.target.type === 'search' ? e.target.closest('form.frow-filters') : null;
  if (!f) return;
  if (filterTimer !== null) clearTimeout(filterTimer);
  filterTimer = setTimeout(() => filterGo(f), 300);
});
// After a search the box keeps the caret, at the end of what is there.
for (const search of document.querySelectorAll('form.frow-filters input[type="search"]')) {
  if (search.value === '') continue;
  search.focus();
  try { search.setSelectionRange(search.value.length, search.value.length); } catch { /* not a text field */ }
}

// One logout (round 2 section 12): the drawn diagrams kept in IndexedDB go before the logout form posts (the server
// also sends Clear-Site-Data), and on the login page always, in case the login ended on another device.
const dropKept = () => new Promise((resolve) => {
  try {
    const r = indexedDB.deleteDatabase('brain');
    r.onsuccess = r.onerror = r.onblocked = () => resolve();
  } catch { resolve(); }
  setTimeout(resolve, 1000);
});
for (const form of (typeof indexedDB !== 'undefined' ? document.querySelectorAll('form[action="/logout"]') : [])) {
  form.addEventListener('submit', (e) => {
    if (form.dataset.dropped === '1') return;
    e.preventDefault();
    dropKept().then(() => { form.dataset.dropped = '1'; form.submit(); });
  });
}
if (typeof location !== 'undefined' && location.pathname === '/login' && typeof indexedDB !== 'undefined') dropKept();

// Guided setup (round 2 §17b): a setup page's check line refreshes itself while the page is open.
for (const line of document.querySelectorAll('[data-setup-status]')) {
  setInterval(async () => {
    if (document.hidden) return;
    try {
      // An expired login redirects to the login page: keep the line as it is rather than show that page in it.
      const r = await fetch(line.dataset.setupStatus, { headers: { accept: 'text/html' }, credentials: 'same-origin', redirect: 'manual' });
      if (r.ok && !r.redirected) line.innerHTML = await r.text();
    } catch { /* offline for a moment: the next tick tries again */ }
  }, 10_000);
}

// Reach, step 3: the Tailscale check is a small request of its own (the page never waits for Tailscale); Check again asks afresh.
for (const box of document.querySelectorAll('[data-reach-tailscale]')) {
  const note = (text) => Object.assign(document.createElement('p'), { className: 'meta', textContent: text });
  const check = async (fresh) => {
    box.replaceChildren(note(T('client.reach.checking', 'Checking Tailscale…')));
    try {
      // An expired login redirects to the login page: say so rather than show that page in the box.
      const r = await fetch(box.dataset.reachTailscale + (fresh ? '?fresh=1' : ''), { headers: { accept: 'text/html' }, credentials: 'same-origin', redirect: 'manual' });
      if (r.ok && !r.redirected) box.innerHTML = await r.text();
      else if (r.type === 'opaqueredirect') box.replaceChildren(note(T('client.reach.sessionEnded', 'Your session ended: reload the page.')));
      else box.replaceChildren(note(T('client.reach.localOnly', 'Tailscale can only be checked from the window on the computer BrainAI runs on.')));
    } catch { box.replaceChildren(note(T('client.reach.noAnswer', 'BrainAI did not answer. Reload this page to check Tailscale.'))); }
  };
  box.addEventListener('click', (e) => {
    if (e.target instanceof Element && e.target.closest('[data-reach-recheck]')) check(true);
  });
  check(false);
}

// Settings › Connections: the "added, not signed in yet" line is a small request of its own (the tools' CLIs can be slow).
// Without JavaScript the line is simply not shown.
for (const box of document.querySelectorAll('[data-added-tools]')) {
  fetch(box.dataset.addedTools, { headers: { accept: 'text/html' }, credentials: 'same-origin', redirect: 'manual' })
    .then(async (r) => { if (r.ok && !r.redirected) box.innerHTML = await r.text(); })
    .catch(() => { /* offline for a moment: the line stays out */ });
}

// Home's first steps (local mode): "Add an assistant" is also done when a tool was added but has not signed in yet. The
// answer of the Settings line (the tools' CLIs can be slow, so it is a request of its own) is empty when none was.
for (const step of document.querySelectorAll('[data-step-added]')) {
  fetch('/settings/tools/added', { headers: { accept: 'text/html' }, credentials: 'same-origin', redirect: 'manual' })
    .then(async (r) => { if (r.ok && !r.redirected && (await r.text()).trim() !== '') step.classList.add('is-done'); })
    .catch(() => { /* the step stays open */ });
}

// The welcome's step 4: after a minute with no first memory, a hint about signing in appears under the waiting line.
for (const hint of document.querySelectorAll('[data-nothing-yet]')) {
  const started = Date.now();
  setInterval(() => {
    // The server marks the waiting state itself (data-state="waiting"); the page never reads the words.
    const waiting = document.querySelector('[data-setup-status] .attention, [data-setup-status] [data-state="waiting"]') !== null;
    hint.hidden = !(waiting && Date.now() - started >= 60_000);
  }, 5000);
}

// The welcome's "I have a saved BrainAI folder": the chosen file goes up as the raw body, and the answer says where to go
// next (the desktop app watches for that navigation) or why the file was refused.
for (const form of document.querySelectorAll('[data-restore-form]')) {
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const file = form.querySelector('input[type=file]').files[0];
    const err = form.querySelector('[data-restore-error]');
    const busy = form.querySelector('[data-restore-busy]');
    const button = form.querySelector('button[type=submit]');
    if (!file) return;
    err.hidden = true;
    busy.hidden = false;
    button.disabled = true;
    try {
      const r = await fetch('/welcome/restore', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file, credentials: 'same-origin' });
      const answer = await r.json();
      if (answer.next) { location.href = answer.next; return; }
      err.textContent = answer.error || T('client.restore.failed', 'The saved file could not be brought in.');
    } catch {
      err.textContent = T('client.restore.notSent', 'The saved file could not be sent. Try again.');
    }
    err.hidden = false;
    busy.hidden = true;
    button.disabled = false;
  });
}

// The search models' progress line (welcome steps 3 and 4, Home): asks every 2 s while anything is downloading or
// being re-read, and says what the server says in plain words. It stops when nothing is under way any more.
for (const line of document.querySelectorAll('[data-models-progress]')) {
  // The text, the ✓ of a finished check and the bar are separate children, so each can change on its own.
  const text = line.querySelector('.models-text') ?? line.appendChild(Object.assign(document.createElement('span'), { className: 'models-text' }));
  const show = (a) => {
    text.textContent = a.line;
    line.querySelector('.models-ok')?.remove();
    line.querySelector('a')?.remove();
    if (a.ready) {
      const ok = document.createElement('span');
      ok.className = 'ok models-ok';
      ok.textContent = '✓';
      line.prepend(ok);
    }
    if (a.failed) {
      const link = document.createElement('a');
      link.href = '/settings#search';
      link.textContent = T('client.models.settingsLink', 'Look in Settings › Search');
      text.after(' ', link);
    }
    let bar = line.querySelector('.models-bar');
    if (a.bar) {
      if (!bar) {
        bar = document.createElement('progress');
        bar.className = 'models-bar';
        bar.max = 100;
        bar.setAttribute('aria-label', T('client.models.barLabel', 'Search models download progress'));
        line.append(bar);
      }
      if (a.bar.value === null) bar.removeAttribute('value'); else bar.value = a.bar.value;
    } else bar?.remove();
    line.hidden = a.line === '';
  };
  let errors = 0;
  const tick = async () => {
    try {
      const r = await fetch(line.dataset.modelsProgress, { headers: { accept: 'application/json' }, credentials: 'same-origin', redirect: 'manual' });
      // Signed out (a redirect to the login, or 401/403): nothing more to ask.
      if (r.type === 'opaqueredirect' || r.redirected || r.status === 401 || r.status === 403 || (r.status >= 300 && r.status < 400)) return;
      if (r.ok) {
        errors = 0;
        const a = await r.json();
        show(a);
        if (!a.busy) return;
      } else errors++;
    } catch { errors++; /* offline for a moment */ }
    // Every 2 s; after repeated errors slower (up to 30 s), and after 10 in a row it stops.
    if (errors >= 10) return;
    setTimeout(tick, Math.min(30_000, 2000 * 2 ** Math.max(0, errors - 2)));
  };
  if (line.hasAttribute('data-busy')) setTimeout(tick, 2000);
}

// The update card on Home: while the app is backing up, downloading or installing, asks every second and swaps the text.
// It stops when nothing is under way any more (it then loads the page again in place, so the card shows its buttons).
for (const card of document.querySelectorAll('[data-update-state]')) {
  if (!card.hasAttribute('data-busy')) continue;
  const text = card.querySelector('.update-text');
  // A background download that ends (ready, or failed) changes the card where it stands: the page is never reloaded for it.
  const settle = (a) => {
    if (a.state !== 'ready' && a.state !== 'failed') return false;
    card.removeAttribute('data-busy');
    const title = card.querySelector('.update-title');
    if (title && a.title) title.textContent = a.title;
    if (card.querySelector('.update-actions')) return true;
    if (a.state === 'ready' && Array.isArray(a.items) && a.items.length > 0) {
      const ul = document.createElement('ul');
      for (const item of a.items) { const li = document.createElement('li'); li.textContent = String(item); ul.append(li); }
      card.append(ul);
    }
    const actions = document.createElement('div');
    actions.className = 'update-actions';
    const go = document.createElement('a');
    go.className = 'button';
    go.setAttribute('href', '/app/update');
    go.textContent = a.state === 'failed' ? T('client.update.tryAgain', 'Try again') : T('client.update.restartNow', 'Restart now');
    actions.append(go);
    if (a.state === 'ready') {
      const form = document.createElement('form');
      form.setAttribute('method', 'post');
      form.setAttribute('action', '/app/update/later');
      form.className = 'inline';
      const later = document.createElement('button');
      later.setAttribute('type', 'submit');
      later.textContent = T('client.update.later', 'Later');
      form.append(later);
      actions.append(form);
    }
    card.append(actions);
    return true;
  };
  let errors = 0;
  const tick = async () => {
    try {
      const r = await fetch(card.dataset.updateState, { headers: { accept: 'application/json' }, credentials: 'same-origin', redirect: 'manual' });
      if (r.type === 'opaqueredirect' || r.redirected || r.status === 401 || r.status === 403 || (r.status >= 300 && r.status < 400)) return;
      if (r.ok) {
        errors = 0;
        const a = await r.json();
        if (text) { text.textContent = a.text; text.hidden = a.text === ''; }
        if (!a.busy) { if (!settle(a)) location.replace(location.href); return; }
      } else if (r.status === 404) { location.replace(location.href); return; } else errors++;
    } catch { errors++; /* the app may be restarting */ }
    if (errors >= 60) return;
    setTimeout(tick, 1000);
  };
  setTimeout(tick, 1000);
}

// The desktop sidebar's update line: while the update downloads, asks /app/update/state every second and swaps the text and
// the thin bar; when it is ready the line says so with Restart, and when it fails or goes away the line is hidden. It asks
// only while downloading: a line that starts as "ready" never polls. Restart is the Home card's own action (the app's
// window takes /app/update itself); the line says "Restarting…" until the app restarts.
for (const box of document.querySelectorAll('[data-side-update]')) {
  const text = box.querySelector('.side-update-text');
  const bar = box.querySelector('.side-update-bar');
  // After Restart is pressed (the app's window takes the link itself, so the page stays where it is): says "Restarting…" and
  // asks the state each second until the restart is through. A failure shows its plain line; the app itself reopening
  // ends the page. Ready for a while with nothing started means the press did not take: the line goes back to ready.
  const follow = () => {
    let sawBusy = false, quiet = 0, errors = 0, total = 0;
    const tick = async () => {
      try {
        const r = await fetch(box.dataset.sideUpdate, { headers: { accept: 'application/json' }, credentials: 'same-origin', redirect: 'manual' });
        // Signed out (a redirect, or an opaque answer): nothing more to ask.
        if (r.type === 'opaqueredirect' || r.redirected || r.status === 0 || r.status === 401 || r.status === 403 || (r.status >= 300 && r.status < 400)) return;
        if (r.ok) {
          errors = 0;
          const a = await r.json();
          if (a.state === 'backing-up' || a.state === 'installing' || a.state === 'downloading') sawBusy = true;
          else if (a.state === 'failed') {
            if (text) text.textContent = a.text;
            if (bar) bar.hidden = true;
            return;
          } else if (!sawBusy && a.state === 'ready' && ++quiet <= 20) { /* the app has not started yet */ }
          else if (a.state === 'ready') { showReady(); return; } // the press did not take: back to "Update ready · Restart"
          else { box.hidden = true; return; } // blocked, or offered again: Home's card says what happened
        } else if (r.status === 404) { box.hidden = true; return; } else errors++;
      } catch { errors++; /* the server stops while the app is replaced */ }
      if (++total < 300 && errors < 120) setTimeout(tick, 1000);
    };
    setTimeout(tick, 1000);
  };
  const wireRestart = (link) => link.addEventListener('click', () => {
    if (text) text.textContent = T('client.update.sideRestarting', 'Restarting…');
    const act = box.querySelector('.side-update-act');
    if (act) act.hidden = true;
    follow();
  });
  const existing = box.querySelector('.side-update-restart');
  if (existing) wireRestart(existing);
  const showReady = () => {
    if (text) text.textContent = T('client.update.sideReady', 'Update ready');
    if (bar) bar.hidden = true;
    const had = box.querySelector('.side-update-act');
    if (had) { had.hidden = false; return; }
    const act = document.createElement('span');
    act.className = 'side-update-act';
    act.append(' · ');
    const link = document.createElement('a');
    link.className = 'side-update-restart';
    link.setAttribute('href', '/app/update');
    link.textContent = T('client.update.sideRestart', 'Restart');
    wireRestart(link);
    act.append(link);
    box.append(act);
  };
  // true: still downloading, keep asking.
  const show = (a) => {
    if (a.state === 'downloading') {
      const has = typeof a.percent === 'number';
      if (text) text.textContent = has ? T('client.update.sideDownloading', 'Downloading update · {percent}%', { percent: a.percent }) : T('client.update.sideDownloadingNoPercent', 'Downloading update…');
      if (bar) { bar.hidden = false; if (has) bar.value = a.percent; else bar.removeAttribute('value'); }
      return true;
    }
    if (a.state === 'ready') showReady();
    else box.hidden = true;
    return false;
  };
  if (box.dataset.update !== 'downloading') continue;
  let errors = 0;
  const tick = async () => {
    try {
      const r = await fetch(box.dataset.sideUpdate, { headers: { accept: 'application/json' }, credentials: 'same-origin', redirect: 'manual' });
      if (r.type === 'opaqueredirect' || r.redirected || r.status === 401 || r.status === 403 || (r.status >= 300 && r.status < 400)) return;
      if (r.ok) {
        errors = 0;
        if (!show(await r.json())) return;
      } else if (r.status === 404) { box.hidden = true; return; } else errors++;
    } catch { errors++; /* the app may be busy for a moment */ }
    if (errors >= 60) return;
    setTimeout(tick, 1000);
  };
  setTimeout(tick, 1000);
}

// Settings › This computer (the app): while the sizes are still being worked out, asks every two seconds and puts the
// answer into the panel and the index row, in place (no reload).
for (const box of document.querySelectorAll('[data-space]:not([data-ready])')) {
  let tries = 0;
  const tick = async () => {
    tries++;
    try {
      const r = await fetch(box.dataset.space, { headers: { accept: 'application/json' }, credentials: 'same-origin', redirect: 'manual' });
      if (r.ok) {
        const a = await r.json();
        if (a.ready) {
          box.innerHTML = a.html.replace(/^<div[^>]*>/, '').replace(/<\/div>\s*$/, '');
          box.setAttribute('data-ready', '');
          const st = document.querySelector('[data-space-status]');
          if (st && a.total) st.textContent = st.textContent.trim() ? `${st.textContent.trim()} · ${a.total}` : a.total;
          return;
        }
      }
    } catch { /* the app may be busy for a moment */ }
    if (tries < 90) setTimeout(tick, 2000);
    else { const p = box.querySelector('p.meta'); if (p) p.textContent = T('client.space.notReady', 'The sizes are not ready yet. Reload this page in a minute.'); }
  };
  setTimeout(tick, 1500);
}

// Settings › Version (the app): Check for updates is a link the app's window takes itself (it runs its normal check). The
// page then asks the server every two seconds whether a newer check has been written, and loads Settings again to show it.
for (const box of document.querySelectorAll('[data-check-updates]')) {
  const link = box.querySelector('[data-check-link]');
  const status = box.querySelector('[data-check-status]');
  const since = Number(box.dataset.since) || 0;
  let running = false;
  link?.addEventListener('click', (e) => {
    if (running) { e.preventDefault(); return; }
    running = true;
    link.setAttribute('aria-disabled', 'true');
    if (status) { status.hidden = false; status.textContent = T('client.update.checking', 'Checking…'); }
    const started = Date.now();
    const tick = async () => {
      try {
        const r = await fetch(box.dataset.checkUpdates, { headers: { accept: 'application/json' }, credentials: 'same-origin', redirect: 'manual' });
        if (r.ok && (await r.json()).at > since) {
          // A same-URL replace keeping the scroll (as "fresh on return" does), never location.reload.
          const url = location.href.split('#')[0];
          try { sessionStorage.setItem(scrollKey(url), savePlace()); } catch { /* storage off: the page opens at the top */ }
          location.replace(url);
          return;
        }
      } catch { /* the app may be busy for a moment */ }
      if (Date.now() - started > 70_000) {
        running = false;
        link.removeAttribute('aria-disabled');
        if (status) status.textContent = T('client.update.noAnswer', 'No answer yet. Try again in a minute.');
        return;
      }
      setTimeout(tick, 2000);
    };
    setTimeout(tick, 2000);
  });
}

// The welcome's "Choose the models myself": the button says how much will download for the pair picked.
for (const form of document.querySelectorAll('[data-models-form]')) {
  const button = form.querySelector('[data-models-button]');
  const update = () => {
    let total = 0;
    for (const r of form.querySelectorAll('input[type=radio]:checked')) total += Number(r.dataset.mb || 0);
    button.textContent = total === 0 ? T('client.models.continue', 'Continue') : T('client.models.download', 'Download {mb} MB and continue', { mb: total });
  };
  form.addEventListener('change', update);
  update();
}

// A tool's sign-in while the owner account is not fully set up (local mode): its browser page waits, then goes on to the tool once the owner has
// decided in BrainAI's window. Asks every 1.5 s; stops, saying so, when the request is gone.
for (const wait of document.querySelectorAll('[data-consent-wait]')) {
  const status = wait.querySelector('[data-consent-status]');
  let errors = 0;
  const tick = async () => {
    try {
      const r = await fetch(wait.dataset.consentWait, { headers: { accept: 'application/json' }, credentials: 'same-origin', cache: 'no-store' });
      if (r.ok) {
        errors = 0;
        const a = await r.json();
        if (a.state === 'done' && typeof a.location === 'string') { location.replace(a.location); return; }
        if (a.state === 'gone') { if (status) status.textContent = T('client.consent.expired', 'This request expired. Start the connection again from the app.'); return; }
      } else errors++;
    } catch { errors++; /* the app may be restarting */ }
    if (errors >= 20) return;
    setTimeout(tick, 1500);
  };
  setTimeout(tick, 1500);
}

// BrainAI's window (local mode): one banner per tool sign-in waiting for approval, with a Review link. Asks every 3 s
// while the page is visible. A refused answer (no session, or not local mode) stops it.
if (document.body && document.body.dataset && document.body.dataset.consentsWaiting) {
  const url = document.body.dataset.consentsWaiting;
  const shown = new Map();
  let stopped = false;
  const tick = async () => {
    if (stopped) return;
    if (document.visibilityState === 'hidden') { setTimeout(tick, 3000); return; }
    try {
      const r = await fetch(url, { headers: { accept: 'application/json' }, credentials: 'same-origin', redirect: 'manual', cache: 'no-store' });
      if (r.type === 'opaqueredirect' || r.redirected || r.status === 401 || r.status === 403 || r.status === 404 || (r.status >= 300 && r.status < 400)) { stopped = true; return; }
      if (r.ok) {
        const list = await r.json();
        const ids = new Set(list.map((x) => x.id));
        for (const [id, el] of shown) if (!ids.has(id)) { el.remove(); shown.delete(id); }
        const main = document.querySelector('main');
        for (const x of list) {
          if (shown.has(x.id) || !main || location.pathname === '/consent/' + encodeURIComponent(x.id)) continue;
          const el = document.createElement('p');
          el.className = 'notice consent-banner';
          el.setAttribute('role', 'status');
          el.append(document.createTextNode(T('client.consent.wants', '{name} wants access to your memory. ', { name: x.clientName })));
          const a = document.createElement('a');
          a.href = '/consent/' + encodeURIComponent(x.id);
          a.textContent = T('client.consent.review', 'Review');
          el.append(a);
          main.prepend(el);
          shown.set(x.id, el);
        }
      }
    } catch { /* the app may be restarting */ }
    setTimeout(tick, 3000);
  };
  tick();
}
