// Which part of the cart takes an Escape pressed in it
// (docs/refactors/cart.md, phase 6). Pure: cart.js asks, and the part
// named acts.

import { escape } from "./state.mjs";

// In order (#569, #706, #531, #159): an open badge or Proceed tooltip
// (`tipOpen`); Clear cart while it asks for its second press
// (`clearAsking`); the shared row while a side of it is open (`share`,
// state.mjs's); then the fold, when state.mjs's escape takes the key
// for `state`. Null when Escape is not the cart's.
export const escapeStep = ({ tipOpen, clearAsking, share, state }) => {
  if (tipOpen) return "tips";
  if (clearAsking) return "clear";
  if (share) return "row";

  return escape(state).handled ? "fold" : null;
};
