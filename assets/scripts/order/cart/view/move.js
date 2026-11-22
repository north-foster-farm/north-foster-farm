// The sheet's motion (docs/refactors/cart-view.md, "How state
// moves"): moveParts, in the order read, take over, apply, plan,
// start, finish.

import {
  MOVE_EASE, MOVE_ID, MOVE_MS, fadeFrames, liftShift, moveFrames,
  paneFrames,
} from "./frames.mjs";
import {
  CLEAR, HELD, SIDEWAYS, chromeOf, movers, outerHeight, pillOf, sizeOf,
} from "./measure.js";
import { movePill } from "./pill.js";
import { holds, lifting, movePlan, pillMoves } from "./plan.mjs";
import { prop, reduced } from "./style.js";
import { toPx } from "./units.mjs";

// The part eases running on the pane, for stilled() and the specs.
export const moving = (pane) => pane.getAnimations({ subtree: true })
  .filter((a) => a.id === MOVE_ID);

// Read: every size before the change, mid-ease if one is running.
const read = (pane) => {
  const parts = movers(pane);
  const was = parts.map(sizeOf);
  const heldWas = parts.map((el) => outerHeight(el.querySelector(HELD)));
  const clear = pane.querySelector(CLEAR);
  const pillWas = pillOf(clear);
  const box = pane.getBoundingClientRect();
  const chromeWas = chromeOf(pane);
  const floatingWas = pane.dataset.placement === "floating";

  return { parts, was, heldWas, clear, pillWas, box, chromeWas, floatingWas };
};

// Take over: a newer change takes over from where the parts are now:
// their sizes were read mid-ease, above, before the old eases go.
const take = (pane) => {
  for (const a of moving(pane)) a.cancel();
  if (pane.moveDone) pane.moveDone();
};

// A lift-off: the floating pane's cap is lifted while it eases, so
// the pane is as tall as its parts on every frame and the shift that
// holds its top is exact (the settled cart is uncapped, and capped
// on the first frame its body scrolled and its height jumped).
const lift = (pane, floatingWas) => {
  const floating = pane.dataset.placement === "floating";

  if (lifting({ floatingWas, floating })) {
    pane.style.setProperty("max-height", "none");
  }

  return floating;
};

const partsPlan = ({ parts, was, heldWas }) => {
  const now = parts.map(sizeOf);

  return movePlan(parts.map((el, i) => ({
    el,
    connected: el.isConnected,
    was: was[i],
    now: now[i],
    held: el.querySelector(HELD),
    heldWas: heldWas[i],
    heldNow: outerHeight(el.querySelector(HELD)),
  })));
};

// Plan: every size again, after the change. -> null when nothing moves.
const plan = (pane, b) => {
  const floating = lift(pane, b.floatingWas);
  const kept = partsPlan(b);
  const pillNow = pillOf(b.clear);
  const chromeNow = chromeOf(pane);
  const paneNow = pane.getBoundingClientRect();
  const shift = liftShift({
    wasTop: b.box.top,
    wasHeight: b.box.height,
    nowBottom: paneNow.bottom,
    floating,
  });
  const chrome = paneFrames(b.chromeWas, chromeNow, shift);

  if (!kept.length && !chrome && !pillMoves(b.pillWas, pillNow)) return null;

  return { kept, chrome, clear: b.clear, pillWas: b.pillWas, pillNow };
};

// A part that goes is drawn as it was, over the stylesheet's
// display: none, until its ease is over; every part clips what is
// past its easing edge. The items list inside the lines keeps the
// larger of its two sizes while they ease, so the edge uncovers or
// covers it and never squeezes it: its height, its scroll and its
// fades are the ones it ends with (or had, going) on every frame, and
// a settled list shows every line from the first frame.
const holdParts = (kept) => {
  for (const { el, was: w, now: n, held, heldAt } of kept) {
    if (!n.shown) el.style.setProperty("display", w.display, "important");
    el.style.setProperty("overflow", "clip");
    if (held && heldAt > 0) {
      held.style.setProperty("flex", "none");
      held.style.setProperty("height", `${heldAt}px`);
    }
  }
};

