// Which section of the order page is current, from where each one is
// (docs/refactors/order-form.md, phase 1). Pure: section-spy.js
// measures the page and names what these choose. Positions are px from
// the screen's top, as getBoundingClientRect gives them; a section's
// key is whatever the spy gives, and only compared.

import { showing } from "../lib/sections.mjs";

// The lower edge of whichever bars are stuck at the top: the lowest
// bottom among the bars that are shown and whose top is within 1 px of
// the screen's, or 0. `bars` is [{ shown, top, bottom }].
export const barEdge = (bars) => bars.reduce(
  (low, bar) => (bar.shown && bar.top <= 1 ? Math.max(low, bar.bottom) : low),
  0
);

// A section counts unless it is stuck, is not shown (a category "In
// stock" hides measures top 0, so once the sections below it had
// scrolled above the screen it was the lowest above the line, #702),
// or is the cart while the cart is a column beside the others.
const counts = (section, column) => section.shown && !section.stuck
  && !(column && section.cart);

// A section is current once its top reaches `line`, the lower edge of
// whichever bar is stuck at the top, less a little so a jump to it
// lands inside it. On a tie the later link wins: a category over the
// catalog. At the foot of the page (`end`) the last section on screen
// wins, since it may be too short ever to reach the line. The key, or
// null.
export const pickSection = ({ sections, line, end, screen, column }) => {
  let current = null;
  let best = -Infinity;

  for (const section of sections.filter((s) => counts(s, column))) {
    const { top } = section;

    if ((top <= line || (end && top < screen)) && (top >= best || end)) {
      best = top;
      current = section.key;
    }
  }

  return current;
};

// Within the catalog, the category is the one whose rows are under the
// bar: the first row with more than a sliver showing below its edge
// names it (#274, #561). Every row gone above the bar, the catalog
// names no category (#702). `rows` is [{ cat, top, bottom }], top to
// bottom, with each row's category's key.
export const inCatalog = ({ given, catalog, rows, edge, screen }) => {
  const row = rows.find((r) => showing(r, edge));

  if (row && row.top < screen) return row.cat || given;
  if (!row) return catalog || given;

  return given;
};

// Below lg the bar drops the page name: it shows a category's name or
// nothing (#327). The other bars show the section's.
export const barTitle = ({ name, cat, phone }) => (
  !cat && phone ? "" : name
);
