// The cart's remove control in its other candidate tint (#560): James
// compares the brick, the default, with the farm green by adding
// ?tint=green to a staging page's address. Part of the staging bundle,
// so a deploy preview or production can't switch it. _cart.scss reads
// the attribute; _variables.scss holds the tints.

export const TINTS = ["green"];

// The tint the address asks for, or null for the default.
export const tintFrom = (search = "") => {
  const asked = new URLSearchParams(search).get("tint");

  return TINTS.includes(asked) ? asked : null;
};

export const applyTint = (root, search) => {
  const tint = tintFrom(search);

  if (tint) root.dataset.removeTint = tint;
  else delete root.dataset.removeTint;

  return tint;
};
