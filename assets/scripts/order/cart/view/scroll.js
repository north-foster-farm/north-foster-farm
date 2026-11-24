// The cart's watch on the page's scroll: whose it is
// (view/own-scroll.mjs) and when one starts
// (docs/refactors/cart-view.md).

import { ownScroll, scrollKey } from "./own-scroll.mjs";

const outside = (pane, e) => !(e.target instanceof Node
  && pane.contains(e.target));
const editable = (el) => el instanceof Element
  && el.matches("input, textarea, select, [contenteditable]");
const control = (el) => el instanceof Element
  && Boolean(el.closest("button, a, [role='button']"));
const scrolling = ({ key, target }) => scrollKey({
  key, field: editable(target), control: control(target),
});

// The person's inputs: a finger, a wheel or a scrolling key outside
// the pane marks the time; any of them is a sign of a scroll.
const inputs = (s) => ({
  touchStart: (e) => {
    if (!outside(s.pane, e)) return;
    s.touching = true;
    s.input = performance.now();
  },
  touchEnd: () => {
    if (!s.touching) return;
    s.touching = false;
    s.input = performance.now();
  },
  moved: (e) => {
    if (outside(s.pane, e)) s.input = performance.now();
    s.onMove();
  },
  key: (e) => {
    if (!scrolling(e)) return;
    if (outside(s.pane, e)) s.input = performance.now();
    s.onMove();
  },
});

// The page's own scroll: a sign at once, and a look once a frame.
const scrolls = (s) => {
  const run = () => {
    s.tick = null;

    const now = performance.now();
    const { input, last, touching } = s;
    const counts = ownScroll({ now, input, last, touching });

    if (counts) s.last = now;
    s.look({ y: window.scrollY, counts });
  };

  return {
    scrolled: () => {
      s.onMove();
      if (s.tick === null) s.tick = requestAnimationFrame(run);
    },
    any: () => s.onMove(),
  };
};

const OPTS = { capture: true, passive: true };

// The document's listeners, all captured. The last, the scroll, hears
// a scroller's as well as the page's.
const captured = (h) => [
  ["touchstart", h.touchStart],
  ["touchmove", h.moved],
  ["touchend", h.touchEnd],
  ["touchcancel", h.touchEnd],
  ["wheel", h.moved],
  ["keydown", h.key],
  ["scroll", h.any],
];

// Calls `look({ y, counts })` once a frame while the page scrolls, and
// `onMove` at once on the first sign of a scroll (a finger moving, a
// wheel, a scrolling key, any scroll at all, the page's or a
// scroller's), before the frame that draws it.
export const watchScroll = (pane, { look, onMove = () => {} }) => {
  const s = {
    pane, look, onMove, input: -Infinity, last: -Infinity, touching: false,
    tick: null,
  };
  const h = { ...inputs(s), ...scrolls(s) };
  const pairs = captured(h);

  for (const [type, fn] of pairs) document.addEventListener(type, fn, OPTS);
  window.addEventListener("scroll", h.scrolled, { passive: true });

  return () => {
    cancelAnimationFrame(s.tick);
    for (const [type, fn] of pairs) {
      document.removeEventListener(type, fn, OPTS);
    }
    window.removeEventListener("scroll", h.scrolled);
  };
};
