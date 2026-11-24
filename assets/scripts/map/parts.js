// The map's elements (#862, phase 4 of docs/refactors/map.md), found
// once. The pins are not among them: map.js holds those, since what
// ends while the page is open replaces them.

export const partsOf = (map) => ({
  frame: map.querySelector("[data-map-frame]"),
  svg: map.querySelector("[data-map-svg]"),
  drop: map.querySelector("[data-map-drop]"),
  dropAt: map.querySelector("[data-map-drop-at]"),
  tag: map.querySelector("[data-map-drop-tag]"),
  zoomIn: map.querySelector("[data-map-zoom='in']"),
  zoomOut: map.querySelector("[data-map-zoom='out']"),
  reset: map.querySelector("[data-map-zoom='reset']"),
  tabs: [...map.querySelectorAll("[data-map-layer]")],
  list: map.querySelector(".map-places"),
  picks: [...map.querySelectorAll("[data-map-pick]")],
  towns: [...map.querySelectorAll("[data-map-town]")],
  form: map.querySelector("[data-zip-check]"),
});
