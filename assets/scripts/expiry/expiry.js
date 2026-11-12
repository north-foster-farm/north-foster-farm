// A note that stops being true on a date, such as "Starting October
// 17", carries that moment in data-hide-from. The build leaves it out
// once the moment has passed; this hides it in a page built before.
// Its counterpart, data-show-from, marks something the build leaves
// hidden until its moment; this shows it in a page built before.
//
// "Now" is the site's clock (clock/now.js): the real time, or on
// staging the toolbar's set time.

import { siteNow } from "../clock/now.js";

export const expired = (from, now = siteNow()) => {
  const at = Date.parse(from);

  return Number.isFinite(at) && now >= at;
};

// A moment that cannot be read leaves the block as built. Both ways are
// set, not just forward, so the staging toolbar's clock (#385), which
// can sit before the real time, brings back what the real time hid.
// Only what a date rule hid comes back: data-expiry marks it, so a
// block another rule hid (a skipped market, a place's badge) stays
// hidden. The build marks what it hides for a date the same way.
// Content the build left out cannot come back by moving the clock.
export const hold = (el, hide) => {
  if (hide) {
    if (!el.hidden) {
      el.hidden = true;
      el.dataset.expiry = "hid";
    }
  } else if (el.dataset.expiry === "hid") {
    el.hidden = false;
    delete el.dataset.expiry;
  }
};

export const hideExpired = (root = document, now = siteNow()) => {
  for (const el of root.querySelectorAll("[data-hide-from]")) {
    if (Number.isFinite(Date.parse(el.dataset.hideFrom))) {
      hold(el, expired(el.dataset.hideFrom, now));
    }
  }
  for (const el of root.querySelectorAll("[data-show-from]")) {
    if (Number.isFinite(Date.parse(el.dataset.showFrom))) {
      // Built hidden until its moment: that hiding is this one's.
      if (el.hidden && el.dataset.expiry === undefined) {
        el.dataset.expiry = "hid";
      }
      hold(el, !expired(el.dataset.showFrom, now));
    }
  }
};

// Whether `now` falls in a market's season: from data-season-from
// (midnight, farm time, on its first day) up to data-season-until
// (midnight after its last). A missing or unreadable end is open.
export const inSeason = (el, now = siteNow()) => {
  const from = Date.parse(el.dataset.seasonFrom);
  const until = Date.parse(el.dataset.seasonUntil);

  return (!Number.isFinite(from) || now >= from)
    && (!Number.isFinite(until) || now < until);
};

// The home page's seasonal swap (#568). The build prints both bands
// whatever its date: the market band ([data-season-band]) with every
// market in data/series.json, each with its season, and the three ways
// ([data-season-ways]). It hides, and marks, what its own date rules
// out, so a fresh page paints right with no script; this picks again
// at view time. Each market shows through its season; the band shows
// while a market that isn't a winter one ([data-winter]) runs, and the
// ways band whenever it doesn't (#544).
export const pickSeason = (root = document, now = siteNow()) => {
  const band = root.querySelector("[data-season-band]");
  const ways = root.querySelector("[data-season-ways]");

  if (!band) return null;

  let season = false;

  for (const el of band.querySelectorAll("[data-season-from]")) {
    const on = inSeason(el, now);

    hold(el, !on);
    if (on && el.dataset.winter === undefined) season = true;
  }
  hold(band, !season);
  if (ways) hold(ways, season);

  return season;
};

// Every date rule in the page, at one time.
export const followClock = (root = document, now = siteNow()) => {
  hideExpired(root, now);
  pickSeason(root, now);
};
