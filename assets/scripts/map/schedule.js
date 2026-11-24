// The schedule (#861, phase 3 of docs/refactors/map.md): /api/events
// orders the list, read at view time, and what ends while the page is
// open leaves the list and the map. map.js hands it what to do after.

import { expire, number } from "./seasons.js";
import { arranged } from "./seasons.mjs";

// /api/events' events (what the farm attends), or null where it fails.
const eventsOf = async () => {
  try {
    const res = await fetch("/api/events", { cache: "no-store" });
    const data = res.ok ? await res.json() : null;

    return data && Array.isArray(data.events) ? data.events : null;
  } catch {
    return null;
  }
};

// The list's rows put in the order arranged gives them.
const arrange = (list, events) => {
  const ul = list.querySelector(".map-key-list");
  const items = [...list.querySelectorAll(".map-key-list > li")]
    .map((li) => ({ location: li.dataset.location, li }));

  ul.append(...arranged(items, events).map((item) => item.li));
};

// The list ordered and numbered again, then `ordered` called. A
// request that fails leaves the list as built.
export const schedule = async (map, list, ordered) => {
  if (!list) return;

  const events = await eventsOf();

  if (!events) return;
  arrange(list, events);
  number(map);
  ordered();
};

// On each return to the page, what has ended goes and the rest are
// numbered again; `ended` is handed the pins that remain.
export const watchSeasons = (map, ended) => {
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) return;
    expire(map);
    number(map);
    ended([...map.querySelectorAll("[data-map-pin]")]);
  });
};
