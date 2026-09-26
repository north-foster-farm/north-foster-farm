// Tells the header's cart badge how many items the cart holds now.
export const announceCart = (count) => document.dispatchEvent(
  new CustomEvent("nff:cart", { detail: { count } }));
