// The cart's watch on where it is placed (docs/refactors/cart-view.md).

import { closedHeight } from "./plan.mjs";
import { COLUMN, SHORT } from "./queries.mjs";
import { prop, rootFont, setProp } from "./style.js";
import { restOf, toPx } from "./units.mjs";

// What the watch keeps between frames. The slot's place is read from
// its anchor, the empty block before the pane (the slot itself has no
// box below xl). `bar` is the phone's top bar, whose foot the pane's
// room ends at.
const watching = (pane, slot, given, look) => ({
  pane,
  look,
  column: matchMedia(COLUMN),
  short: matchMedia(SHORT),
  anchor: slot.querySelector("[data-cart-anchor]") || slot,
  bar: given === undefined ? document.querySelector(".order-topbar") : given,
  height: 0,
  closedH: 0,
  closedSeen: 0,
  tick: null,
});

// The closed height the lift-off threshold uses must never exceed
// the height the pane then has closed: a settle at `room - height`
// and a lift-off at `room - closedH` would overlap, and a scroll
// that stops in the overlap would flip the pane back and forth. So
// it is the pane's own height, cached whenever it is measured
// floating and closed, and the stylesheet's constant, a lower
// bound, only until then (and again after a width change).
const measure = (w) => {
  const { pane } = w;

  w.height = pane.getBoundingClientRect().height;
  if (pane.dataset.placement === "floating"
    && pane.dataset.fold === "closed") {
    w.closedSeen = w.height;
  }
  w.closedH = closedHeight({
    seen: w.closedSeen,
    css: getComputedStyle(pane).getPropertyValue("--cart-closed-h"),
    font: rootFont(),
  });
};

const writeBar = (w) => {
  if (!w.bar) return;

  const foot = w.bar.getBoundingClientRect().bottom;

  setProp(w.pane, "--cart-bar", Math.max(0, foot));
};

// One frame's look: the bar's foot always, and while the keyboard is
// down, place()'s inputs.
const run = (w) => {
  w.tick = null;
  writeBar(w);
  if (toPx(prop(w.pane, "--cart-kb")) > 0) return;

  const slotTop = w.anchor.getBoundingClientRect().top;
  const room = window.innerHeight - restOf({
    margin: 0.5 * rootFont(),
    gap: toPx(prop(w.pane, "--cart-gap")),
  });

  w.look({
    column: w.column.matches,
    short: w.short.matches,
    slotTop,
    slotBottom: slotTop + w.height,
    room,
    height: w.height,
    closedH: w.closedH,
  });
};

const handlers = (w) => {
  const refresh = () => {
    measure(w);
    run(w);
  };

  return {
    refresh,
    schedule: () => {
      if (w.tick === null) w.tick = requestAnimationFrame(() => run(w));
    },
    forget: () => {
      w.closedSeen = 0;
      refresh();
    },
    // The chrome eases between floating and settled, and the pane's
    // height with it: measure again when it has.
    eased: (e) => {
      if (e.target === w.pane && e.propertyName === "padding-top") refresh();
    },
  };
};

// Adds the watch's listeners. -> dispose.
const listen = (w, h) => {
  window.addEventListener("scroll", h.schedule, { passive: true });
  window.addEventListener("resize", h.forget);
  w.pane.addEventListener("transitionend", h.eased);
  w.column.addEventListener("change", h.forget);
  w.short.addEventListener("change", h.forget);

  return () => {
    cancelAnimationFrame(w.tick);
    window.removeEventListener("scroll", h.schedule);
    window.removeEventListener("resize", h.forget);
    w.pane.removeEventListener("transitionend", h.eased);
    w.column.removeEventListener("change", h.forget);
    w.short.removeEventListener("change", h.forget);
  };
};

// Feeds the placement decision (state.mjs place) on every frame the
// page moves. `look` gets place()'s inputs and two more, slotBottom
// and short, and the caller applies the state. slotBottom is the
// slot's place plus the pane's height. The pane's height is read only
// in refresh(), which the caller runs after a render or a fold has
// finished, never mid-animation; the closed height is the
// stylesheet's constant for this width, read then too. While the
// keyboard is up nothing is looked at: the room is not the pane's.
export const watchPlacement = (pane, slot, { bar: given, look }) => {
  const w = watching(pane, slot, given, look);
  const h = handlers(w);
  const dispose = listen(w, h);

  h.refresh();

  return { refresh: h.refresh, dispose };
};
