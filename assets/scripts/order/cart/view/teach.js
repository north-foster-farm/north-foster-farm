// The first Add's lesson (docs/refactors/cart-view.md).

import { strayed, touchKind } from "../../lib/cart-touch.mjs";

const point = (e) => ({ x: e.clientX, y: e.clientY });
const mine = (s, e) => s.touch && e.pointerId === s.touch.id;

// The lesson is over, kept or shut: no timer, no listeners.
const end = (s) => {
  s.live = false;
  clearTimeout(s.timer);
  for (const [type, fn] of s.on) s.pane.removeEventListener(type, fn);
};

const settles = (s) => ({
  // The caller closes the pane and pulses the pill once it has shut.
  shut: () => {
    if (!s.live) return;
    end(s);
    s.onShut();
  },
  keep: () => {
    if (!s.live) return;
    end(s);
  },
});

// A touch is judged when it ends: a tap keeps the pane, and a scroll
// leaves it to the timer, or shuts it if the time is already up.
const ended = (s, e, { keep, shut }) => {
  if (!mine(s, e)) return;

  const t = s.touch;
  const cancelled = e.type === "pointercancel";

  s.touch = null;
  if (!cancelled) t.far = strayed(t.start, point(e), t.far);
  if (touchKind({ cancelled, far: t.far }) === "tap") keep();
  else if (t.due) shut();
};

const pointers = (s, settle) => [
  ["pointerdown", (e) => {
    if (e.pointerType !== "touch") {
      settle.keep();

      return;
    }
    s.touch = {
      id: e.pointerId,
      start: point(e),
      far: 0,
      due: Boolean(s.touch && s.touch.due),
    };
  }],
  ["pointermove", (e) => {
    if (!mine(s, e)) return;
    s.touch.far = strayed(s.touch.start, point(e), s.touch.far);
  }],
];

// The first Add's lesson: the pane stays open on the new line for the
// dwell, then onShut runs (the caller closes the pane and pulses the
// pill in three pairs once it has shut). The pane
// is the customer's once they tap or click in it (keep); a touch is
// judged when it ends, since a scroll lands as a touch too (#473): a
// tap keeps the pane, a scroll (one the browser cancels, or one that
// strays past the slop) leaves the timer to shut it. A finger still
// down when the time is up has the last word.
export const teach = (pane, pill, { dwell, onShut }) => {
  const s = { pane, onShut, touch: null, timer: null, live: true };
  const settle = settles(s);
  const judge = (e) => ended(s, e, settle);

  s.on = [
    ...pointers(s, settle), ["pointerup", judge], ["pointercancel", judge],
  ];
  for (const [type, fn] of s.on) {
    pane.addEventListener(type, fn, { passive: true });
  }
  s.timer = setTimeout(() => {
    if (s.touch) s.touch.due = true;
    else settle.shut();
  }, dwell);

  return { keep: settle.keep, cancel: settle.keep };
};
