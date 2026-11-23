// What the map writes over itself (#860, phase 2 of
// docs/refactors/map.md): the tag's contents and where the tag and the
// tip stand. It measures and writes; stand.mjs and tag.mjs work out
// what.

import { TIP_GAP, clearOf, standAt, tipAt } from "./stand.mjs";

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
