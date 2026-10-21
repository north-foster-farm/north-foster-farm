// Lookups over data/catalog.json. The SKU is the identifier everywhere.

// A group label without its parenthetical: "Eggs (per dozen)" -> "Eggs".
// The parenthetical is for the form; a line is named by the short
// form everywhere else (the cart, the emails, the Square order).
export const short = (label) => label.replace(/ \(.*\)$/, "");

// A pack label as a line shows it (#278): a letter first is a capital,
// "under 3.0 lbs" -> "Under 3.0 lbs"; a figure first stays. The
// catalog and Square keep their own.
export const packLabel = (label) =>
  label.charAt(0).toUpperCase() + label.slice(1);

// How a line is named in the cart, the emails and errors (#267). Most
// groups name it "Group, label": "Wings, 1.0 – 1.9 lbs". A group whose
// `lines` is "name" uses each item's own name instead, as Other Items
// does, its group name saying nothing: "Livers, 1.0 – 1.4 lbs".
// `row` is the line under its group's heading in a grouped cart.
const lineNames = (group, item) => (group.lines === "name"
  ? { lineName: item.name, row: item.name }
  : { lineName: `${short(group.label)}, ${item.label}`, row: item.label });

// A SKU as the catalog knows it now: an old one, from a past order's
// Reorder link or a saved cart, through the renames in
// data/skuAliases.json (docs/sku-map.csv, #267). Never an order-edit
// shim: an order holding an old SKU can't be changed.
export const current = (sku, aliases = {}) =>
  (Object.hasOwn(aliases, sku) ? aliases[sku] : sku);

export const indexCatalog = (catalog) => {
  const index = new Map();

  for (const group of catalog.groups) {
    for (const item of group.items) {
      index.set(item.sku, {
        ...item,
        groupKey: group.key,
        groupLabel: group.label,
        groupName: short(group.label),
        ...lineNames(group, item),
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
