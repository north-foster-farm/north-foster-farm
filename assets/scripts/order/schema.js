// Brings the page's Product markup in step with /api/stock (#191):
// the build wrote each Offer's availability from the catalog, and the
// stock the page just heard of wins. A discontinued item stays so. A
// hidden one (#492) leaves the markup while it is out, and comes back
// when stock does.

const IN = "https://schema.org/InStock";
const OUT = "https://schema.org/OutOfStock";
const GONE = "https://schema.org/Discontinued";

// -> the graph with each Offer's availability set from `items`
// ({ sku: { inStock } }) and without each SKU in `hidden` that is
// out, or null when nothing changed.
export const withStock = (data, items, hidden = new Set()) => {
  let changed = false;
  const graph = [];

  for (const node of data["@graph"] || []) {
    const state = node["@type"] === "Product" && items[node.sku];
    const offer = state && node.offers;

    if (offer && !state.inStock && hidden.has(node.sku)) {
      changed = true;
      continue;
    }
    graph.push(node);
    if (!offer || offer.availability === GONE) continue;

    const next = state.inStock ? IN : OUT;

    if (offer.availability !== next) {
      offer.availability = next;
      changed = true;
    }
  }

  return changed ? { ...data, "@graph": graph } : null;
};

// The markup as built, so a hidden item taken out can come back.
let built;

export const syncSchema = (items, hidden) => {
  const script = document.getElementById("ld-json");

  if (!script || !items) return;

  try {
    built ??= script.textContent;

    const data = withStock(JSON.parse(built), items, hidden);
    const text = data ? JSON.stringify(data) : built;

    if (script.textContent !== text) script.textContent = text;
  } catch {
    // The markup stays as built.
  }
};
