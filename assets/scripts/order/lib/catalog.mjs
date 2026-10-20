// Lookups over data/catalog.json. The SKU is the identifier everywhere.

// A group label without its parenthetical: "Eggs (per dozen)" -> "Eggs".
// The parenthetical is for the form; a line is named by the short
// form everywhere else (the cart, the emails, the Square order).
export const short = (label) => label.replace(/ \(.*\)$/, "");

// A pack label as a line shows it (#278): a letter first is a capital,
// "up to 1.9 lbs" -> "Up to 1.9 lbs"; a figure first stays. The
// catalog and Square keep their own.
export const packLabel = (label) =>
  label.charAt(0).toUpperCase() + label.slice(1);

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

// An archived item is hidden everywhere and never sold, whatever its
// stock (#267). Every other restock type ("seasonal", "soon",
// "hiatus", "discontinued") only labels an item while it is out:
// stock wins.
export const archived = (item) => !!item && item.restock === "archived";

export const inStock = (catalog) => [...indexCatalog(catalog).values()]
  .filter((item) => item.inStock && !archived(item));
