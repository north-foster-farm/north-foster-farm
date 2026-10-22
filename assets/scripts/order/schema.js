// Brings the page's Product markup in step with /api/stock (#191):
// the build wrote each Offer's availability from the catalog, and the
// stock the page just heard of wins. A discontinued item stays so.

const IN = "https://schema.org/InStock";
const OUT = "https://schema.org/OutOfStock";
const GONE = "https://schema.org/Discontinued";

// -> the graph with each Offer's availability set from `items`
// ({ sku: { inStock } }), or null when nothing changed.
export const withStock = (data, items) => {
  let changed = false;

  for (const node of data["@graph"] || []) {
    const state = node["@type"] === "Product" && items[node.sku];
    const offer = state && node.offers;

    if (!offer || offer.availability === GONE) continue;

    const next = state.inStock ? IN : OUT;

    if (offer.availability !== next) {
      offer.availability = next;
      changed = true;
    }
  }

  return changed ? data : null;
};

export const syncSchema = (items) => {
  const script = document.getElementById("ld-json");

  if (!script || !items) return;

  try {
    const data = withStock(JSON.parse(script.textContent), items);

    if (data) script.textContent = JSON.stringify(data);
  } catch {
    // The markup stays as built.
  }
};
