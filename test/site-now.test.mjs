// #568: the scripts' clock. The real time, except where the staging
// toolbar is in the page, which moves it by the offset the toolbar
// keeps in this browser. Production markup never carries the toolbar.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { clockOffset, siteNow } from "../assets/scripts/clock/now.js";
import { mountClock } from "../assets/scripts/staging/clock.js";
import { retireTopBar } from "../assets/scripts/top-bar/top-bar.js";

const DAY = 864e5;
const withToolbar = { getElementById: (id) => (id === "staging" ? {} : null) };
const withoutToolbar = { getElementById: () => null };

describe("the scripts' clock", () => {
  it("reads the kept offset where the toolbar is in the page", () => {
    assert.equal(clockOffset(withToolbar, () => String(-60 * DAY)),
      -60 * DAY);

    const before = Date.now();
    const now = siteNow(withToolbar, () => String(2 * DAY));

    assert.ok(now >= before + 2 * DAY && now <= Date.now() + 2 * DAY);
  });

  it("is the real time without the toolbar, whatever is kept", () => {
    assert.equal(clockOffset(withoutToolbar, () => String(-60 * DAY)), 0);

    const before = Date.now();
    const now = siteNow(withoutToolbar, () => String(-60 * DAY));

    assert.ok(now >= before && now <= Date.now());
  });

  it("is the real time with nothing usable kept, or no page", () => {
    assert.equal(clockOffset(withToolbar, () => null), 0);
    assert.equal(clockOffset(withToolbar, () => "soon"), 0);
    assert.equal(clockOffset(undefined, () => String(DAY)), 0);
  });
});

describe("the top bar on the site's clock", () => {
  const bar = () => {
    const el = { dataset: { until: "2026-11-21T17:00:00-05:00" },
      removed: false, remove() { this.removed = true; } };

    return { el, root: { querySelector: () => el } };
  };

  it("stays until its event ends", () => {
    const { el, root } = bar();

    retireTopBar(root, Date.parse("2026-11-21T16:59:00-05:00"));
    assert.equal(el.removed, false);
  });

  it("goes once the time given is past its end", () => {
    const { el, root } = bar();

    retireTopBar(root, Date.parse("2026-11-21T17:01:00-05:00"));
    assert.equal(el.removed, true);
  });
});

// With a time set, the toolbar names what the time can't move, so no
// part of the site fails silently.
describe("the toolbar's line on what the clock doesn't move", () => {
  const toolbar = () => {
    const node = () => ({
      hidden: false, textContent: "", value: "",
      addEventListener() {}, querySelector: () => node(),
    });
    const nodes = {
      "[data-staging-clock-misses]": { ...node(), hidden: true },
      "[data-staging-badge-time]": node(),
      "[data-staging-tab-clock]": node(),
    };
    const root = {
      classList: { toggle() {} },
      querySelector: (sel) => nodes[sel] || (nodes[sel] = node()),
    };

    const { draw } = mountClock({ root, api: async () => ({}),
      timeZone: "America/New_York", reload() {} });

    return { draw, misses: nodes["[data-staging-clock-misses]"] };
  };

  it("shows while a time is set", () => {
    const { draw, misses } = toolbar();

    draw({ offset: -60 * DAY, now: "2026-09-19T14:00:00Z" });
    assert.equal(misses.hidden, false);
  });

  it("hides at the real time", () => {
    const { draw, misses } = toolbar();

    draw({ offset: -60 * DAY, now: "2026-09-19T14:00:00Z" });
    draw({ offset: 0, now: "2026-11-12T14:00:00Z" });
    assert.equal(misses.hidden, true);
  });
});
