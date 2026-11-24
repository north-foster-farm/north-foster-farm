// The shared row's fold (docs/refactors/cart-view.md).

import { reduced } from "./style.js";

// Folds an open part of the shared row (#532): `is-shutting` plays its
// opening backwards (_cart.scss), and `apply` hides it once that is
// over. Under reduced motion `apply` runs at once. A second call while
// one runs gets the same promise, so the part shuts once.
export const shutShare = (part, apply, { reduce = reduced() } = {}) => {
  if (part.shutting) return part.shutting;
  if (reduce || typeof part.getAnimations !== "function") {
    apply();

    return Promise.resolve();
  }

  part.classList.add("is-shutting");
  // The part is styled before getAnimations() answers, so the closing
  // is among them. One cancelled, by a hide from elsewhere, is over too.
  part.shutting = Promise.all(
    part.getAnimations().map((a) => a.finished.catch(() => {}))
  ).then(() => {
    apply();
    part.classList.remove("is-shutting");
    part.shutting = null;
  });

  return part.shutting;
};
