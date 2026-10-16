// A small matcher for a catalog of a few dozen products. Each product
// carries words from its name, group, unit and note, plus a few words
// people search by that the catalog doesn't use ("breast" for Boneless
// Breasts, "chicken" for every cut). Every word typed must start one of
// a product's words; plurals match singulars.

const ALSO = {
  eggs: "egg dozen",
  whole: "chicken bird roaster roasting",
  cornish: "chicken hen game",
  breasts: "chicken breast boneless",
  thighs: "chicken thigh bone",
  tenders: "chicken tender tenderloin",
  drums: "chicken drumstick drum leg",
  wings: "chicken wing",
  ground: "chicken ground mince",
  sausage: "chicken sausage link breakfast",
  other: "chicken offal soup stock broth",
};

const words = (text) => String(text).toLowerCase()
  .split(/[^a-z0-9.]+/)
  .map((w) => w.replace(/^\.+|\.+$/g, ""))
  .filter(Boolean)
  .map((w) => (w.length > 3 && w.endsWith("s") ? w.slice(0, -1) : w));

export const index = (products) => products.map((product, order) => ({
  product,
  order,
  words: words([
    product.group, product.label, product.unit, product.note,
    ALSO[product.key] || "",
  ].join(" ")),
}));

// -> the products that match, best first. An empty query lists them
// all, in catalog order.
export const search = (indexed, query) => {
  const typed = words(query);

  if (!typed.length) return indexed.map((entry) => entry.product);

  const scored = [];

  for (const entry of indexed) {
    let score = 0;
    let every = true;

    for (const word of typed) {
      const at = entry.words.findIndex((w) => w.startsWith(word));

      if (at === -1) {
        every = false;
        break;
      }
      // A whole word beats a prefix; an early word beats a late one.
      score += (entry.words[at] === word ? 2 : 1) + 1 / (at + 1);
    }
    if (every) scored.push({ entry, score });
  }

  return scored
    .sort((a, b) => b.score - a.score || a.entry.order - b.entry.order)
    .map(({ entry }) => entry.product);
};
