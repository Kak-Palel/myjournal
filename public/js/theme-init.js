// Runs before first paint (classic script, blocking) so the saved theme never flashes.
(function () {
  try {
    var t = localStorage.getItem('mj-theme');
    if (t === 'light' || t === 'dark' || t === 'auto') document.documentElement.setAttribute('data-theme', t);
    // The browser's own bar (address bar on phones) follows an explicit choice too, not just the system setting.
    if (t === 'light' || t === 'dark') {
      var metas = document.querySelectorAll('meta[name="theme-color"]');
      for (var i = 0; i < metas.length; i++) metas[i].setAttribute('content', t === 'dark' ? '#171614' : '#faf7f2');
    }
  } catch (e) { /* storage unavailable: keep auto */ }
})();
