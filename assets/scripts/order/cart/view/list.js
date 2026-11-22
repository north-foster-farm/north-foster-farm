// The cart's list: the "more" arrows, the edge fades and the glide to
// a hidden row (docs/refactors/cart-view.md).

import { moreStop } from "../../lib/cart-scroll.mjs";
import { glideAt, glideSpan, moreShown } from "./more.mjs";
import { reduced } from "./style.js";

const rowsOf = (list) => Array.from(list.querySelectorAll(".order-cart-item"))
  .map((li) => ({
    top: li.offsetTop - list.offsetTop,
    bottom: li.offsetTop - list.offsetTop + li.offsetHeight,
  }));

const extent = (list) => ({
  top: list.scrollTop, height: list.clientHeight, full: list.scrollHeight,
});

const syncList = ({ list, wrap, more, moreTop }) => {
  // Room for the arrows above and below the rows, only while the
  // rows overflow. The strip is counted back first: taken from the
  // rows, it kept them overflowing once a pane in mid-opening had
  // let them (#278).
  const strip = wrap.hasAttribute("data-scroll")
    ? parseFloat(getComputedStyle(wrap).paddingBottom) || 0 : 0;

  wrap.toggleAttribute(
    "data-scroll", list.scrollHeight > list.clientHeight + strip + 1
  );

  const shown = moreShown(extent(list));

  wrap.toggleAttribute("data-top", shown.up);
  wrap.toggleAttribute("data-more", shown.down);
  more.hidden = !shown.down;
  moreTop.hidden = !shown.up;
};

// The glide itself, one frame at a time; a touch or a wheel on the
// list stops it.
const glideTo = (l, from, to) => {
  const began = performance.now();
  const span = glideSpan(Math.abs(to - from));
  const stop = () => cancelAnimationFrame(l.glide);
  const step = (now) => {
    const t = Math.min(1, (now - began) / span);

    l.list.scrollTop = glideAt({ from, to, t });
    if (t < 1) l.glide = requestAnimationFrame(step);
  };

  l.list.addEventListener("touchstart", stop, { once: true, passive: true });
  l.list.addEventListener("wheel", stop, { once: true, passive: true });
  l.glide = requestAnimationFrame(step);
};

// The list glides to the row that was hidden, landing on it
// exactly: a drive of our own, since the browser's smooth scroll
// overshot on iOS and snapped back (#366).
const scrollMore = (l, dir) => {
  const { list } = l;
  const to = moreStop(rowsOf(list), extent(list), dir);
  const from = list.scrollTop;

  cancelAnimationFrame(l.glide);
  if (to === from) return;
  if (reduced()) {
    list.scrollTop = to;

    return;
  }
  glideTo(l, from, to);
};

// Adds the list's listeners. -> dispose.
const listen = (l, h) => {
  l.list.addEventListener("scroll", h.sync, { passive: true });
  l.more.addEventListener("click", h.down);
  l.moreTop.addEventListener("click", h.up);
  h.sizes.observe(l.list);

  return () => {
    cancelAnimationFrame(l.glide);
    h.sizes.disconnect();
    l.list.removeEventListener("scroll", h.sync);
    l.more.removeEventListener("click", h.down);
    l.moreTop.removeEventListener("click", h.up);
  };
};

// The "more" arrows and the fades at the list's edges, kept in step
// with the list's own scrolling and size. `wrap` is the scroller
// around the list that carries the fades and the arrows. While
// `paused()` says the pane is moving, a change of size waits for the
// caller's sync at the end (#559): the list grows and shrinks with the
// pane, and the arrows and fades flickered on and off under it.
export const watchList = (list, wrap, {
  more, moreTop, paused = () => false,
}) => {
  const l = { list, wrap, more, moreTop, glide: null };
  const sync = () => syncList(l);
  // A frame later: sync moves the strip, which resizes the list, and
  // WebKit warns of a loop when that happens inside the observer.
  const sizes = new ResizeObserver(() => requestAnimationFrame(() => {
    if (!paused()) sync();
  }));
  const h = {
    sync, sizes, down: () => scrollMore(l, 1), up: () => scrollMore(l, -1),
  };
  const dispose = listen(l, h);

  sync();

  return { sync, dispose };
};

// Scrolls the list, and only the list, to a line.
export const revealLine = (list, row) => {
  if (!row) return;

  const top = row.offsetTop - list.offsetTop;

  if (top < list.scrollTop
    || top + row.offsetHeight > list.scrollTop + list.clientHeight) {
    list.scrollTop = Math.max(0, top - 8);
  }
};
