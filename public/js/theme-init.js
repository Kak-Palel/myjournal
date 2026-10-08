// Runs before first paint (classic script, blocking) so the saved theme never flashes.
(function () {
  try {
    var t = localStorage.getItem('mj-theme');
    if (t === 'light' || t === 'dark' || t === 'auto') document.documentElement.setAttribute('data-theme', t);
  } catch (e) { /* storage unavailable: keep auto */ }
})();
