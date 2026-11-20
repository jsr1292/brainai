// The viewer's look (Automatic, Light, Dark), shared by every page. The server writes <html data-theme="light|dark"> from
// the `theme` cookie when the choice is forced and nothing when it follows the system. This script, in the <head>,
// offers one answer to "is it dark now?" for scripts that draw (diagrams, the Graph), tells them when it changes, and
// applies a new choice at once: cookie, data-theme and the phone bar's colour, no reload.
(function () {
  var root = document.documentElement;
  var query = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null;
  var COLOURS = { light: '#faf9f6', dark: '#0f1320' };
  var listeners = [];
  function choice() {
    var v = root.getAttribute('data-theme');
    return v === 'light' || v === 'dark' ? v : 'auto';
  }
  function dark() {
    var c = choice();
    return c === 'dark' || (c === 'auto' && !!query && query.matches);
  }
  var last = dark();
  function fire() {
    var now = dark();
    if (now === last) return;
    last = now;
    listeners.slice().forEach(function (fn) { try { fn(now); } catch (e) { /* one listener failing never stops the others */ } });
  }
  /** Calls fn(dark) whenever the page turns light or dark, whether by the choice or by the system. */
  function onChange(fn) { listeners.push(fn); }
  if (query && query.addEventListener) query.addEventListener('change', fire);
  function bar(c) {
    var old = document.querySelectorAll('meta[name="theme-color"]');
    for (var i = 0; i < old.length; i++) old[i].remove();
    var head = document.head;
    function add(content, media) {
      var m = document.createElement('meta');
      m.name = 'theme-color';
      m.content = content;
      if (media) m.setAttribute('media', media);
      head.appendChild(m);
    }
    if (c === 'auto') { add(COLOURS.light, '(prefers-color-scheme: light)'); add(COLOURS.dark, '(prefers-color-scheme: dark)'); }
    else add(COLOURS[c]);
  }
  /** In the desktop app (its window sets __brainaiApp) the title bar follows: the page goes to an address the app takes and cancels, so the page stays. A browser never does this. */
  function tellApp(c) {
    if (window.__brainaiApp !== true) return;
    try { location.href = '/app/theme/' + c; } catch (e) { /* the title bar keeps its look until the next start */ }
  }
  /** Applies a choice ('auto', 'light' or 'dark') now and remembers it on this browser for a year. */
  function set(c) {
    if (c !== 'light' && c !== 'dark') c = 'auto';
    try { document.cookie = 'theme=' + (c === 'auto' ? '; Max-Age=0' : c + '; Max-Age=31536000') + '; Path=/; SameSite=Lax'; } catch (e) { /* cookies blocked: the choice lasts until this page closes */ }
    // No colour fades while the look flips: a row that was light would show for 200 ms as a pale block under light text.
    root.classList.add('theme-switching');
    if (c === 'auto') root.removeAttribute('data-theme'); else root.setAttribute('data-theme', c);
    bar(c);
    fire();
    void root.offsetWidth;
    setTimeout(function () { root.classList.remove('theme-switching'); }, 50);
    tellApp(c);
  }
  window.brainTheme = { choice: choice, dark: dark, onChange: onChange, set: set };
})();

// Settings › Appearance: with scripts, a choice applies at once and Save is not needed (without scripts it posts).
(function () {
  function setUpSettings() {
    var form = document.querySelector('form[data-theme-form]');
    if (!form || !window.brainTheme) return;
    var save = form.querySelector('[data-theme-save]');
    if (save) save.hidden = true;
    form.addEventListener('change', function (e) {
      var input = e.target;
      if (!input || input.name !== 'theme') return;
      window.brainTheme.set(input.value);
      var label = input.closest('label');
      var status = document.querySelector('[data-theme-status]');
      if (status && label) status.textContent = label.textContent.trim();
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', setUpSettings); else setUpSettings();
})();
