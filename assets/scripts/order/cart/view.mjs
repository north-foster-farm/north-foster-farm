// The cart's view: what touches the viewport, the clock and the
// pane's own motion (#477, docs/cart.md). cart/state.mjs decides the
// state and cart/cart.js writes it; this module feeds the decision and
// animates the result. It writes no height, floor or cap to CSS: the
// stylesheet (_cart.scss) lays the pane out from three raw viewport
// facts (--cart-vis, --cart-gap, --cart-kb) and the top bar's foot
// (--cart-bar), and everything measured here is measured for the
// decision or the animation alone, at a quiet moment, never written
// back for the layout to read.

import { COLUMN, SHEET, SHORT } from "./view/queries.mjs";
import { restOf, toPx } from "./view/units.mjs";
import {
  CHROME, FADE_IN, FADE_OUT, MOVE_EASE, MOVE_ID, MOVE_MS, WORD_FRAMES,
  fadeFrames, liftShift, moveFrames, moves, paneFrames, pillFadeFrames,
  wordsAt,
} from "./view/frames.mjs";
import { OWN_MS, ownScroll } from "./view/own-scroll.mjs";
import { moreShown } from "./view/more.mjs";
import { prop, reduced } from "./view/style.js";
import { watchKeyboard } from "./view/keyboard.js";
import { watchPlacement } from "./view/placement.js";
import { watchScroll } from "./view/scroll.js";
import { animateFold } from "./view/fold.js";
import { shutShare } from "./view/share.js";
import { revealLine, watchList } from "./view/list.js";
import { pulsePill, ringCart, showAdded } from "./view/cues.js";
import { teach } from "./view/teach.js";
import { clearFocusUnder, focusAfterScroll } from "./view/focus.js";

// The parts that have moved live in view/ (docs/refactors/cart-view.md);
// this module is still the one door to them.
export {
  COLUMN, SHORT, SHEET, toPx, restOf, OWN_MS, ownScroll, MOVE_MS, MOVE_ID,
  FADE_OUT, FADE_IN, moveFrames, fadeFrames, paneFrames, liftShift,
  pillFadeFrames, moves, WORD_FRAMES, wordsAt, moreShown, watchKeyboard,
  watchPlacement, watchScroll, animateFold, shutShare, watchList,
  revealLine, pulsePill, ringCart, showAdded, teach, clearFocusUnder,
  focusAfterScroll,
};

// The foot's buttons, which ease their width in a move.
const SIDEWAYS = ".order-cart-toggle, .order-cart-next";

const movers = (pane) => [
  ...(pane.querySelector("[data-cart-body]")?.children || []),
  ...(pane.querySelector("[data-part='foot']")?.children || []),
];

// What a part that comes or goes takes up besides its size: its
// padding, its borders and its margins, which display: none takes away
// in one frame. A body part's are above and below it, a foot button's
// beside it, where the foot's gap after it goes too (its right margin
// takes the gap back). Eased with the size, so nothing is left to snap
// when the ease ends (#559: the sums', the badges' and the shared
// row's padding, about 40px, dropped in the last frame of a minimize).
const ROOM = {
  down: [
    "paddingTop", "paddingBottom", "borderTopWidth", "borderBottomWidth",
    "marginTop", "marginBottom",
  ],
  across: [
    "paddingLeft", "paddingRight", "borderLeftWidth", "borderRightWidth",
    "marginRight",
  ],
};

// The scroller inside a part, which keeps one size while its part
// eases: see moveParts.
const HELD = "[data-cart-scroll]";

const outerHeight = (el) => (el && el.getClientRects().length
  ? el.getBoundingClientRect().height : 0);

const sizeOf = (el) => {
  const rects = el.getClientRects();

  if (!rects.length) return { shown: false, size: 0 };

  const r = el.getBoundingClientRect();
  const style = getComputedStyle(el);
  const sideways = el.matches(SIDEWAYS);
  const room = Object.fromEntries(
    ROOM[sideways ? "across" : "down"].map((name) => [name, style[name]])
  );

  return {
    shown: true,
    size: sideways ? r.width : r.height,
    display: style.display,
    room,
    gap: sideways && el.nextElementSibling?.getClientRects().length
      ? parseFloat(getComputedStyle(el.parentElement).columnGap) || 0 : 0,
  };
};

