// Where things stand over the map, in sums (#860, phase 2 of
// docs/refactors/map.md): the dropped pin's tag and the pointer's tip.
// No DOM: draw.js measures and writes, this works out the place.
// Positions are px from the frame's corner, { left, top }; a box is an
// element's size, { w, h }; a frame's is { width, height }.

// How far the tag and the cards keep from the frame's edges.
export const MARGIN = 8;

// How far the tip stands from the pointer, across and down.
export const TIP_GAP = 14;

// Above a point where there is room, else below it, never past an
// edge: an element over the map, "lift" pixels above its tip. `at` is
// the point with the frame's size.
export const standAt = ({ at, box, lift }) => {
  const { w, h } = box;
  const left = Math.max(MARGIN, Math.min(at.width - w - MARGIN,
    at.x - w / 2));
  const above = at.y - lift - 6 - h;
  const top = Math.max(MARGIN, Math.min(at.height - h - MARGIN,
    above >= MARGIN ? above : at.y + MARGIN));

  return { left, top };
};

// The zoom stands over the map's top right: an element that would
// cover it moves aside, left of it where there is room, else under.
// `zoom` is the buttons' { left, right, top, bottom } in the frame.
export const clearOf = ({ place, box, zoom }) => {
  const { left, top } = place;
  const { w, h } = box;

  if (left + w <= zoom.left || left >= zoom.right || top + h <= zoom.top
    || top >= zoom.bottom) return { left, top };
  if (zoom.left - w - 6 >= MARGIN) return { left: zoom.left - w - 6, top };

  return { left, top: zoom.bottom + 6 };
};

// The tip below and right of the pointer, or on the pointer's other
// side where it would pass the frame's edge.
export const tipAt = ({ pointer, box, frame }) => {
  const { x, y } = pointer;
  const past = (p, size, room) => p + TIP_GAP + size > room - MARGIN;

  return {
    left: past(x, box.w, frame.width) ? x - TIP_GAP - box.w : x + TIP_GAP,
    top: past(y, box.h, frame.height) ? y - TIP_GAP - box.h : y + TIP_GAP,
  };
};

// A point, with the frame's size, inside the frame or on its edge.
export const inFrame = (at) => !(at.x < 0 || at.x > at.width || at.y < 0
  || at.y > at.height);
