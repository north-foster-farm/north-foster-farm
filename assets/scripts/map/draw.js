// What the map writes over itself (#860, phase 2 of
// docs/refactors/map.md): the tag's contents and where the tag and the
// tip stand, and (#862, phase 4) the view. It measures and writes;
// stand.mjs, tag.mjs and view.mjs work out what.

import { TIP_GAP, clearOf, standAt, tipAt } from "./stand.mjs";
import { MAX_ZOOM, NUDGE_BELOW, NUDGE_PX, pinScale } from "./view.mjs";

// A pin's transform: its tip at x, y in map units, scaled by s.
const pinAt = (x, y, s) => `translate(${x} ${y}) scale(${s})`;

// The view: the viewBox, and everything that must keep its size on
// screen whatever the zoom (pins, the dropped pin). `k` is the zoom,
// `width` the SVG's on screen in px, and `atHome` whether the view is
// the layer's own, where the reset has nothing to do.
export const drawView = (parts, view, pins, { k, width, atHome }) => {
  const { svg, dropAt, zoomIn, zoomOut, reset } = parts;
  const units = view.w / width;
  const s = pinScale(view, width);
  const nudged = k < NUDGE_BELOW;

  svg.setAttribute("viewBox", `${view.x} ${view.y} ${view.w} ${view.h}`);
  for (const pin of pins) {
    const dx = nudged ? Number(pin.dataset.nudge || 0) * NUDGE_PX * units
      : 0;

    pin.setAttribute("transform",
      pinAt(Number(pin.dataset.x) + dx, pin.dataset.y, s));
  }
  if (dropAt.dataset.x) {
    dropAt.setAttribute("transform",
      pinAt(dropAt.dataset.x, dropAt.dataset.y, s));
  }
  zoomIn.disabled = k >= MAX_ZOOM - 0.01;
  zoomOut.disabled = k <= 1.01;
  reset.hidden = atHome();
  // Zoomed in, a drag pans the map; at full size it scrolls the page.
  svg.style.touchAction = k > 1.01 ? "none" : "pan-y";
};

const sizeOf = (el) => ({ w: el.offsetWidth, h: el.offsetHeight });

const put = (el, { left, top }) => {
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
};

// An element's box in px from the frame's corner.
const boxIn = (frame, el) => {
  const f = frame.getBoundingClientRect();
  const z = el.getBoundingClientRect();

  return {
    left: z.left - f.left,
    right: z.right - f.left,
    top: z.top - f.top,
    bottom: z.bottom - f.top,
  };
};

// An element over a point on the map, "lift" pixels above it, then
// clear of the zoom buttons. `at` is the point with the frame's size.
export const standOn = (el, at, { lift, frame, zoom }) => {
  const place = standAt({ at, box: sizeOf(el), lift });

  put(el, place);
  put(el, clearOf({ place, box: sizeOf(el), zoom: boxIn(frame, zoom) }));
};

// The tip beside the pointer, in px from the frame's corner, inside
// the frame's box.
export const drawTip = (tip, pointer, frame) => {
  put(tip, { left: pointer.x + TIP_GAP, top: pointer.y + TIP_GAP });
  put(tip, tipAt({ pointer, box: sizeOf(tip), frame }));
};

// The tag, from tagFacts. "el" is the dropped pin's tag or the
// pointer's; `mark` writes each icon's data-on, on the dropped pin's.
export const drawTag = (el, facts, { mark }) => {
  const [town, eggs, hen, price, none] = [
    ".map-tag-town", ".map-tag-icon:nth-of-type(1)",
    ".map-tag-icon:nth-of-type(2)", ".map-tag-fee", ".map-tag-none",
  ].map((s) => el.querySelector(s));

  town.textContent = facts.town;
  price.textContent = facts.price;
  price.hidden = facts.none;
  none.hidden = !facts.none;
  for (const [icon, on] of [[eggs, facts.eggs], [hen, facts.hen]]) {
    icon.classList.toggle("is-off", !on);
    if (mark) icon.dataset.on = on;
  }
  const link = el.querySelector(".map-tag-link");

  if (link) link.hidden = !facts.link;
};
