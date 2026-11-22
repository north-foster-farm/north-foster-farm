// Criteria tests for #818, phase 4 of the split of order-form.js
// (docs/refactors/order-form.md, "Phase 4: the result panels"), held
// out of `npm test` until the phase lands. The phase's first box, the
// locked card's e2e spec, is e2e/order-locked.spec.mjs, in a commit
// of its own.
//
// Turn it on, in the commit that moves the code:
//   git mv test/placed.criteria.mjs test/placed.test.mjs
//
// All twelve criteria are of the new-module kind: they fail on `next`,
// where form/placed.mjs does not exist, and pass once the phase draws
// it out. Nothing retires: window-label.test.mjs and
// email-rule.test.mjs test libraries that do not move.
//
// Contract (the design names the functions and their module, not
// their arguments; these are the test agent's choice, plain data so
// that the module stays pure; the call shape may be adapted, the
// expected values may not). The words are today's, byte for byte.
// What the page knows comes in `ctx`:
//
//   ctx = {
//     occurrence(id)  the lists' entry for a pickup day's occurrence
//                     ({ date, window, series, name, location }), or
//                     null for one the lists no longer hold
//     drop            the drop site's record ({ window, location })
//     dropSeries      the drop site's series code
//     deliveryWindow  delivery's window (data/delivery.json)
//     location(id)    a location's { street, city, state }, or null
//     farm            the farm's address, as the panel's row holds it
//   }
//
//   paidWith(payment)                   -> "Visa ending 1111", ...
//   when(fulfilment, ctx)               -> the one line
//   dateTime(fulfilment, ctx)           -> the day and the window
//   pickupAddress(fulfilment, ctx)      -> the address, or ""
//   isRound(fulfilment, group)          -> boolean; group is the
//                                          offered group ({ series })
//   summaryText(payload, { ...ctx, item, total })
//     item(sku)  the catalog's entry ({ groupLabel, label, price })
//     total      the order's total in cents
//   contactHrefs(contact, subject, body)
//     contact  company.json's { email, phone: { plain } }
//     ->       { mailto, tel }, each null when there is no link
//   failureBeacon(payload, message, path) -> the beacon's record

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import company from "../data/company.json" with { type: "json" };
import { dollars } from "../assets/scripts/order/lib/totals.mjs";
import {
  pickupTimes, windowLabel,
} from "../assets/scripts/order/lib/schedule.mjs";
import { label } from "../assets/scripts/order/lib/zoned.mjs";
import {
  contactHrefs, dateTime, failureBeacon, isRound, paidWith, pickupAddress,
  summaryText, when,
} from "../assets/scripts/order/form/placed.mjs";

const MODULE = new URL(
  "../assets/scripts/order/form/placed.mjs", import.meta.url
);

const SAT = "2026-12-12";
const THU = "2026-12-10";
const MARKET = {
  date: SAT, window: "9:00 AM – 1:00 PM", series: "market",
  name: "Foster Farmers’ Market", location: "market-lot",
};
const DROP = {
  date: SAT, window: "10:00 – 11:00 AM", series: "drop",
  name: "Drop site", location: "drop-lot",
};
const ENTRIES = { "market-1212": MARKET, "drop-1212": DROP };
const PLACES = {
  "market-lot": { street: "1 Market St", city: "Foster", state: "RI" },
  "drop-lot": { street: "2 Shore Rd", city: "Scituate", state: "RI" },
};
const ctx = {
  occurrence: (id) => ENTRIES[id] || null,
  drop: { window: "10:00 – 11:00 AM", location: "drop-lot" },
  dropSeries: "drop",
  deliveryWindow: "11:00 AM – 3:00 PM",
  location: (id) => PLACES[id] || null,
  farm: "3 Farm Ln, Foster, RI",
};
const ONFARM = { window: "10:00-12:00", from: "10:00", to: "12:00" };
const delivery = {
  method: "delivery", date: THU,
  delivery: { address1: "1 Main St", town: "Foster", zip: "02825" },
};
const market = { method: "scheduled", occurrence: "market-1212" };
const drop = { method: "scheduled", occurrence: "drop-1212" };
const farm = { method: "onfarm", date: SAT, onfarm: ONFARM };

