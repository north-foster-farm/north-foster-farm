// Where the cart's "N more" buttons take its list, and how much of the
// screen's foot the keyboard covers. Pure, so the tests can reach them.

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

// How far a scrolling pane must move to bring a row's foot into its
// view: the gap between the row's bottom and the pane's, never
// negative. Both are { bottom } in the viewport; a row already inside
// needs none.
export const scrollIntoPane = (row, pane) =>
  Math.max(0, Math.round(row.bottom - pane.bottom));

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

// The room the lines need at the least: from the top of the list to
// the foot of its third row, the list's own padding, and the strip for
// the "more" pills while the rows overflow. `rows` are { top, bottom }
// in the list's space; `listHeight` is the list's scroll height.
export const rowsFloor = (rows, listHeight, padding, strip, keep = 3) => {
  if (!rows.length) return 0;

  const last = rows[Math.min(keep, rows.length) - 1];

  return Math.ceil(
    Math.min(last.bottom + padding, listHeight)
      + (rows.length > keep ? strip : 0)
  );
};

// How the phone pane fits its room (#448). `pane` is what never gives
// way (the total row, the foot, the pane's padding), `fold` the part
// above the total row at its floor, `below` what is under the total
// row at its natural height, `keep` the part of that which never gives
// way either (the open code row and the dark rule above it), and
// `room` the height the pane may take. The floor is the three summed;
// past the room the pane is tight and what is under the total row
// scrolls. The fold keeps its whole floor while the room holds it
// beside the pane and the kept row, and the room left otherwise: then
// it scrolls as a whole, never clipped, and the field and Apply keep
// their room on the smallest phones.
//
// On the lines, `rows` is their part of the fold: three rows and the
// "more" strip. Under the keyboard on a small phone the room is short
// of the fold beside the pane and the kept row (#476), and the rows
// give way first, by what the fold lacks, down to none: the list stays
// behind its "more" strip and the total row, Hide and Proceed to
// checkout keep the pane. `keep` comes back as the room the parts
// under the total row hold at the least, the kept row or what the pane
// leaves of it.
export const paneFit = ({ pane, fold, below, keep = 0, rows = 0 }, room) => {
  const floor = pane + fold + below;
  const fits = Math.min(fold, Math.max(0, room - pane - keep));

  return {
    floor: Math.ceil(floor),
    fold: Math.ceil(fits),
    rows: Math.ceil(Math.max(0, rows - (fold - fits))),
    keep: Math.ceil(Math.min(keep, Math.max(0, room - pane))),
    tight: floor > room,
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
