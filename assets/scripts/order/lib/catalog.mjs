// Lookups over data/catalog.json. The SKU is the identifier everywhere.

// A group label without its parenthetical: "Eggs (per dozen)" -> "Eggs".
// The parenthetical is for the form; a line is named by the short
// form everywhere else (the cart, the emails, the invoice).
export const short = (label) => label.replace(/ \(.*\)$/, "");

export const indexCatalog = (catalog) => {
  const index = new Map();

  for (const group of catalog.groups) {
    for (const item of group.items) {
      index.set(item.sku, {
        ...item,
        groupKey: group.key,
        groupLabel: group.label,
        groupName: short(group.label),
      });
    }
  }

  return index;
};

export const inStock = (catalog) =>
  [...indexCatalog(catalog).values()].filter((item) => item.inStock);
