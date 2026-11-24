// Focus kept clear of the pane (docs/refactors/cart-view.md).

import { clearBy } from "../../lib/cart-scroll.mjs";
import { focusRoom } from "./plan.mjs";

// How long after a focus a change in the page's height may still have
// pushed the control off the screen: a cart settling and opening, a
// list landing.
const SHIFT_MS = 1000;

// How soon after a Tab keydown a focus counts as one the Tab key moved.
// The browser moves the focus in the keydown's own task, so this is
// slack, not a wait.
const TAB_MS = 100;

// A focus a script gives after scrolling the page itself, through
// focusAfterScroll, is left alone: an instant scroll here cut cart
// show()'s smooth one short and left the page at whichever finished
// last (#619).
const scripted = new WeakSet();

export const focusAfterScroll = (el) => {
  scripted.add(el);
  el.focus({ preventScroll: true });
  scripted.delete(el);
};

// Scrolls the page so that `el` is clear of the floating pane and the
// top bar (focusRoom): while the pane covers the foot, or always for a
// focus the Tab key moved (`keyed`).
const clearOf = (pane, bar) => (el, keyed) => {
  if (!el || pane.contains(el) || document.activeElement !== el) return;

  const { over, floor, ceiling } = focusRoom({
    barFoot: bar ? Math.max(0, bar.getBoundingClientRect().bottom) : 0,
    paneTop: pane.getBoundingClientRect().top,
    floating: pane.dataset.placement === "floating",
    screen: window.innerHeight,
  });

  if (!over && !keyed) return;

  const by = clearBy(el.getBoundingClientRect(), { floor, ceiling });

  if (by > 0) window.scrollBy({ top: by, behavior: "instant" });
};

// Captured, so a control that stops the key's propagation still
// counts.
const onKeyOf = (f) => (e) => {
  if (e.key === "Tab") f.tabAt = performance.now();
};

const onFocusOf = (f, clear) => (e) => {
  f.since = performance.now();
  // A script's own focus is no Tab's: an earlier Tab must not make a
  // resize just after it scroll the page (qa on #619).
  if (scripted.has(e.target)) {
    f.tabbed = false;
    return;
  }
  f.tabbed = f.since - f.tabAt <= TAB_MS;
  const keyed = f.tabbed;

  clear(e.target, keyed);
  requestAnimationFrame(() => requestAnimationFrame(
    () => clear(e.target, keyed)
  ));
};

// A frame later, as watchList's: a scroll inside the observer's
// callback is a layout change WebKit warns of as a loop.
const sizesOf = (f, clear) => new ResizeObserver(() => {
  if (!f.tabbed || performance.now() - f.since > SHIFT_MS) return;
  requestAnimationFrame(() => clear(document.activeElement, true));
});

// A control the Tab key reaches under the floating pane scrolls up
// clear of it, never under the top bar (#159, WCAG 2.4.11). The pane's
// own are its own, and a scroller taller than the room is left where
// it is. The pane may grow once the bar sticks, so it looks again a
// frame later.
//
// A control the Tab key moved to below the screen's foot scrolls up
// the same way, wherever the cart is (#549). WebKit keeps no scroll
// anchor, so a page that grows above the focus after the browser
// scrolled to it (the cart settling into its slot and opening to every
// line) left the focus below the fold on a phone, where Chromium kept
// it in place. The page's height is watched for a moment after each
// such focus, and a change in it looks again. Only a Tab counts: a
// script's focus after its own smooth scroll (Proceed to checkout's
// legend) or a tapped field matches :focus-visible too, and an instant
// scroll here would cut the smooth one short.
export const clearFocusUnder = (pane, given) => {
  const bar = given === undefined
    ? document.querySelector(".order-topbar") : given;
  const f = { tabAt: -Infinity, since: -Infinity, tabbed: false };
  const clear = clearOf(pane, bar);
  const onKey = onKeyOf(f);
  const onFocus = onFocusOf(f, clear);
  const sizes = sizesOf(f, clear);

  document.addEventListener("keydown", onKey, true);
  document.addEventListener("focusin", onFocus);
  sizes.observe(document.documentElement);

  return () => {
    document.removeEventListener("keydown", onKey, true);
    document.removeEventListener("focusin", onFocus);
    sizes.disconnect();
  };
};
