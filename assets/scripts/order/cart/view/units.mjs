// Lengths for the cart view, as pixels (docs/refactors/cart-view.md).

// A CSS length from a custom property, as pixels: "9.25rem", "148px"
// or a bare number. `rootFont` is the root's font size in px.
export const toPx = (value, rootFont = 16) => {
  const text = String(value || "").trim();
  const n = parseFloat(text);

  if (!Number.isFinite(n)) return 0;
  if (text.endsWith("rem")) return n * rootFont;
  if (text.endsWith("em")) return n * rootFont;

  return n;
};

// What the floating pane rests on, from the foot of the layout
// viewport: the margin, the toolbar's gap and the keyboard. The safe
// area, which only CSS can read, is the one term left out, so a
// threshold built on this is off by it on a phone with a home
// indicator and Safari's bar hidden: the seam moves by that much and
// nothing else does.
export const restOf = ({ margin = 8, gap = 0, kb = 0 }) => margin + gap + kb;