const chromeOf = (pane) => {
  const style = getComputedStyle(pane);

  return Object.fromEntries(CHROME.map((name) => [name, style[name]]));
};

// The part eases running on the pane, for stilled() and the specs.
export const moving = (pane) => pane.getAnimations({ subtree: true })
  .filter((a) => a.id === MOVE_ID);

// Clear cart, which stands astride the pane's edge and takes no room:
// where it stands and whether it shows.
const CLEAR = "[data-cart-clear]";

const pillOf = (el) => {
  if (!el || !el.getClientRects().length) return { shown: false };

  const style = getComputedStyle(el);

  return {
    shown: true, display: style.display, transform: style.transform,
    right: style.right,
  };
};

// Clear cart through a change (#559, round 3): one that goes stays
// where it stood, over the stylesheet's display: none and its new
// place, and fades through the move (pillFadeFrames; the clear's pill
// vanished in one frame with everything else); one that comes fades in
// at its new place; one
// that stays moves to its new place on the parts' curve. -> its
// animations, and what to undo at the end.
const movePill = (el, was, now, timing) => {
  if (!el || (!was.shown && !now.shown)) return { eases: [], undo: () => {} };
  if (was.shown && now.shown) {
    if (was.transform === now.transform && was.right === now.right) {
      return { eases: [], undo: () => {} };
    }

    return {
      eases: [el.animate([
        { transform: was.transform, right: was.right },
        { transform: now.transform, right: now.right },
      ], timing)],
      undo: () => {},
    };
  }
  if (!now.shown) {
    el.style.setProperty("display", was.display, "important");
    el.style.setProperty("transform", was.transform, "important");
    el.style.setProperty("right", was.right, "important");
  }

  return {
    eases: [el.animate(pillFadeFrames(was, now), timing)],
    undo: () => {
      for (const name of ["display", "transform", "right"]) {
        el.style.removeProperty(name);
      }
    },
  };
};

// Swaps the words of a control with a move, Hide's or Expand's (#559,
// round 3): the old words fade out with what goes, the new ones are put
// in while nothing shows and fade in with what comes. On the clear,
// Hide became Expand in the frame before anything eased, and then
// "Expand" in one frame at nothing (fix round on 93e80094). Under
// reduced motion, or with no ease, the words change at once. A newer
// change cancels the ease (moveParts), and the newest words go in.
export const swapWords = (el, text, { reduce = reduced() } = {}) => {
  el.wantWords = text;
  if (reduce || typeof el.animate !== "function") {
    el.textContent = text;

    return;
  }
  if (el.wordEase && el.wordEase.playState !== "idle") return;

  const was = el.textContent;
  const ease = el.animate(WORD_FRAMES, {
    duration: MOVE_MS, easing: MOVE_EASE, id: MOVE_ID,
  });
  const put = () => {
    if (el.textContent !== el.wantWords) el.textContent = el.wantWords;
  };
  const look = () => {
    if (el.wordEase !== ease) return;

    const { progress } = ease.effect.getComputedTiming();

    if (wordsAt(progress, was, el.wantWords) !== was) {
      put();

      return;
    }
    requestAnimationFrame(look);
  };
  const end = () => {
    if (el.wordEase !== ease) return;
    el.wordEase = null;
    put();
  };

  el.wordEase = ease;
  requestAnimationFrame(look);
  ease.finished.then(end, end);
};