// Box 1 of #818.
describe("paidWith", () => {
  it("names Apple Pay, Google Pay, Cash App Pay and Venmo; a card reads as "
    + "its brand in title case with \"ending\" and its last four digits, "
    + "or as the brand alone, or as \"Card\"", () => {
    assert.equal(paidWith({ method: "applepay" }), "Apple Pay");
    assert.equal(paidWith({ method: "googlepay" }), "Google Pay");
    assert.equal(paidWith({ method: "cashapp" }), "Cash App Pay");
    assert.equal(paidWith({ method: "venmo" }), "Venmo");
    assert.equal(paidWith({ method: "card", brand: "VISA", last4: "1111" }),
      "Visa ending 1111");
    assert.equal(
      paidWith({ method: "card", brand: "AMERICAN_EXPRESS", last4: "0005" }),
      "American Express ending 0005"
    );
    assert.equal(paidWith({ method: "card", brand: "MASTERCARD" }),
      "Mastercard");
    assert.equal(paidWith({ method: "card" }), "Card");
    assert.equal(paidWith(null), "Card");
  });
});

// Box 2 of #818.
describe("when, delivery", () => {
  it("is the day and \"delivered to\" the first address line", () => {
    assert.equal(when(delivery, ctx),
      `${label(THU)}, delivered to 1 Main St.`);
  });
});

// Box 3 of #818.
describe("when, a pickup day", () => {
  it("is the day, the occurrence's hours and its place; the drop site's "
    + "series reads \"the drop site\"", () => {
    assert.equal(when(market, ctx),
      `${label(SAT)}, 9:00 AM – 1:00 PM, at Foster Farmers’ Market.`);
    assert.equal(when(drop, ctx),
      `${label(SAT)}, 10:00 – 11:00 AM, at the drop site.`);
  });
});

// Box 4 of #818.
describe("when, an occurrence gone from the lists", () => {
  it("reads \"at the pickup you chose\"", () => {
    const gone = { method: "scheduled", occurrence: "market-0101",
      date: SAT };

    assert.equal(when(gone, ctx), `${label(SAT)}, at the pickup you chose.`);
  });
});

// Box 5 of #818.
describe("when, an old drop site draft", () => {
  it("reads a draft saved as scituate as the drop site's own hours", () => {
    assert.equal(when({ method: "scituate", date: SAT }, ctx),
      `${label(SAT)}, 10:00 – 11:00 AM, at the drop site.`);
  });
});

// Box 6 of #818.
describe("when, on-farm pickup", () => {
  it("is the day, the window in full and \"at the farm\"", () => {
    const full = windowLabel(pickupTimes(ONFARM));

    assert.ok(full.length > 0);
    assert.equal(when(farm, ctx), `${label(SAT)}, ${full}, at the farm.`);
  });
});

// Box 7 of #818.
describe("dateTime", () => {
  it("is the day, then the window that belongs to the way", () => {
    assert.equal(dateTime(delivery, ctx),
      `${label(THU)}, 11:00 AM – 3:00 PM`);
    assert.equal(dateTime(market, ctx), `${label(SAT)}, 9:00 AM – 1:00 PM`);
    assert.equal(dateTime(farm, ctx),
      `${label(SAT)}, ${windowLabel(pickupTimes(ONFARM))}`);
    assert.equal(dateTime({ method: "scituate", date: SAT }, ctx),
      `${label(SAT)}, 10:00 – 11:00 AM`);
  });
});

// Box 8 of #818.
describe("pickupAddress", () => {
  it("is the farm's address for on-farm pickup, the location's street, "
    + "city and state for a pickup day, and empty for a delivery", () => {
    assert.equal(pickupAddress(farm, ctx), "3 Farm Ln, Foster, RI");
    assert.equal(pickupAddress(market, ctx), "1 Market St, Foster, RI");
    assert.equal(pickupAddress(drop, ctx), "2 Shore Rd, Scituate, RI");
    assert.equal(pickupAddress(delivery, ctx), "");
  });
});

// Box 9 of #818.
describe("isRound", () => {
  it("is true only for a scheduled pickup whose occurrence belongs to the "
    + "offered group's series", () => {
    const group = { series: "pond" };

    assert.equal(isRound({ method: "scheduled", occurrence: "pond-1212" },
      group), true);
    assert.equal(isRound(market, group), false, "another series");
    assert.equal(isRound({ method: "scheduled", occurrence: "pondside-1" },
      group), false, "a series that only starts the same");
    assert.equal(isRound({ method: "scheduled", occurrence: "pond-1212" },
      null), false, "no group offered");
    assert.equal(isRound({ ...delivery, occurrence: "pond-1212" }, group),
      false, "not a pickup day");
  });
});

