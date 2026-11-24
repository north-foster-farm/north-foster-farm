// The map's camera, in sums (#859, phase 1 of docs/refactors/map.md).
// No DOM: camera.js measures the SVG and keeps the view (#862), this
// works it out. A view is the SVG's viewBox, { x, y, w, h }, in map units;
// `size` the whole map's, { W, H }; a box the SVG's on screen,
// { left, top, width, height }, in pixels.

export const MAX_ZOOM = 5;

// Pins stand this tall on screen at any zoom and any width; the shape
// is drawn 45 units tall and 30 wide.
export const PIN_PX = 38;
const PIN_UNITS = 45;
const PIN_WIDTH_PX = PIN_PX * 30 / PIN_UNITS;

// Places frames its pins with a pin's height to spare, and never closer
// than a town: one pin alone is shown at this zoom (#214).
export const FIT_PAD_PX = PIN_PX;
export const FIT_MAX_ZOOM = 4;

// Below this zoom, a nudged pin stands this far aside, in screen
// pixels, so two places that meet at the whole map can both be tapped.
export const NUDGE_BELOW = 2;
export const NUDGE_PX = 14;

export const easeOut = (t) => 1 - (1 - t) ** 3;

export const zoomOf = (view, size) => size.W / view.w;

// No wider than the whole map, no narrower than a fifth of it, in the
// map's proportion, and inside it.
export const clampView = (v, { W, H }) => {
  const w = Math.min(W, Math.max(W / MAX_ZOOM, v.w));
  const h = w * (H / W);

  return {
    w,
    h,
    x: Math.min(W - w, Math.max(0, v.x)),
    y: Math.min(H - h, Math.max(0, v.y)),
  };
};

// Zoom by a factor about a point in map units. The caller clamps it.
export const zoomedAbout = (view, factor, { x, y }) => ({
  w: view.w / factor,
  h: view.h / factor,
  x: x - (x - view.x) / factor,
  y: y - (y - view.y) / factor,
});

// The box the pins' points make.
const spanOf = (pins) => {
  const xs = pins.map((p) => p.x);
  const ys = pins.map((p) => p.y);

  return {
    left: Math.min(...xs),
    right: Math.max(...xs),
    top: Math.min(...ys),
    bottom: Math.max(...ys),
  };
};

// The view of the pins' box: a pin's height of room around each, at
// no more than a town's zoom. The room a pin takes on screen, and its
// margin, come out of the view's width: solve for the width that holds
// the pins' span plus those pixels.
const pinsView = (span, { W, H }, width) => {
  const height = width * H / W;
  const roomX = PIN_WIDTH_PX + 2 * (FIT_PAD_PX + NUDGE_PX);
  const roomY = PIN_PX + 2 * FIT_PAD_PX;
  const wideX = (span.right - span.left)
    / Math.max(0.05, 1 - roomX / width);
  const wideY = (span.bottom - span.top)
    / Math.max(0.05, 1 - roomY / height) * W / H;
  const w = Math.max(W / FIT_MAX_ZOOM, wideX, wideY);
  const units = w / width;

  return {
    w,
    h: w * H / W,
    x: (span.left + span.right) / 2 - w / 2,
    // The pins stand above their tips: the box is higher by half a pin.
    y: (span.top + span.bottom) / 2 - PIN_PX / 2 * units - w * H / W / 2,
  };
};

// The layer's own view: the whole state on Delivery or with no pin
// showing; on Places the box of the showing pins' points, { x, y }.
// `width` is the SVG's on screen.
export const homeView = ({ size, layer, pins, width }) => {
  if (layer !== "places" || !pins.length) {
    return { x: 0, y: 0, w: size.W, h: size.H };
  }

  return clampView(pinsView(spanOf(pins), size, width), size);
};

// True at the layer's own view, where the globe has nothing to do.
export const atHome = (view, home) => Math.abs(home.w - view.w) < 0.5
  && Math.abs(home.x - view.x) < 0.5 && Math.abs(home.y - view.y) < 0.5;

// The camera's tween at `t`, from 0 to 1, eased out.
export const tweenAt = (from, to, t) => {
  const e = easeOut(t);

  return {
    x: from.x + (to.x - from.x) * e,
    y: from.y + (to.y - from.y) * e,
    w: from.w + (to.w - from.w) * e,
    h: from.h + (to.h - from.h) * e,
  };
};

// A point on screen, a pointer's client { x, y }, in map units.
export const toMap = (view, box, client) => ({
  x: view.x + (client.x - box.left) / box.width * view.w,
  y: view.y + (client.y - box.top) / box.height * view.h,
});

// A point in map units on screen, in pixels from the frame's corner.
export const onScreen = (view, box, point) => ({
  x: (point.x - view.x) / view.w * box.width,
  y: (point.y - view.y) / view.h * box.height,
});

export const centreOf = (view) => ({
  x: view.x + view.w / 2,
  y: view.y + view.h / 2,
});

// The view moved against a drag of { dx, dy } pixels, on an SVG
// `width` pixels wide.
export const pannedBy = (view, { dx, dy }, width) => {
  const perPixel = view.w / width;

  return { ...view, x: view.x - dx * perPixel, y: view.y - dy * perPixel };
};

// The pins' scale, as the transform's text, that keeps them PIN_PX
// tall on an SVG `width` pixels wide.
export const pinScale = (view, width) => (PIN_PX / PIN_UNITS
  * (view.w / width)).toFixed(4);
