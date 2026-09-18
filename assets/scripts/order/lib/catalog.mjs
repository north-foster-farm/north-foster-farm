// Lookups over data/catalog.json. The SKU is the identifier everywhere.

export const indexCatalog = (catalog) => {
  const index = new Map();

  for (const group of catalog.groups) {
    for (const item of group.items) {
      index.set(item.sku, {
        ...item,
        groupKey: group.key,
        groupLabel: group.label,
      });
    }
  }

  return index;
};

export const inStock = (catalog) =>
  [...indexCatalog(catalog).values()].filter((item) => item.inStock);