// Box 10 of #818.
describe("summaryText", () => {
  it("is the customer's name and address, the when line, a line for each "
    + "item with its price, and the total", () => {
    const items = {
      A: { groupLabel: "Eggs", label: "Large", price: 7 },
      B: { groupLabel: "Wings", label: "1 lb pack", price: 9.5 },
    };
    const payload = {
      customer: { firstName: "Ada", lastName: "Hen",
        email: "ada@example.com" },
      fulfilment: delivery,
      lines: [{ sku: "A", qty: 2 }, { sku: "B", qty: 1 }],
    };
    const text = summaryText(payload, {
      ...ctx, item: (sku) => items[sku], total: 2850,
    });

    assert.equal(text, [
      "Ada Hen <ada@example.com>",
      when(delivery, ctx),
      `2 × Eggs, Large (${dollars(1400)})`,
      `1 × Wings, 1 lb pack (${dollars(950)})`,
      `Total ${dollars(2850)}`,
    ].join("\n"));
  });
});

// Box 11 of #818.
describe("contactHrefs", () => {
  it("gives a mailto: only for an address that looks like one, encoded, "
    + "with the subject and any body, and a tel: only for a plain "
    + "number", () => {
    const farmCard = contactHrefs(company, "Order NFF-1", "");
    const subject = encodeURIComponent("Order NFF-1");

    assert.equal(farmCard.mailto,
      `mailto:${encodeURIComponent(company.email)}?subject=${subject}`);
    assert.equal(farmCard.tel, `tel:${company.phone.plain}`);

    const body = "2 × Eggs & more\nTotal $14";
    const withBody = contactHrefs(company, "Order from the website", body);

    assert.equal(withBody.mailto, `mailto:${
      encodeURIComponent(company.email)}?subject=${
      encodeURIComponent("Order from the website")}&body=${
      encodeURIComponent(body)}`);

    const odd = contactHrefs({
      email: "not an address", phone: { plain: "call (401) 555-0100" },
    }, "Order NFF-1", "");

    assert.equal(odd.mailto, null);
    assert.equal(odd.tel, null);
    assert.equal(contactHrefs({
      email: "sales@example.com", phone: { plain: "4015550100" },
    }, "x", "").tel, "tel:4015550100");
  });
});

// Box 12 of #818.
describe("failureBeacon", () => {
  it("carries kind checkout.failed, the message, the way and the page's "
    + "path, and nothing of the customer", () => {
    const payload = {
      customer: { firstName: "Ada", lastName: "Hen",
        email: "ada@example.com", phone: "4015550100" },
      fulfilment: delivery,
      lines: [{ sku: "A", qty: 2 }],
      meta: { idempotencyKey: "key-1" },
    };
    const beacon = failureBeacon(payload, "We couldn't reach the farm.",
      "/order/");

    assert.deepEqual(beacon, {
      kind: "checkout.failed",
      message: "We couldn't reach the farm.",
      method: "delivery",
      page: "/order/",
    });

    const sent = JSON.stringify(beacon);

    for (const bit of ["Ada", "Hen", "ada@example.com", "4015550100",
      "1 Main St", "02825"]) {
      assert.ok(!sent.includes(bit), bit);
    }
  });
});

describe("design, phase 4", () => {
  it("keeps form/placed.mjs pure", () => {
    const code = readFileSync(MODULE, "utf8")
      .replace(/\/\/.*$/gm, "")
      .replace(/\/\*[\s\S]*?\*\//g, "");

    assert.doesNotMatch(code, new RegExp(`\\b(${[
      "(?<![.\\w])document\\.", "(?<![.\\w])window\\.",
      "location\\.pathname", "navigator",
      "querySelector",
      "fetch", "Element",
    ].join("|")})\\b`));
    for (const [, from] of code.matchAll(/\bfrom\s+["']([^"']+)["']/g)) {
      assert.match(from, /\.m?js$/, `placed.mjs imports ${from}`);
    }
  });
});
