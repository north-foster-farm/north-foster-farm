// Criteria tests for #833, phase 1 of the split of account/main.js
// (docs/refactors/account.md, "Phase 1: helpers and an order's
// words"), held out of `npm test` until the phase lands.
//
// Turn it on, in the commit that moves the code:
//   git mv test/order-words.criteria.mjs test/order-words.test.mjs
//
// All eight criteria are of the new-module kind: they fail on `next`,
// where account/lib/order-words.mjs does not exist, and pass once the
// phase draws the words out of main.js. Nothing retires.
//
// Contract (the design names the functions and their module; "the
// drop site's series becomes an argument", here the second; the call
// shape may be adapted, the expected values may not). The words are
// today's, byte for byte.
//
//   when(order, dropSeries)  -> the card's when line
//   statusText(order)        -> the card's status
//   addUrl(lines)            -> the Reorder link
//   orderFromPath(pathname)  -> the id, or ""

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  addUrl, orderFromPath, statusText, when,
} from "../assets/scripts/account/lib/order-words.mjs";
import { statusOf } from "../assets/scripts/account/lib/history.mjs";
import {
  pickupTimes, windowLabel,
} from "../assets/scripts/order/lib/schedule.mjs";
import { label } from "../assets/scripts/order/lib/zoned.mjs";
import { assertPure } from "./pure-module.mjs";

const DROP = "VFVQ";
const DAY = "2026-12-12";
const ONFARM = { window: "10:00-12:00", from: "10:00", to: "12:00" };
const order = (fulfilment, more = {}) => ({
  id: "NFF-2612-QA70", status: "paid", fulfilment, ...more,
});
const pickup = (more = {}) => ({
  name: "Foster Farmers’ Market", window: "9:00 AM – 1:00 PM",
  series: "WAC5", gone: false, ...more,
});
const scheduled = { method: "scheduled", occurrence: "WAC5-261212",
  date: DAY };

// Box 1 of #833.
describe("when, on-farm pickup", () => {
  it("is the way, the day and the window in full, or the hours the farm "
    + "confirmed where the record has them", () => {
    assert.equal(when(order({ method: "onfarm", date: DAY, onfarm: ONFARM }),
      DROP), `On-farm pickup, ${label(DAY)}, ${
      windowLabel(pickupTimes(ONFARM))}`);
    assert.equal(when(order({ method: "onfarm", date: DAY,
      onfarm: { ...ONFARM, confirmed: { from: 10, to: 11 } } }), DROP),
    `On-farm pickup, ${label(DAY)}, 10 AM – 11 AM`);
    assert.equal(when(order({ method: "onfarm", date: DAY,
      onfarm: { ...ONFARM, confirmed: { from: 9, to: 13 } } }), DROP),
    `On-farm pickup, ${label(DAY)}, 9 AM – 1 PM`);
  });
});

// Box 2 of #833.
describe("when, a scheduled pickup", () => {
  it("is the way, the day, the hours and at the place, which reads the "
    + "drop site for the drop site's series", () => {
    assert.equal(when(order(scheduled, { pickup: pickup() }), DROP),
      `Pick-up days, ${label(DAY)}, 9:00 AM – 1:00 PM, `
      + "at Foster Farmers’ Market");
    assert.equal(when(order(scheduled, { pickup: pickup({
      name: "Drop site", window: "10:00 – 11:00 AM", series: DROP,
    }) }), DROP), `Pick-up days, ${label(DAY)}, 10:00 – 11:00 AM, `
      + "at the drop site");
  });
});

// Box 3 of #833.
describe("when, a group's round", () => {
  it("reads as a Group order", () => {
    assert.equal(when(order(scheduled, { pickup: pickup({
      name: "The Village Family Fitness", window: "8:30 – 9:00 AM",
      series: "36TS", group: "vff",
    }) }), DROP), `Group orders, ${label(DAY)}, 8:30 – 9:00 AM, `
      + "at The Village Family Fitness");
  });
});

// Box 4 of #833.
describe("when, a pickup gone", () => {
  it("names the way and the day only for a pickup that no longer "
    + "resolves", () => {
    assert.equal(when(order(scheduled, { pickup: pickup({ gone: true }) }),
      DROP), `Pick-up days, ${label(DAY)}`);
  });
});

// Box 5 of #833.
describe("when, any other way", () => {
  it("reads as its name and the day", () => {
    assert.equal(when(order({ method: "delivery", date: DAY }), DROP),
      `Delivery, ${label(DAY)}`);
  });
});

// Box 6 of #833.
describe("statusText", () => {
  it("is \"Cancellation requested\" when one was asked for, and otherwise "
    + "the order's status in statusOf's words", () => {
    const paid = order({ method: "delivery", date: DAY });

    assert.equal(statusText({ ...paid, cancelRequested: true }),
      "Cancellation requested");
    for (const o of [paid, { ...paid, status: "fulfilled" },
      order({ method: "onfarm", date: DAY, onfarm: ONFARM },
        { status: "fulfilled" }),
      { ...paid, status: "cancelled" }]) {
      assert.equal(statusText({ ...o, cancelRequested: false }), statusOf(o),
        o.status);
    }
  });
});

// Box 7 of #833.
describe("addUrl", () => {
  it("is /order/?add= with each line as SKU:qty, encoded", () => {
    assert.equal(addUrl([{ sku: "NFF-CHK-EGG-LG", qty: 2 },
      { sku: "NFF-CHK-WNG", qty: 1 }]),
    `/order/?add=${encodeURIComponent("NFF-CHK-EGG-LG:2,NFF-CHK-WNG:1")}`);
    assert.equal(addUrl([{ sku: "A&B", qty: 3 }]), "/order/?add=A%26B%3A3");
  });
});

// Box 8 of #833.
describe("orderFromPath", () => {
  it("gives the id from /account/orders/<id>/, decoded, and an empty "
    + "string for any other path", () => {
    assert.equal(orderFromPath("/account/orders/NFF-2612-QA70/"),
      "NFF-2612-QA70");
    assert.equal(orderFromPath("/account/orders/NFF-2612-QA70"),
      "NFF-2612-QA70");
    assert.equal(orderFromPath("/account/orders/NFF%2D2612/"), "NFF-2612");
    for (const path of ["/account/", "/account/orders/", "/order/",
      "/account/orders/a/b/"]) {
      assert.equal(orderFromPath(path), "", path);
    }
  });
});

describe("design, section 2", () => {
  it("keeps account/lib/order-words.mjs pure", () => {
    assertPure(new URL("../assets/scripts/account/lib/order-words.mjs",
      import.meta.url), {
      banned: ["document", "(?<![.\\w])window\\.", "location\\.pathname",
        "Element"],
    });
  });
});
