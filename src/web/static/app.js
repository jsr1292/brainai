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
  t.title = date.toLocaleString('en-GB', { dateStyle: 'full', timeStyle: 'short' });
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
    () => say('Copied', 'Copied'),
    () => {
      say('Could not copy', 'Could not copy. The text is selected in a box after the button: copy it from there.');
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
    box.setAttribute('aria-label', 'Text to copy');
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
if (typeof addEventListener === 'function') {
  addEventListener('pageshow', () => {
    const key = scrollKey(location.href.split('#')[0]);
    let saved = null;
    try { saved = sessionStorage.getItem(key); sessionStorage.removeItem(key); } catch { /* storage off */ }
    if (saved === null) return;
    const before = history.scrollRestoration;
    history.scrollRestoration = 'manual';
    scrollTo(0, Number(saved));
    history.scrollRestoration = before;
  });
}
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
    try { sessionStorage.setItem(scrollKey(url), String(scrollY)); } catch { /* storage off: the place is lost, the page is fresh */ }
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
