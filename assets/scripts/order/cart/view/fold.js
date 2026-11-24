// The tablet's panel and the column's fold (docs/refactors/cart-view.md).

import { reduced } from "./style.js";

// Eases the pane from `from` px tall to `to`. -> a promise for its end.
const easeHeight = (pane, from, to) => new Promise((resolve) => {
  const ease = pane.animate(
    [{ height: `${from}px` }, { height: `${to}px` }],
    { duration: 420, easing: "cubic-bezier(0.2, 0.8, 0.25, 1)" }
  );

  pane.currentEase = ease;
  // How many eases have started, for the specs: an ease is over
  // before they can see it run.
  pane.eases = (pane.eases || 0) + 1;
  const done = () => {
    if (pane.currentEase === ease) pane.currentEase = null;
    resolve();
  };

  ease.onfinish = done;
  ease.oncancel = done;
});

// Eases the pane's height across a change the caller applies: a fold,
// lines coming or going, a fill or an emptying. The content is laid
// out at the new height at once; the pane's own edge follows. A
// floating sheet rests on its foot, so it grows upward. Nothing under
// reduced motion, and nothing when the change moves nothing. Resolves
// when the pane is still, so the caller can refresh the placement.
export const animateFold = (pane, apply, { reduce = reduced() } = {}) => {
  const from = pane.getBoundingClientRect().height;

  if (pane.currentEase) pane.currentEase.cancel();
  apply();

  const to = pane.getBoundingClientRect().height;

  if (reduce || !from || !to || Math.abs(to - from) < 1
    || typeof pane.animate !== "function") {
    return Promise.resolve();
  }

  return easeHeight(pane, from, to);
};
