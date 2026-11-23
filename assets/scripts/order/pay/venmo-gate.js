// Whether the Venmo button works in this browser (docs/refactors/pay.md,
// phase 2). The decision is lib/venmo.mjs's, from the config's hidden
// flag, ?venmo or ?venmo=0, and what nff-venmo in localStorage
// remembers; this reads and writes the storage around it.

import { venmoGate } from "../lib/venmo.mjs";

const VENMO = "nff-venmo";

export const venmoEnabled = (hidden) => {
  let remembered = false;

  try {
    remembered = window.localStorage.getItem(VENMO) === "1";
  } catch {
    // Storage blocked: ?venmo still works for this page view.
  }

  const { enabled, remember } = venmoGate(
    hidden, location.search, remembered
  );

  try {
    if (remember) {
      window.localStorage.setItem(VENMO, "1");
    } else {
      window.localStorage.removeItem(VENMO);
    }
  } catch {
    // As above.
  }

  return enabled;
};
