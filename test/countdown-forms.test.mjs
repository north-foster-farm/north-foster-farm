// The countdown's other forms keep their meaning when #627 adds the
// date to its sentence. The notice has no "today" or "tomorrow" form;
// what it does have, besides "Order within ... for delivery on ...",
// is listed here, each with its test:
//
//   - no delivery day on offer: "Delivery ordering is closed right
//     now."
//   - the cutoff passed while the page was open: "That cutoff just
//     passed. Updating dates…", then the lists are asked for again;
//   - the lists could not be had: "We couldn't load the dates.
//     Retrying…";
//   - how near the cutoff is: no urgency from six hours out, "soon"
//     under six hours, "last" under one, and never "0 minutes".
//
// These pass before and after #627. The seam is the one named in
// test/countdown-date.criteria.mjs: DateLists#apply with a form that
// holds the chip and its text.

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { DateLists } from "../assets/scripts/order/date-lists.js";

const made = [];
const realFetch = globalThis.fetch;

const notice = () => {
  const chip = { dataset: {} };
  const text = { textContent: "" };
  const form = {
    querySelector: (sel) => ({
      "[data-countdown]": chip,
      "[data-countdown-text]": text,
    })[sel] || null,
    querySelectorAll: () => [],
  };

  return { form, chip, text };
};

// The notice once /api/dates answers at `now` with `delivery`.
const at = (now, delivery) => {
  const { form, chip, text } = notice();
  const lists = new DateLists(form, () => {});

  made.push(lists);
  lists.apply({ now, delivery, onfarm: [], scheduled: [] });

  return { lists, chip, text };
};

// Thursday 19 November 2026, cutoff noon New York the day before.
const DAY = {
  date: "2026-11-19", label: "Thursday, November 19",
  cutoff: "2026-11-18T17:00:00.000Z",
};

afterEach(() => {
  globalThis.fetch = realFetch;
  for (const lists of made.splice(0)) {
    clearTimeout(lists.timer);
    clearTimeout(lists.closing);
    clearTimeout(lists.again);
  }
});

describe("the countdown's other forms (#627)", () => {
  it("says delivery ordering is closed when no day is on offer", () => {
    const { text, chip } = at("2026-11-18T11:09:30.000Z", []);

    assert.equal(text.textContent, "Delivery ordering is closed right now.");
    assert.equal(chip.dataset.urgency, undefined);
  });

  it("says the cutoff just passed, then asks for the dates again",
    async () => {
      let asked = 0;

      globalThis.fetch = async () => {
        asked += 1;
        throw new Error("offline");
      };

      const { text } = at("2026-11-18T11:09:30.000Z", [DAY]);

      // The page's clock moves past the cutoff while it is open.
      text.textContent = "";
      made[0].offset = Date.parse("2026-11-18T17:00:30.000Z") - Date.now();
      made[0].tick();
      assert.equal(text.textContent,
        "That cutoff just passed. Updating dates…");
      assert.equal(asked, 1);

      // The lists couldn't be had: it says so and tries again later.
      await new Promise((done) => setImmediate(done));
      assert.equal(text.textContent,
        "We couldn't load the dates. Retrying…");
    });

  it("grows more urgent near the cutoff, never showing 0 minutes", () => {
    const cases = [
      ["2026-11-18T10:59:30.000Z", undefined,
        /^Order within 6 hours and 0 minutes for delivery on /],
      ["2026-11-18T11:09:30.000Z", "soon",
        /^Order within 5 hours and 50 minutes for delivery on /],
      ["2026-11-18T16:15:30.000Z", "last",
        /^Order within 44 minutes for delivery on /],
      ["2026-11-18T16:59:45.000Z", "last",
        /^Order within 1 minute for delivery on /],
    ];

    for (const [now, urgency, sentence] of cases) {
      const { text, chip } = at(now, [DAY]);

      assert.match(text.textContent, sentence, now);
      assert.equal(chip.dataset.urgency, urgency, now);
    }
  });
});
