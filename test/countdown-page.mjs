// The page and clock the countdown guards of #957 share
// (countdown-unchanged.test.mjs and cutoff-passed-once.test.mjs): the
// group's open rounds, a form holding Delivery's notice and Group
// orders' close notice, and a way to stop each run's timers.

import { mock } from "node:test";

import {
  addDays, today,
} from "../assets/scripts/order/lib/zoned.mjs";
import { groupDates } from "../netlify/functions/group.mjs";
import { groupOf } from "../netlify/functions/lib/groups.mjs";
import terms from "../netlify/functions/lib/terms.mjs";

export const VFF = groupOf("vff");

// The group's open rounds at `now`, as /api/group lists them.
export const rounds = (now) => groupDates(VFF, now, {
  PICKUP_SCHEDULE: `${addDays(today(now, terms.timeZone), 1)} 09:00-12:00`,
}).map((d) => ({ ...d, name: VFF.name }));

// Every DateLists a run made, so the next run can stop its timers.
export const made = [];

// The last run's page and clock stopped, so each run starts clean.
export const stop = () => {
  for (const lists of made.splice(0)) {
    clearTimeout(lists.timer);
    clearTimeout(lists.closing);
    clearTimeout(lists.again);
  }
  mock.timers.reset();
};

// A form holding Delivery's notice (`chip`, `text`) and Group orders'
// close notice.
export const form = (chip, text) => {
  const close = { dataset: {}, hidden: false, textContent: "" };

  close.querySelector = () => close;

  return {
    querySelector: (sel) => {
      if (sel === "[data-countdown]") return chip;
      if (sel === "[data-countdown-text]") return text;
      if (sel.includes("data-group-close")) return close;

      return null;
    },
    querySelectorAll: () => [],
  };
};

// Settles the page's promises: a failed fetch, then its retry.
export const settle = () => new Promise((done) => { setImmediate(done); });
