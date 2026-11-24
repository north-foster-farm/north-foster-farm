// What one render of the cart decides, apart from drawing it
// (docs/refactors/cart.md, phase 2). Pure: lines-view.js and
// sums-view.js draw what these say, and cart.js orders the render.

import { dollars } from "../lib/totals.mjs";
import { label } from "../lib/zoned.mjs";

// How far above the screen's foot the settled cart's bottom edge is
// before the readouts in the bars take over.
const PASSED_AT = 60;

// The same lines as those drawn: the summary's groups, compared as
// data. Nothing drawn yet (null) is never the same.
export const sameLines = (lines, drawn) => (
  JSON.stringify(lines) === JSON.stringify(drawn)
);

// The render moves the pane: the fold or the emptiness changes, the
// lines differ from those drawn, or the nudge comes or goes.
// `nudgeShown` is whether the nudge shows now.
export const changed = ({ next, was, lines, drawn, nudge, nudgeShown }) => (
  next.fold !== was.fold
    || next.empty !== was.empty
    || !sameLines(lines, drawn)
    || !nudge === nudgeShown
);

// The readouts' labels: the bars' link back to the cart, and the pill.
export const readoutLabels = ({ countText, total }) => ({
  link: `${countText}, total ${total}. Go to the cart.`,
  pill: `${countText}, total ${total}. Show or hide the cart.`,
});

// Changing a paid order: what is paid, a fee a missed delivery kept
// (#193), and the difference to pay or to get back. A kept fee always
// has its day: `orders attempted` dates the miss.
export const editMoney = ({ held, kept, keptDate, total }) => {
  const diff = total - (held - kept);

  return {
    paid: dollars(held),
    kept: `−${dollars(kept)}`,
    keptLabel: kept ? `Delivery fee for the trip on ${label(keptDate)}` : "",
    dueLabel: diff < 0 ? "We refund" : "You pay",
    due: dollars(Math.abs(diff)),
  };
};

// The shared row's switch: the way the page holds is pressed, a way
// the form says cannot be picked is disabled, and the row's button is
// named by the pressed way (`choices` holds each button's way and
// name). The cart never picks one of its own (#203). A way the switch
// doesn't hold, Group orders (#749), is named by the form.
export const wayButtons = ({ method, ways, choices }) => {
  const held = choices.find(({ way }) => way === method);

  return {
    buttons: choices.map(({ way }) => ({
      way, pressed: way === method, disabled: ways[way] === false,
    })),
    name: (held && held.name) || ways.name || "Pickup or delivery",
  };
};

// Scrolled past: a settled cart on a screen that is not short, whose
// slot's bottom edge (`slotBottom`, in the viewport) has come within
// PASSED_AT of the screen's top.
export const passedBy = ({ placement, short, slotBottom }) => (
  placement === "inline" && !short && slotBottom < PASSED_AT
);

// The badge keys of the day's bulk tiers. `money` is moneyOn()'s.
export const tierKeys = (money) => money.bulkTiers.map(
  (t) => `tier-${t.threshold}`
);

// The delivery badge's tip, with the day's minimum.
export const deliveryTip = (tip, money) => tip.replace(
  /^Orders of \$\d+ or more/,
  `Orders of $${money.deliveryMinimum} or more`
);

// The pill's word, which is the floating pane's alone: "Hide" while it
// is open and "Expand" while it is not. A pane that does not float
// has none (null). `s` is a state.mjs record.
export const pillWord = (s) => {
  if (s.placement !== "floating") return null;

  return s.fold === "open" ? "Hide" : "Expand";
};
