// Which catalog row names the category on screen, for the phone's
// sticky bar, the sidebar outline and the total bar. Pure, so the
// tests can reach it.

// The most of a row that may still show under the bar while the next
// row names the section. A row taller than twice this, an open one or
// a wide one with its photo, counts once this much of it shows.
export const SLIVER = 48;

// A row is showing once more than a sliver of it is below `edge`, the
// lower edge of the bar stuck at the top: half the row, at most
// SLIVER, at least 8px. The last few pixels of one section, over
// another's heading and rows, were naming the section scrolled away
// (#561). `rect` is { top, bottom }, as getBoundingClientRect gives.
export const showing = (rect, edge) => {
  const height = rect.bottom - rect.top;
  const sliver = Math.max(8, Math.min(height / 2, SLIVER));

  return rect.bottom - edge > sliver;
};

// The first of `rects`, top to bottom, that is showing, or -1.
export const namingRow = (rects, edge) => rects.findIndex(
  (rect) => showing(rect, edge)
);
