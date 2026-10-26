// The order page's side of a buying group (#471): the link's code,
// the group's places folded into the model, and its rounds joined to
// the pickup list.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  groupFromQuery, mergeScheduled, withPlaces,
} from "../assets/scripts/order/lib/group.mjs";
import { datesFor } from "../assets/scripts/order/lib/dates.mjs";
import { buildModel } from "../assets/scripts/order/lib/events.mjs";
import { validateOrder } from "../assets/scripts/order/lib/validate.mjs";
import { indexCatalog } from "../assets/scripts/order/lib/catalog.mjs";
import { instant } from "../assets/scripts/order/lib/zoned.mjs";
import catalog from "../data/catalog.json" with { type: "json" };
import terms from "../data/delivery.json" with { type: "json" };
import { publicGroup } from "../netlify/functions/lib/groups.mjs";
import groupData from "../data/groups.json" with { type: "json" };

const RAW = {
  locations: [{
    code: "AAAA", name: "Town Common", street: "1 Main St", city: "Foster",
    state: "RI", zip: "02825", town: "Foster", lat: 41.8, lng: -71.7,
  }],
  series: [{
    code: "BBBB", kind: "drop-site", name: "Drop site", location: "AAAA",
    start: "2026-10-17", opens: "10:00", closes: "11:00",
  }],
};
const GROUP = publicGroup(groupData.groups[0]);
const page = { ...terms, model: buildModel(RAW.locations, RAW.series) };

describe("the link's code", () => {
  it("reads ?group= as typed, upper case, or nothing", () => {
    assert.equal(groupFromQuery("?group=gym-2026"), "GYM-2026");
    assert.equal(groupFromQuery("?method=scheduled&group=ABCD-EFGH"),
      "ABCD-EFGH");
    assert.equal(groupFromQuery("?group=ab"), "");
    assert.equal(groupFromQuery("?group=a%20b%20c%20d%20e%20f"), "");
    assert.equal(groupFromQuery(""), "");
  });
});

describe("the group's places on the page", () => {
  it("fold into the model, named, and come out again", () => {
    const unlocked = withPlaces(page, RAW, GROUP);

    assert.deepEqual(unlocked.groups, ["vff"]);
    assert.deepEqual(unlocked.model.series.map((s) => s.code),
      ["BBBB", "36TS"]);
    assert.equal(unlocked.model.location("NR9D").private, true);
    assert.equal(unlocked.model.seriesOf("36TS").window, "8:30 – 9:00 AM");
    // The page's own terms are untouched.
    assert.equal(page.groups, undefined);
    assert.deepEqual(page.model.series.map((s) => s.code), ["BBBB"]);

    const locked = withPlaces(unlocked, RAW);

    assert.equal(locked.groups, undefined);
    assert.deepEqual(locked.model.series.map((s) => s.code), ["BBBB"]);
  });

  it("let the page validate a round as the server does", () => {
    const now = instant("2026-11-02", 9, 0, "America/New_York");
    const unlocked = withPlaces(page, RAW, GROUP);
    const schedule = Object.assign([], { lines: [] });

    assert.equal(datesFor("scheduled", now, page, schedule)
      .some((d) => d.occurrence === "36TS-261108"), false);
    assert.equal(datesFor("scheduled", now, unlocked, schedule)
      .some((d) => d.occurrence === "36TS-261108"), true);

    const payload = {
      customer: {
        firstName: "Pat", lastName: "Example", email: "pat@example.com",
        phone: "", contact: "call",
      },
      lines: [{ sku: "NFF-CHK-WHL-35-39", qty: 2 }],
      fulfilment: { method: "scheduled", occurrence: "36TS-261108" },
      claimedTotal: 5500,
    };
    const index = indexCatalog(catalog);
    const refused = validateOrder(payload, {
      index, terms: page, now, schedule, lock: GROUP.lock,
    });
    const placed = validateOrder(payload, {
      index, terms: unlocked, now, schedule, lock: GROUP.lock,
    });

    assert.equal(refused.ok, false);
    assert.equal(refused.status, 409);
    assert.equal(placed.ok, true, JSON.stringify(placed.errors));
    assert.equal(placed.order.fulfilment.date, "2026-11-08");
    assert.equal(placed.order.totals.total, 5500);
  });
});

describe("the rounds in the pickup list", () => {
  const drop = (date) => ({
    occurrence: `BBBB-${date.slice(2).replaceAll("-", "")}`, date,
    series: "BBBB", window: "10:00 – 11:00 AM",
  });
  const round = {
    occurrence: "36TS-261108", date: "2026-11-08", series: "36TS",
    window: "8:30 – 9:00 AM",
  };

  it("join by date, each once, the list's order kept", () => {
    const list = [drop("2026-11-07"), drop("2026-11-14")];
    const merged = mergeScheduled(list, [round]);

    assert.deepEqual(merged.map((d) => d.occurrence),
      ["BBBB-261107", "36TS-261108", "BBBB-261114"]);
    assert.deepEqual(mergeScheduled(merged, [round]).map((d) => d.occurrence),
      ["BBBB-261107", "36TS-261108", "BBBB-261114"]);
    assert.deepEqual(mergeScheduled(list), list);
    assert.deepEqual(mergeScheduled(null, [round]), [round]);
  });

  it("keep a same-day list entry ahead of the round", () => {
    const same = { ...drop("2026-11-08"), window: "10:00 – 11:00 AM" };

    assert.deepEqual(mergeScheduled([same], [round]).map((d) => d.series),
      ["BBBB", "36TS"]);
  });
});
