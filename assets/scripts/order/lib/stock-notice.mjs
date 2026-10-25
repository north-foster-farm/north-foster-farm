// The notice over the cart when a stock check changed it (#400, item
// 20, James's words). Each change is a sentence of its own: a line
// brought down to what is left, or a line taken out. A quantity
// lowered is never "sold": nothing was.

// -> the name as it sits in a sentence. A name with a comma of its own
// ("Whole Chicken, 3.0 – 3.4 lbs") takes a second one after it to close
// the pair; a name without one ("Wings") takes none. A name may end in
// a period of its own ("Feet, 1 lb avg."); the comma after it reads
// fine.
const named = (name) => (name.includes(",") ? `${name},` : name);

// -> the sentence for one change: { name, left } for a lowered
// quantity, { name } for a line removed.
const says = ({ name, left }) => {
  if (left === undefined) {
    return `${named(name)} is out of stock, so we removed it from your cart.`;
  }

  return left === 1
    ? `Only 1 of ${named(name)} is in stock, so we lowered your quantity.`
    : `Only ${left} of ${named(name)} are in stock, so we lowered your`
      + " quantity.";
};

// -> the notice for a list of changes, or "" when there are none.
export const stockNotice = (changes) => {
  if (!changes.length) return "";

  const lead = changes.length === 1
    ? "Available stock changed for an item in your cart, so we updated it."
    : "Available stock changed for some items in your cart, so we updated it.";

  return [lead, ...changes.map(says)].join(" ");
};
