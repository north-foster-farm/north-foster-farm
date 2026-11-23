// The cart's lines (docs/refactors/cart.md, phase 2): each category,
// with its tiers indented beneath, from the templates in the markup
// (so PurgeCSS keeps their classes).

import { packLabel } from "../lib/catalog.mjs";
import { all, qs } from "./dom.js";
import { sameLines } from "./plan.mjs";

const drawLine = (lineTpl, item) => {
  const li = lineTpl.content.cloneNode(true);
  const remove = qs(li, "[data-remove]");

  remove.dataset.remove = item.sku;
  remove.setAttribute(
    "aria-label", `Remove ${item.lineName} from your cart`
  );
  qs(li, "[data-line-name]").textContent = packLabel(item.row);
  qs(li, "[data-line-qty]").textContent = item.qtyText;
  qs(li, "[data-line-sub]").textContent = item.subtotal;

  return li;
};

const drawGroup = ({ groupTpl, lineTpl }, group) => {
  const g = groupTpl.content.cloneNode(true);
  const items = qs(g, "[data-group-items]");

  qs(g, "[data-group-name]").textContent = group.label;
  for (const item of group.items) items.appendChild(drawLine(lineTpl, item));

  return g;
};

// Draws `groups`, the summary's, into `list`, unless they are the
// lines `drawn` last. Rebuilt only when the lines change: a render
// that follows a field's change event would otherwise replace the ×
// under the pointer between press and release, and the click would
// be lost (#155).
//
// A cart that empties keeps its old lines drawn while they ease out
// with the pane (#559: the clear left an empty box), and drops them
// once the ease is over (dropRows). Returns the lines now drawn.
export const drawItems = (root, list, groups, drawn) => {
  if (sameLines(groups, drawn) || !groups.length) return groups;

  const tpl = {
    groupTpl: qs(root, "template[data-cart-group]"),
    lineTpl: qs(root, "template[data-cart-line]"),
  };

  for (const row of all(list, ":scope > *")) row.remove();
  for (const group of groups) list.appendChild(drawGroup(tpl, group));

  return groups;
};

// The lines an emptied cart kept for its ease (drawItems), gone.
export const dropRows = (list, drawn) => {
  if (!drawn || drawn.length) return;
  for (const row of all(list, ":scope > *")) row.remove();
};
