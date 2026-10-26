// Where the cart's "N more" buttons take its list, how much of the
// screen's foot the keyboard covers, and whether the rail's Cart link
// rings the cart. Pure, so the tests can reach them.

// Rows are { top, bottom } in the list's own scroll space; `view` is
// { top, height, full } (scrollTop, clientHeight, scrollHeight). Down:
// the first row not fully in view goes to the top edge. Up: the
// earliest row within four fifths of a screen above does. Never past
// either end.
export const moreStop = (rows, view, dir) => {
  const max = Math.max(0, view.full - view.height);
  let top = view.top;

  if (dir > 0) {
    const next = rows.find((row) => row.bottom > view.top + view.height + 1);

    if (next) top = next.top;
  } else {
    const reach = view.top - view.height * 0.8 - 1;
    const prev = rows.find(
      (row) => row.top >= reach && row.top < view.top - 1
    );

    top = prev ? prev.top : 0;
  }

  return Math.min(max, Math.max(0, Math.round(top)));
};

// Safari on iOS keeps the layout viewport at full height under the
// keyboard and shrinks only the visual one. The gap under the visual
// viewport is the keyboard. A gap under a toolbar's worth is not one.
export const keyboardInset = (layoutHeight, visual, least = 120) => {
  if (!visual) return 0;

  const gap = layoutHeight - (visual.offsetTop + visual.height);

  return gap >= least ? Math.round(gap) : 0;
};

// The part of the screen the page can use, as the visual viewport sees
// it: its height, and the gap between its foot and the layout
// viewport's. A gap under a keyboard's worth is a browser toolbar that
// covers the page's foot; the floating cart must sit above it.
export const visibleArea = (layoutHeight, visual, least = 120) => {
  if (!visual) return { height: layoutHeight, gap: 0 };

  const gap = Math.max(0, layoutHeight - (visual.offsetTop + visual.height));

  return {
    height: Math.round(visual.height),
    gap: gap < least ? Math.round(gap) : 0,
  };
};

// Whether the rail's Cart link rings the cart (#337). From xl the cart
// is a column beside the catalog, on screen already, so the link rings
// it every time. Below xl it rings only a cart that was in view when
// the link was pressed: wholly on screen, or filling it. `rect` is the
// cart's { top, bottom } in the viewport; `height` the screen's.
export const ringsCart = (column, rect, height) => {
  if (column) return true;

  const whole = rect.top >= -1 && rect.bottom <= height + 1;
  const fills = rect.top <= 0 && rect.bottom >= height;

  return rect.bottom > rect.top && (whole || fills);
};
