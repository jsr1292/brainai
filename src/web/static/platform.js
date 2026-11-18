// Runs in the <head>, before the first paint: marks <html class="pc"> when the viewer is not on an Apple device,
// so the search hint reads "Ctrl K" there and ⌘K stays for Mac, iPhone and iPad. Also sets window.__pc for desk.js.
(function () {
  var nav = navigator || {};
  var p = String((nav.userAgentData && nav.userAgentData.platform) || nav.platform || '') + ' ' + String(nav.userAgent || '');
  var apple = /Mac|iPhone|iPad|iPod/i.test(p);
  if (!apple) {
    window.__pc = true;
    document.documentElement.classList.add('pc');
  }
})();
