// What has ended goes, and the rest are numbered (#861, phase 3 of
// docs/refactors/map.md). It reads the markup and writes it;
// seasons.mjs works out what.

import { siteNow } from "../clock/now.js";
import { dayOf, gone, numbersOf } from "./seasons.mjs";

// Today on the visitor's clock, moved by the staging toolbar's
// (clock/now.js). Only forward: what the build left out, or expire
// removed, stays gone.
const today = () => dayOf(new Date(siteNow()));

// What has ended goes: a series on a card, a link, a row in the list,
// a pin. A card left without links loses their heading.
export const expire = (map) => {
  const day = today();
  const ended = (el) => gone(el.dataset.until, day);

  for (const el of map.querySelectorAll(".map-places [data-until]")) {
    if (ended(el)) el.remove();
  }
  for (const links of map.querySelectorAll(".map-card-links")) {
    if (links.querySelector("a")) continue;
    links.previousElementSibling.remove();
    links.remove();
  }
  for (const pin of map.querySelectorAll("[data-map-pin]")) {
    if (ended(pin)) pin.remove();
  }
};

// The numbers on the rows and the pins, in the order of the list: a
// place that has ended, or is filtered out, leaves no gap.
export const number = (map) => {
  const rows = [...map.querySelectorAll("li > [data-map-show]")];
  const numbers = numbersOf(rows.map((row) => ({
    key: row.dataset.mapShow,
    hidden: row.parentElement.hasAttribute("hidden"),
  })));

  for (const el of map.querySelectorAll("[data-map-show], [data-map-pin]")) {
    const n = numbers.get(el.dataset.mapShow || el.dataset.mapPin);

    if (n) el.querySelector("[data-map-num], .map-pin-num").textContent = n;
  }
};