// The words a control is showing or on its way to (see swapWords).
export const wordsOf = (el) => el.wantWords ?? el.textContent;

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
  const parts = movers(pane);
  const was = parts.map(sizeOf);
  const heldWas = parts.map((el) => outerHeight(el.querySelector(HELD)));
  const clear = pane.querySelector(CLEAR);
  const pillWas = pillOf(clear);
  const box = pane.getBoundingClientRect();
  const chromeWas = chromeOf(pane);
  const floatingWas = pane.dataset.placement === "floating";

  // A newer change takes over from where the parts are now: their
  // sizes were read mid-ease, above, before the old eases go.
  for (const a of moving(pane)) a.cancel();
  if (pane.moveDone) pane.moveDone();
  apply();

  if (reduce || typeof pane.animate !== "function") return Promise.resolve();

  const floating = pane.dataset.placement === "floating";
  // A lift-off: the floating pane's cap is lifted while it eases, so
  // the pane is as tall as its parts on every frame and the shift that
  // holds its top is exact (the settled cart is uncapped, and capped
  // on the first frame its body scrolled and its height jumped).
  const lifting = floating && !floatingWas;

  if (lifting) pane.style.setProperty("max-height", "none");

  const now = parts.map(sizeOf);
  const pillNow = pillOf(clear);
  const chromeNow = chromeOf(pane);
  const paneNow = pane.getBoundingClientRect();
  const plan = parts
    .map((el, i) => ({
      el,
      was: was[i],
      now: now[i],
      held: el.querySelector(HELD),
      heldAt: Math.max(heldWas[i], outerHeight(el.querySelector(HELD))),
    }))
    .filter((p) => p.el.isConnected && moves(p.was, p.now));
  const shift = liftShift({
    wasTop: box.top,
    wasHeight: box.height,
    nowBottom: paneNow.bottom,
    floating,
  });
  const chrome = paneFrames(chromeWas, chromeNow, shift);
  const pillMoves = pillWas.shown !== pillNow.shown
    || (pillWas.shown && (pillWas.transform !== pillNow.transform
      || pillWas.right !== pillNow.right));

  if (!plan.length && !chrome && !pillMoves) {
    pane.style.removeProperty("max-height");

    return Promise.resolve();
  }

  const body = pane.querySelector("[data-cart-body]");
  let hold = null;
  // Where the hold last left the body: a scroll from anywhere else, the
  // person's or the code field brought into view, is kept, and the hold
  // lets go. Under the keyboard the body scrolls as a whole and the
  // field is the place to keep, so nothing is held (cart-keyboard spec:
  // a body scrolled to its top was put back at its end, 166px down).
  // A body that shrank under its scroll, clamped to its new end, is
  // still at its end.
  let left = body ? body.scrollTop : 0;
  const moved = () => Math.abs(body.scrollTop - left) > 1
    && body.scrollTop + body.clientHeight < body.scrollHeight - 1;
  const atEnd = () => {
    if (!body || toPx(prop(pane, "--cart-kb")) > 0 || moved()) {
      hold = null;

      return;
    }
    if (body.scrollHeight > body.clientHeight + 1) {
      body.scrollTop = body.scrollHeight;
    }
    left = body.scrollTop;
    hold = requestAnimationFrame(atEnd);
  };

  // A part that goes is drawn as it was, over the stylesheet's
  // display: none, until its ease is over; every part clips what is
  // past its easing edge. The items list inside the lines keeps the
  // larger of its two sizes while they ease, so the edge uncovers or
  // covers it and never squeezes it: its height, its scroll and its
  // fades are the ones it ends with (or had, going) on every frame, and
  // a settled list shows every line from the first frame.
  for (const { el, was: w, now: n, held, heldAt } of plan) {
    if (!n.shown) el.style.setProperty("display", w.display, "important");
    el.style.setProperty("overflow", "clip");
    if (held && heldAt > 0) {
      held.style.setProperty("flex", "none");
      held.style.setProperty("height", `${heldAt}px`);
    }
  }

  // Every ease on one clock and one curve, started in this frame: the
  // parts' sizes, their fades, the pane's own room and shift, and Clear
  // cart.
  const timing = { duration: MOVE_MS, easing: MOVE_EASE, id: MOVE_ID };
  const eases = plan.flatMap(({ el, was: w, now: n }) => {
    const fade = fadeFrames(w, n);

    return [
      el.animate(moveFrames(el.matches(SIDEWAYS), w, n), timing),
      ...(fade ? [el.animate(fade, timing)] : []),
    ];
  });

  if (chrome) eases.push(pane.animate(chrome, timing));

  const pill = movePill(clear, pillWas, pillNow, timing);

  eases.push(...pill.eases);

  // How many eases have started, for the specs: an ease is over
  // before they can see it run.
  pane.eases = (pane.eases || 0) + 1;
  atEnd();

  return new Promise((resolve) => {
    const done = () => {
      if (pane.moveDone !== done) return;
      pane.moveDone = null;
      cancelAnimationFrame(hold);
      for (const { el, held } of plan) {
        el.style.removeProperty("display");
        el.style.removeProperty("overflow");
        held?.style.removeProperty("flex");
        held?.style.removeProperty("height");
      }
      pill.undo();
      pane.style.removeProperty("max-height");
      resolve();
    };

    pane.moveDone = done;
    Promise.all(eases.map((e) => e.finished.catch(() => {}))).then(done);
  });
};
