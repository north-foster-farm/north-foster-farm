// What the schedule says now, read at view time. Which markets and
// pop-ups are open, attended or skipped changes without a rebuild, so
// the build prints the places and their seasons (data/series.json) and
// this reads /api/dates and /api/events over them. When a list can't
// load, the page stays as built: the drop site and the seasons.

import { seriesDates } from "../order/lib/events.mjs";
import { horizon } from "../order/lib/schedule.mjs";
import { today, weekday } from "../order/lib/zoned.mjs";

const ZONE = "America/New_York";
const MAX_OPEN = 3;

const cache = new Map();

// One request per URL per page, whoever asks. null when it fails.
const load = (url) => {
  if (!cache.has(url)) {
    cache.set(url, fetch(url, { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .catch(() => null));
  }

  return cache.get(url);
};

// The dates of a series (its start, its end or none, and the weekday
// its start falls on) in the window customers can book: today through
// the horizon.
export const windowDates = (series, now = new Date()) => seriesDates(
  { start: series.start, end: series.end || null,
    weekday: weekday(series.start) },
  today(now, ZONE),
  horizon(now, ZONE),
);

// Whether the schedule skips a series: it has a date in the window,
// and /api/events (what the farm attends, pickup or attend) has none
// of them. A series with no date in the window is not judged; its
// season reads from the build.
export const skipped = (series, events, now = new Date()) => {
  const dates = windowDates(series, now);

  return dates.length > 0 && !events.some((e) => e.series === series.code
    && dates.includes(e.date));
};

// The next open place of each series, soonest first: the first entry
// of each series in /api/dates `scheduled`, which is in date order.
export const nextPlaces = (scheduled, max = MAX_OPEN) => {
  const seen = new Set();
  const out = [];

  for (const d of scheduled) {
    if (!seen.has(d.series)) {
      seen.add(d.series);
      out.push(d);
    }
  }

  return out.slice(0, max);
};

// "Starting Oct 17" on a series' first day.
export const startingBadge = (start) => `Starting ${
  new Date(`${start}T12:00:00Z`).toLocaleDateString("en-US",
    { month: "short", day: "numeric", timeZone: "UTC" })}`;

const wireWays = async (card) => {
  const list = card.querySelector("[data-scheduled-facts]");
  const template = document.querySelector("template[data-scheduled-open]");

  if (!list || !template) return;

  const data = await load("/api/dates");
  const places = nextPlaces((data && data.scheduled) || []);

  if (!places.length) return;

  let starts = {};

  try {
    starts = JSON.parse(card.dataset.starts || "{}");
  } catch {
    starts = {};
  }
  const items = places.map((p) => {
    const item = template.content.firstElementChild.cloneNode(true);
    const badge = item.querySelector("[data-badge]");

    item.querySelector(".place-open-name").textContent = p.name;
    item.querySelector(".place-open-when").textContent =
      `${p.label}, ${p.window}`;
    item.querySelector(".place-open-where").textContent = p.short;
    if (starts[p.series] === p.date) {
      badge.textContent = startingBadge(p.date);
      badge.hidden = false;
    }

    return item;
  });

  list.prepend(...items);
  for (const el of card.querySelectorAll("[data-scheduled-static]")) {
    delete el.dataset.expiry;
    el.hidden = true;
  }
  // The build's "Starting" badge is the drop site's; each place wears
  // its own now.
  for (const el of card.querySelectorAll(".place-head .place-badge")) {
    delete el.dataset.expiry;
    el.hidden = true;
  }
};

const wireSkips = async () => {
  const marked = document.querySelectorAll("[data-series]");

  if (!marked.length) return;

  const data = await load("/api/events");

  if (!data || !Array.isArray(data.events)) return;

  const now = data.now ? new Date(data.now) : new Date();

  for (const el of marked) {
    const series = {
      code: el.dataset.series,
      start: el.dataset.start,
      end: el.dataset.end,
    };

    if (!skipped(series, data.events, now)) continue;

    // A hidden top bar still matches :root:has(.top-bar) and keeps the
    // hero's reserve; remove it as retireTopBar does.
    if (el.hasAttribute("data-top-bar")) el.remove();
    else {
      delete el.dataset.expiry;
      el.hidden = true;
    }
  }
};

// A market with a date open for pickup shows its link to order for it.
const wirePickupLinks = async () => {
  const links = document.querySelectorAll("[data-pickup-for]");

  if (!links.length) return;

  const data = await load("/api/dates");

  if (!data || !Array.isArray(data.scheduled)) return;

  const open = new Set(data.scheduled.map((d) => d.series));

  for (const link of links) {
    if (open.has(link.dataset.pickupFor)) link.hidden = false;
  }
};

export const wireSchedule = () => {
  wirePickupLinks();
  for (const card of document.querySelectorAll("[data-scheduled-ways]")) {
    wireWays(card);
  }
  wireSkips();
};
