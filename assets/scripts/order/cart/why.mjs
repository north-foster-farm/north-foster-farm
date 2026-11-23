// Why Proceed to checkout cannot go on (#706), said in a tooltip on
// the press. Drafts for comms, except stock's, which are the notices'
// own approved words (order-form.js prepare, catalog.html). Pure
// (docs/refactors/cart.md, phase 1).

export const WHY_EMPTY = "Your cart is empty. Add something to check out.";
export const WHY_CHECKING = "We're still checking what's in stock. " +
  "Please try again in a moment.";
export const WHY_DOWN = "Ordering isn't available right now. We can't " +
  "check what's in stock, so we're not taking orders yet.";

// The reason, from the form's summary (summary.mjs: `count`,
// `eligible`, `minimumTip`) and what else the form knows: `method`,
// the way the page holds; `locked`, the stock gate; `down`, that
// stock could not be checked. An empty cart comes first, then the
// gate, then a delivery short of the minimum; null when Proceed may
// go on.
export const whyOf = (summary, { method, locked, down }) => {
  if (summary.count === 0) return { reason: "empty", text: WHY_EMPTY };
  if (locked) {
    return { reason: "locked", text: down ? WHY_DOWN : WHY_CHECKING };
  }
  if (method === "delivery" && !summary.eligible) {
    return { reason: "minimum", text: summary.minimumTip };
  }

  return null;
};
