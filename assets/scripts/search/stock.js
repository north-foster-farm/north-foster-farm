// What a product result says of its stock (#402), the one place search
// reads stock. Live stock wins: /api/stock, fetched as search first
// opens (site-search.js), passed here as `live` ({ sku: { inStock } };
// James, 2026-11-21, as the palette did, #267, #492). Until it
// answers, or if it fails, the index's word stands: the catalog's
// `inStock` as /search.json carries it.

// -> { out, label }: whether the product is out of stock, and what its
// result says ("In stock", or its restock label, "Back in spring").
export const stockOf = (entry, live = null) => {
  const known = live && live[entry.sku];
  const out = known ? known.inStock === false : !!entry.out;

  return { out, label: out ? entry.restock : "In stock" };
};

// -> whether a product is listed: one out of stock with no restock
// label is hidden on the order page at either choice, so search leaves
// it out too, as the palette did.
export const listed = (entry, live = null) => (
  !stockOf(entry, live).out || !!entry.restock);
