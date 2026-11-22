// The cart's cues: a mark and a timer each
// (docs/refactors/cart-view.md).

import { reduced } from "./style.js";

// The Hide/Show pill pulses: "teach" the first time, three pairs
// (#278), "once" on a later Add. With reduced motion it holds a still
// emphasis for a moment instead. A timer, not animationend, ends it:
// the still one has no animation to end.
const PULSE_MS = { teach: 4400, once: 520, still: 2600 };

export const pulsePill = (pill, kind) => {
  clearTimeout(pill.pulseTimer);
  pill.removeAttribute("data-pulse");
  void pill.offsetWidth;
  pill.setAttribute("data-pulse", kind);
  pill.pulseTimer = setTimeout(() => {
    pill.removeAttribute("data-pulse");
  }, PULSE_MS[reduced() ? "still" : kind]);
};

// Rings the whole pane in the brand green for a moment (#337). A
// timer, not animationend, ends it: under reduced motion the ring is
// still and has no animation to end.
const RING_MS = 1600;

export const ringCart = (pane) => {
  clearTimeout(pane.ringTimer);
  pane.classList.remove("is-ringed");
  void pane.offsetWidth;
  pane.classList.add("is-ringed");
  pane.ringTimer = setTimeout(() => {
    pane.classList.remove("is-ringed");
  }, RING_MS);
};

// The strip's word for an Add while the pane is closed.
export const showAdded = (box, text, { ms = 2600 } = {}) => {
  clearTimeout(box.addedTimer);
  box.querySelector("[data-cart-added]").textContent = text;
  box.setAttribute("data-show", "");
  box.addedTimer = setTimeout(() => box.removeAttribute("data-show"), ms);
};
