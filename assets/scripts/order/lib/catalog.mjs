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

// An item's label with its grade, where the catalog gives one (#300,
// Rhode Island's 250-RICR-40-20-7 wants grade and size on the
// invoice): "Grade A Large". The catalog's `grade` is the one source.
// Only Square's line takes it (#318): everywhere else the grade is a
// note beside the name, never part of it.
export const graded = (item) => (item.grade
  ? `${item.grade} ${item.label}` : item.label);

// How a line is named in the cart, the emails and errors (#267). Most
// groups name it "Group, label": "Wings, 1.0 – 1.9 lbs", "Eggs, Large"
// (a grade is a note, never in the name, #318). A group whose `lines`
// is "name" uses each item's own name instead, as Other Items does,
// its group name saying nothing: "Livers, 1.0 – 1.4 lbs". `row` is
// the line under its group's heading in a grouped cart.
const lineNames = (group, item) => (group.lines === "name"
  ? { lineName: item.name, row: item.name }
  : {
    lineName: `${short(group.label)}, ${item.label}`,
    row: item.label,
  });

// The name sent for a Square line that goes without a variation id
// (lib/square.mjs, no catalog configured): the catalog's own, or for a
// graded item its group name and graded label. A line sent with its
// variation id, as in production, takes the name from Square's own
// catalog instead, so the egg variations there carry the grade
// themselves (#300).
const squareName = (group, item) => (item.grade
  ? `${short(group.label)}, ${graded(item)}` : item.name);

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
      const names = lineNames(group, item);

      index.set(item.sku, {
        ...item,
        groupKey: group.key,
        groupLabel: group.label,
        groupName: short(group.label),
        ...names,
        squareName: squareName(group, item),
        note: item.note || item.grade || "",
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
