// Framing a box on the map (#409): the view that holds a town's whole
// outline, a margin to spare on every side and more on a side where
// something covers the map (the zoom buttons, a tag, the ZIP field).
// No DOM: map.js measures, this works out the view.

// A cover wider than this share of the frame sits along its top or
// bottom edge; a narrower one, along its left or right.
const SPANS = 0.6;

// The room each side must keep clear, in pixels: `base` on all four,
// more where a cover reaches in from that edge. Frame and covers are
// rectangles { left, top, right, bottom } in the same pixels.
export const clearance = (frame, covers, base) => {
  const room = { ...base };
  const width = frame.right - frame.left;
  const height = frame.bottom - frame.top;

  for (const c of covers) {
    const over = c.right > frame.left && c.left < frame.right
      && c.bottom > frame.top && c.top < frame.bottom;

    if (!over) continue;
    if ((c.right - c.left) / width >= SPANS) {
      const top = (c.top + c.bottom) / 2 < (frame.top + frame.bottom) / 2;

      if (top) room.top = Math.max(room.top, c.bottom - frame.top + base.top);
      else room.bottom = Math.max(room.bottom,
        frame.bottom - c.top + base.bottom);
    } else if ((c.left + c.right) / 2 < (frame.left + frame.right) / 2) {
      room.left = Math.max(room.left, c.right - frame.left + base.left);
    } else {
      room.right = Math.max(room.right, frame.right - c.left + base.right);
    }
  }
  // A cover can never leave less than a tenth of the frame to show in.
  room.left = Math.min(room.left, width * 0.45);
  room.right = Math.min(room.right, width * 0.45);
  room.top = Math.min(room.top, height * 0.45);
  room.bottom = Math.min(room.bottom, height * 0.45);

  return room;
};

// The view { x, y, w, h } in map units that puts `box` { x, y, width,
// height } in the middle of what the frame (pixels { width, height })
// leaves after `room`, as large as fits, but no nearer than `maxZoom`
// times the whole map (`whole` { w, h }). It keeps the frame's shape.
// The caller clamps it to the map.
export const fit = (box, frame, room, whole, maxZoom) => {
  const availX = Math.max(1, frame.width - room.left - room.right);
  const availY = Math.max(1, frame.height - room.top - room.bottom);
  const scale = Math.min(
    availX / Math.max(box.width, 1e-6),
    availY / Math.max(box.height, 1e-6),
    maxZoom * frame.width / whole.w
  );
  const w = frame.width / scale;
  const h = frame.height / scale;

  return {
    w,
    h,
    x: box.x + box.width / 2 - (room.left + availX / 2) / scale,
    y: box.y + box.height / 2 - (room.top + availY / 2) / scale,
  };
};
