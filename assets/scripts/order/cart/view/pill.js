// Clear cart through a move (docs/refactors/cart-view.md).

import { pillFadeFrames } from "./frames.mjs";

// What a pill that goes keeps, over the stylesheet, until its fade is
// over.
const PINNED = ["display", "transform", "right"];

const still = () => ({ eases: [], undo: () => {} });

// One that stays moves to its new place on the parts' curve.
const slide = (el, was, now, timing) => {
  if (was.transform === now.transform && was.right === now.right) {
    return still();
  }

  return {
    eases: [el.animate([
      { transform: was.transform, right: was.right },
      { transform: now.transform, right: now.right },
    ], timing)],
    undo: () => {},
  };
};

// One that goes stays where it stood and fades; one that comes fades
// in at its new place.
const fade = (el, was, now, timing) => {
  if (!now.shown) {
    for (const name of PINNED) {
      el.style.setProperty(name, was[name], "important");
    }
  }

  return {
    eases: [el.animate(pillFadeFrames(was, now), timing)],
    undo: () => {
      for (const name of PINNED) {
        el.style.removeProperty(name);
      }
    },
  };
};

// Clear cart through a change (#559, round 3): one that goes stays
// where it stood, over the stylesheet's display: none and its new
// place, and fades through the move (pillFadeFrames; the clear's pill
// vanished in one frame with everything else); one that comes fades in
// at its new place; one
// that stays moves to its new place on the parts' curve. -> its
// animations, and what to undo at the end.
export const movePill = (el, was, now, timing) => {
  if (!el || (!was.shown && !now.shown)) return still();
  if (was.shown && now.shown) return slide(el, was, now, timing);

  return fade(el, was, now, timing);
};
