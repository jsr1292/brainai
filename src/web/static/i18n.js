// The page's texts for the browser scripts, in the owner's language: <script type="application/json" id="i18n"> (see
// src/i18n/client.ts; every page carries the whole client catalog). Defines the global T(key, english, params): the text
// for a key, or the English given when the page has none, with {name} replaced from params. T.lang is the page's language
// ("en", "es", or "en" with no block), for dates and numbers through Intl. Every script (app.js, desk.js, viewer.js,
// diagrams.js, editor-*.js, graph3d.js) reads it as `globalThis.T`; this file loads before them.
(function () {
  var texts = {};
  var lang = 'en';
  try {
    var el = typeof document !== 'undefined' && typeof document.getElementById === 'function' ? document.getElementById('i18n') : null;
    var data = el ? JSON.parse(el.textContent) : null;
    if (data && typeof data.t === 'object' && data.t !== null) texts = data.t;
    if (data && typeof data.lang === 'string' && data.lang) lang = data.lang;
  } catch (e) { /* no block: English fallbacks */ }
  var T = function (key, english, params) {
    var s = typeof texts[key] === 'string' ? texts[key] : english !== undefined ? english : key;
    if (params) s = s.replace(/\{(\w+)\}/g, function (m, name) { return Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : m; });
    return s;
  };
  T.lang = lang;
  globalThis.T = T;
})();
