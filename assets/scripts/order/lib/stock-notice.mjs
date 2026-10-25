// The notice over the cart when a stock check changed it (#400, item
// 20, James's words). Each change is a sentence of its own, the item's
// full name, a colon, then what happened: a line brought down to what
// is left, or a line taken out. A quantity lowered is never "sold":
// nothing was. The colon reads the same whether or not the name has a
// comma of its own ("Whole Chicken, 3.0 – 3.4 lbs" or "Wings").

// -> the sentence for one change: { name, left } for a lowered
// quantity, { name } for a line removed.
const says = ({ name, left }) => (left === undefined
  ? `${name}: out of stock, so we removed it from your cart.`
  : `${name}: only ${left} left in stock, so we lowered your quantity.`);

// -> the notice for a list of changes, or "" when there are none.
export const stockNotice = (changes) => {
  if (!changes.length) return "";

  const lead = changes.length === 1
    ? "Available stock changed for an item in your cart, so we updated it."
    : "Available stock changed for some items in your cart, so we updated it.";

  return [lead, ...changes.map(says)].join(" ");
};