const unholdParts = (kept) => {
  for (const { el, held } of kept) {
    el.style.removeProperty("display");
    el.style.removeProperty("overflow");
    held?.style.removeProperty("flex");
    held?.style.removeProperty("height");
  }
};

const easeParts = (kept, timing) => kept.flatMap(({ el, was: w, now: n }) => {
  const fade = fadeFrames(w, n);

  return [
    el.animate(moveFrames(el.matches(SIDEWAYS), w, n), timing),
    ...(fade ? [el.animate(fade, timing)] : []),
  ];
});

// While the parts ease the body is held at its end, should it ever be
// taller than the room (plan.mjs holds). `h.left` is where the hold
// last left it, and `h.frame` the hold's next frame.
const holdBody = (pane, body, h) => {
  const atEnd = () => {
    const kb = body ? toPx(prop(pane, "--cart-kb")) : 0;

    if (!body || kb > 0 || !holds({
      kb, top: body.scrollTop, left: h.left, height: body.clientHeight,
      full: body.scrollHeight,
    })) {
      h.frame = null;

      return;
    }
    if (body.scrollHeight > body.clientHeight + 1) {
      body.scrollTop = body.scrollHeight;
    }
    h.left = body.scrollTop;
    h.frame = requestAnimationFrame(atEnd);
  };

  atEnd();
};

// Start: the parts held as they were, then every ease on one clock and
// one curve, started in this frame (the parts' sizes, their fades, the
// pane's own room and shift, and Clear cart), then the body held.
const start = (pane, p) => {
  const body = pane.querySelector("[data-cart-body]");
  const h = { frame: null, left: body ? body.scrollTop : 0 };

  holdParts(p.kept);

  const timing = { duration: MOVE_MS, easing: MOVE_EASE, id: MOVE_ID };
  const eases = easeParts(p.kept, timing);

  if (p.chrome) eases.push(pane.animate(p.chrome, timing));

  const pill = movePill(p.clear, p.pillWas, p.pillNow, timing);

  eases.push(...pill.eases);
  // How many eases have started, for the specs: an ease is over
  // before they can see it run.
  pane.eases = (pane.eases || 0) + 1;
  holdBody(pane, body, h);

  return { eases, pill, h };
};

const settled = (ease) => ease.finished.catch(() => {});

// Finish: the holds undone once every ease is over, unless a newer
// move has taken over.
const finish = (pane, kept, s) => new Promise((resolve) => {
  const done = () => {
    if (pane.moveDone !== done) return;
    pane.moveDone = null;
    cancelAnimationFrame(s.h.frame);
    unholdParts(kept);
    s.pill.undo();
    pane.style.removeProperty("max-height");
    resolve();
  };

  pane.moveDone = done;
  Promise.all(s.eases.map(settled)).then(done);
});

// The sheet's one rule for motion (#559): the contents and the
// container move together. The pane is never given a height. Each
// part that comes, goes or changes size eases its own box between its
// two sizes, every part on one curve and one clock from the same
// frame, so the pane, which is only as tall as its parts, moves with
// them on every frame. A part that goes stays drawn as it was until it
// has shrunk to nothing, and is faded out early on; one that comes
// grows from nothing and fades in late (fadeFrames). The pane's own
// padding and borders, Clear cart, and on a lift-off the pane's place
// (paneFrames) ease on the same clock. The body's parts ease their
// height; the foot's two buttons ease their width, Expand or Hide
// coming and going on a settle or a lift-off while Proceed to checkout
// takes or gives its room, so the settled foot becomes the floating
// one and back.
// While the parts ease the body is held at its end, should it ever be
// taller than the room: the total row stays on the foot. Add, remove,
// clear, Expand, Hide, the minimize on scroll, the settle and the
// lift-off all go through here; nothing patches one of them alone.
// Resolves when every part is still. Under reduced motion it applies
// the change and nothing moves.
export const moveParts = (pane, apply, { reduce = reduced() } = {}) => {
  const before = read(pane);

  take(pane);
  apply();

  if (reduce || typeof pane.animate !== "function") return Promise.resolve();

  const p = plan(pane, before);

  if (!p) {
    pane.style.removeProperty("max-height");

    return Promise.resolve();
  }

  return finish(pane, p.kept, start(pane, p));
};
