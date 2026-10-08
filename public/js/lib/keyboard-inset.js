// The on-screen keyboard and the writing box that sticks to the bottom of the page.
//
// `position: sticky | fixed` is laid out against the LAYOUT viewport. Android Chrome shrinks that with the keyboard (the
// viewport meta says interactive-widget=resizes-content), but iOS Safari and older Android browsers do not: the keyboard
// covers the bottom of the page and only the VISUAL viewport (window.visualViewport) gets smaller. Whatever is stuck to the
// bottom of the layout viewport, here the composer dock on the entry page, then sits behind the keyboard.
//
// watchKeyboardInset() measures how much of the layout viewport's bottom is covered and publishes it as the CSS custom
// property --kb-inset (in px), which entry.css uses to lift the dock and to keep the last message clear of it. Where
// there is no visualViewport, or nothing covers the page (every desktop, Android with resizes-content), the property is
// never set and every rule falls back to 0px: no layout change at all.
//
// Defensive on purpose, because it could not be tried on a real iOS or Android keyboard here (only simulated):
//   * an inset smaller than `min` px is ignored (browser toolbars and rounding are not keyboards);
//   * a pinch-zoomed page (scale > 1) shrinks the visual viewport without anything covering the page: ignored;
//   * every failure to read a number means 0.

/** Smallest bottom area, in CSS px, that is treated as an on-screen keyboard. */
export const MIN_KEYBOARD_PX = 100;

/**
 * How many CSS pixels at the bottom of the layout viewport are covered, from visualViewport measurements.
 * @param {{ layoutHeight: number, viewportHeight: number, offsetTop?: number, scale?: number }} m
 *   layoutHeight: document.documentElement.clientHeight; viewportHeight / offsetTop / scale: visualViewport.height / offsetTop / scale
 * @param {{ min?: number }} [opts]
 * @returns {number} whole pixels, 0 when nothing (or not enough) is covered
 */
export function occludedInset(m, { min = MIN_KEYBOARD_PX } = {}) {
  if (!m) return 0;
  const { layoutHeight, viewportHeight } = m;
  const offsetTop = m.offsetTop === undefined ? 0 : m.offsetTop;
  const scale = m.scale === undefined ? 1 : m.scale;
  if (![layoutHeight, viewportHeight, offsetTop, scale].every(Number.isFinite)) return 0;
  if (scale > 1.02) return 0; // pinch-zoomed in: the visual viewport is smaller, but nothing covers the page
  const inset = layoutHeight - viewportHeight - Math.max(0, offsetTop);
  return inset >= min ? Math.round(inset) : 0;
}

/**
 * Keep --kb-inset on the root element in step with the visual viewport.
 * @param {{ win?: Window, doc?: Document, min?: number, raf?: (fn: () => void) => number, caf?: (id: number) => void }} [opts]
 *   the browser objects can be replaced for tests
 * @returns {() => void} stop watching (and remove the property)
 */
export function watchKeyboardInset({ win = globalThis.window, doc = globalThis.document, min = MIN_KEYBOARD_PX, raf, caf } = {}) {
  const vv = win && win.visualViewport;
  if (!vv || typeof vv.addEventListener !== 'function' || !doc || !doc.documentElement) return () => {};
  const root = doc.documentElement;
  const nextFrame = raf || (typeof win.requestAnimationFrame === 'function' ? win.requestAnimationFrame.bind(win) : (fn) => setTimeout(fn, 16));
  const cancelFrame = caf || (typeof win.cancelAnimationFrame === 'function' ? win.cancelAnimationFrame.bind(win) : clearTimeout);
  let shown = 0;
  let frame = 0;

  const apply = () => {
    frame = 0;
    const inset = occludedInset({ layoutHeight: root.clientHeight, viewportHeight: vv.height, offsetTop: vv.offsetTop, scale: vv.scale }, { min });
    if (inset === shown) return;
    shown = inset;
    if (inset > 0) root.style.setProperty('--kb-inset', `${inset}px`);
    else root.style.removeProperty('--kb-inset');
  };
  // One measurement per frame however many resize / scroll events the browser fires while the keyboard animates.
  const schedule = () => { if (!frame) frame = nextFrame(apply); };

  const onWindow = typeof win.addEventListener === 'function';
  vv.addEventListener('resize', schedule);
  vv.addEventListener('scroll', schedule);
  if (onWindow) win.addEventListener('resize', schedule); // the layout viewport changing (rotation) moves the baseline too
  schedule();

  return () => {
    vv.removeEventListener('resize', schedule);
    vv.removeEventListener('scroll', schedule);
    if (onWindow) win.removeEventListener('resize', schedule);
    if (frame) { cancelFrame(frame); frame = 0; }
    if (shown) root.style.removeProperty('--kb-inset');
    shown = 0;
  };
}
