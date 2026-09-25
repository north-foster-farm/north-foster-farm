import assert from "node:assert/strict";
import { describe, it } from "node:test";

import catalog from "../data/catalog.json" with { type: "json" };
import terms from "../data/delivery.json" with { type: "json" };
import { indexCatalog } from "../assets/scripts/order/lib/catalog.mjs";
import {
  findCode, normalizeCode, validateOrder, zipStatus,
} from "../assets/scripts/order/lib/validate.mjs";
import { instant } from "../assets/scripts/order/lib/zoned.mjs";

const index = indexCatalog(catalog);
const now = instant("2026-10-06", 9, 0, "America/New_York");
const ctx = { index, terms, now };

const base = () => ({
  customer: {
    firstName: "Pat",
    lastName: "Example",
    email: "pat@example.com",
    phone: "401-555-0100",
    contact: "text",
  },
  lines: [{ sku: "NFF-CHK-WHL-0350-0400", qty: 2 }],
  fulfilment: {
    method: "onfarm",
    date: "2026-10-07",
    onfarm: { window: "morning" },
  },
  claimedTotal: 5500,
});

const withCustomer = (patch) => {
  const p = base();

  p.customer = { ...p.customer, ...patch };

  return p;
};

const delivery = (overrides = {}) => ({
  ...base(),
  lines: [{ sku: "NFF-CHK-WHL-0350-0400", qty: 2 }],
  fulfilment: {
    method: "delivery",
    date: "2026-10-08",
    delivery: {
      address1: "1 Main St",
      town: "Foster",
      zip: "02825",
      cooler: "Side porch",
      ...overrides,
    },
  },
});

describe("a valid on-farm order", () => {
  it("is accepted with recomputed totals and denormalised lines", () => {
    const r = validateOrder(base(), ctx);

    assert.ok(r.ok, JSON.stringify(r));
    assert.equal(r.order.totals.subtotal, 6000);
    assert.equal(r.order.totals.discountAmount, 500);
    assert.equal(r.order.totals.total, 5500);
    assert.equal(r.order.lines[0].label, "Whole Chicken, 3.5 – 3.9 lbs");
    assert.equal(r.order.lines[0].unitPrice, 30);
    assert.equal(r.order.flags.totalMismatch, false);
  });
});

describe("the customer's details", () => {
  it("are trimmed, the email lowercased, and the preference kept", () => {
    const r = validateOrder(withCustomer({
      firstName: "  Mary Ann ", lastName: " Smith ",
      email: " Pat@Example.COM ", contact: "call",
    }), ctx);

    assert.ok(r.ok, JSON.stringify(r));
    assert.deepEqual(r.order.customer, {
      firstName: "Mary Ann",
      lastName: "Smith",
      marketing: false,
      name: "Mary Ann Smith",
      email: "pat@example.com",
      phone: "401-555-0100",
      contact: "call",
    });
  });

  it("carry the farm-news box only when it is ticked", () => {
    const withBox = (marketing) => {
      const p = delivery();

      return validateOrder({
        ...p, customer: { ...p.customer, marketing },
      }, ctx).order.customer.marketing;
    };

    assert.equal(validateOrder(delivery(), ctx).order.customer.marketing,
      false, "absent is off");
    assert.equal(withBox(true), true);
    assert.equal(withBox(false), false);
    assert.equal(withBox("yes"), false, "only true counts");
  });

  it("need a first name and a last name, each on its own", () => {
    const noFirst = validateOrder(withCustomer({ firstName: "   " }), ctx);
    const noLast = validateOrder(withCustomer({ lastName: "" }), ctx);

    assert.equal(noFirst.status, 422);
    assert.match(noFirst.errors["customer.firstName"], /first name/);
    assert.equal(noFirst.errors["customer.lastName"], undefined);
    assert.equal(noLast.status, 422);
    assert.match(noLast.errors["customer.lastName"], /last name/);
  });

  it("ignore a full name sent on its own", () => {
    const r = validateOrder(withCustomer({
      firstName: "", lastName: "", name: "Pat Example",
    }), ctx);

    assert.equal(r.status, 422);
    assert.ok(r.errors["customer.firstName"]);
  });

  it("need an email that looks like one", () => {
    for (const email of ["", "pat", "pat@", "pat@example", "@example.com"]) {
      const r = validateOrder(withCustomer({ email }), ctx);

      assert.equal(r.status, 422, email);
      assert.match(r.errors["customer.email"], /email/);
    }
  });

  it("need a phone number for delivery, and a plausible one", () => {
    const missing = delivery();

    missing.customer.phone = "";

    const r = validateOrder(missing, ctx);

    assert.equal(r.status, 422);
    assert.equal(r.errors["customer.phone"], "Please enter a phone number.");

    for (const phone of ["12345", "401-555-010", "+44 20 7946 0958"]) {
      const r = validateOrder(withCustomer({ phone }), ctx);

      assert.equal(r.status, 422, phone);
      assert.match(r.errors["customer.phone"], /doesn't look right/);
    }

    for (const phone of ["4015550100", "(401) 555-0100", "1-401-555-0100"]) {
      assert.ok(validateOrder(withCustomer({ phone }), ctx).ok, phone);
    }
  });

  it("need no phone for pickup or the drop site", () => {
    const r = validateOrder(withCustomer({ phone: "" }), ctx);

    assert.ok(r.ok);
    assert.equal(r.order.customer.phone, "");
  });

  it("need to say text or call", () => {
    for (const contact of ["", "email", "TEXT", 7]) {
      const r = validateOrder(withCustomer({ contact }), ctx);

      assert.equal(r.status, 422, String(contact));
      assert.equal(r.errors["customer.contact"], "Text or call?");
    }
  });

  it("report every missing field at once", () => {
    const r = validateOrder({
      ...base(), customer: {}, lines: [], fulfilment: {},
    }, ctx);

    assert.equal(r.status, 422);
    assert.deepEqual(Object.keys(r.errors).sort(), [
      "customer.contact", "customer.email", "customer.firstName",
      "customer.lastName", "fulfilment.method", "lines",
    ]);
  });
});

describe("on-farm pickup", () => {
  it("needs a window and nothing else", () => {
    const p = base();

    p.fulfilment.onfarm = { window: "evening" };
    const r = validateOrder(p, ctx);

    assert.equal(r.status, 422);
    assert.equal(r.errors["onfarm.window"], "Morning or afternoon?");

    p.fulfilment.onfarm = { window: "afternoon" };
    const ok = validateOrder(p, ctx);

    assert.ok(ok.ok);
    assert.deepEqual(ok.order.fulfilment.onfarm, { window: "afternoon" });
  });
});

describe("money is never trusted", () => {
  it("overrides a tampered total and flags the mismatch", () => {
    const r = validateOrder({ ...base(), claimedTotal: 100 }, ctx);

    assert.ok(r.ok);
    assert.equal(r.order.totals.total, 5500);
    assert.equal(r.order.flags.totalMismatch, true);
  });
});

describe("lines", () => {
  it("rejects an empty order", () => {
    const r = validateOrder({ ...base(), lines: [] }, ctx);

    assert.equal(r.status, 422);
    assert.ok(r.errors.lines);
  });

  it("rejects a sold-out SKU by name", () => {
    const r = validateOrder(
      { ...base(), lines: [{ sku: "NFF-CHK-WHL-0700-0800", qty: 1 }] }, ctx
    );

    assert.equal(r.status, 422);
    assert.match(
      r.errors["lines.NFF-CHK-WHL-0700-0800"], /Whole Chicken, 7.0 – 7.9 lbs/
    );
  });

  it("rejects fractional, zero and oversized quantities", () => {
    for (const qty of [0, 1.5, 100, "x"]) {
      const r = validateOrder(
        { ...base(), lines: [{ sku: "NFF-CHK-EGG-LG", qty }] }, ctx
      );

      assert.equal(r.status, 422, String(qty));
    }
  });

  it("ignores unknown SKUs", () => {
    const r = validateOrder(
      { ...base(), lines: [...base().lines, { sku: "NOPE", qty: 1 }] }, ctx
    );

    assert.ok(r.ok);
    assert.equal(r.order.lines.length, 1);
  });
});

describe("fulfilment", () => {
  it("rejects an unknown method", () => {
    const fulfilment = { method: "southcounty", date: "2026-10-17" };
    const r = validateOrder({ ...base(), fulfilment }, ctx);

    assert.equal(r.status, 422);
    assert.ok(r.errors["fulfilment.method"]);
  });

  it("returns 409 with a fresh list for a stale date", () => {
    const stale = base();

    stale.fulfilment.date = "2026-10-06";
    const r = validateOrder(stale, ctx);

    assert.equal(r.status, 409);
    assert.equal(r.dates[0].date, "2026-10-07");
  });

  it("returns 409 for a delivery date whose cutoff has passed", () => {
    const late = instant("2026-10-07", 13, 0, "America/New_York");
    const r = validateOrder(delivery(), { ...ctx, now: late });

    assert.equal(r.status, 409);
    assert.equal(r.dates[0].date, "2026-10-15");
  });
});

describe("delivery rules", () => {
  it("accepts a complete delivery order with an approved ZIP", () => {
    const r = validateOrder(delivery(), ctx);

    assert.ok(r.ok, JSON.stringify(r));
    assert.equal(r.order.totals.deliveryFee, 500);
    assert.equal(r.order.flags.zipUnlisted, false);
  });

  it("needs a street, a town and a cooler spot; notes are optional", () => {
    const r = validateOrder(delivery({
      address1: " ", town: "", cooler: "  ", notes: "",
    }), ctx);

    assert.equal(r.status, 422);
    assert.match(r.errors["delivery.address1"], /street address/);
    assert.match(r.errors["delivery.town"], /town/);
    assert.match(r.errors["delivery.cooler"], /cooler/);
    assert.equal(r.errors["delivery.notes"], undefined);
  });

  it("keeps the drop-off details, trimmed, with the ZIP status", () => {
    const r = validateOrder(delivery({
      address2: " Apt 2 ",
      cooler: " Side porch, under the bench ",
      notes: " Dog in the yard ",
    }), ctx);

    assert.ok(r.ok, JSON.stringify(r));
    assert.deepEqual(r.order.fulfilment.delivery, {
      address1: "1 Main St",
      address2: "Apt 2",
      town: "Foster",
      state: "RI",
      zip: "02825",
      cooler: "Side porch, under the bench",
      notes: "Dog in the yard",
      zipStatus: "approved",
    });
  });

  it("blocks a $35 order and names the escape hatches", () => {
    const small = delivery();

    small.lines = [{ sku: "NFF-CHK-WHL-0350-0400", qty: 1 }];
    const r = validateOrder(small, ctx);

    assert.equal(r.status, 422);
    assert.match(r.errors["delivery.minimum"], /Scituate/);
  });

  it("records the state and takes eggs to Connecticut", () => {
    const eggs = delivery({ zip: "06239" });

    eggs.lines = [{ sku: "NFF-CHK-EGG-LG", qty: 6 }];
    const r = validateOrder(eggs, ctx);

    assert.ok(r.ok, JSON.stringify(r));
    assert.equal(r.order.fulfilment.delivery.state, "CT");
  });

  it("refuses chicken to Connecticut for now", () => {
    const r = validateOrder(delivery({ zip: "06239" }), ctx);

    assert.equal(r.status, 422);
    assert.match(r.errors["delivery.zip"], /only able to deliver eggs/);
  });

  it("warns and flags an unlisted Rhode Island ZIP, and charges $3", () => {
    const r = validateOrder(delivery({ zip: "02879" }), ctx);
    const listed = validateOrder(delivery(), ctx);

    assert.ok(r.ok, JSON.stringify(r));
    assert.equal(r.order.flags.zipUnlisted, true);
    assert.equal(r.order.totals.areaFee, 300);
    assert.equal(r.order.totals.deliveryFee,
      listed.order.totals.deliveryFee + 300);
    assert.equal(r.order.totals.total, listed.order.totals.total + 300);
  });

  it("blocks a Massachusetts ZIP", () => {
    const r = validateOrder(delivery({ zip: "01527" }), ctx);

    assert.equal(r.status, 422);
    assert.match(r.errors["delivery.zip"], /outside/);
  });
});

describe("zipStatus", () => {
  it("classifies approved, unlisted, outside and invalid", () => {
    assert.equal(zipStatus("02825", terms.area), "approved");
    assert.equal(zipStatus("06239", terms.area), "approved");
    assert.equal(zipStatus("02879", terms.area), "unlisted");
    assert.equal(zipStatus("01527", terms.area), "outside");
    assert.equal(zipStatus("0282", terms.area), "invalid");
  });
});

describe("discount codes", () => {
  const codes = [{ code: "fall5", label: "Fall special", off: 5 }];

  it("are normalised and looked up without regard to case", () => {
    assert.equal(normalizeCode("  fall-5 ! "), "FALL-5");
    assert.equal(findCode(" Fall5 ", codes).label, "Fall special");
    assert.equal(findCode("nope", codes), null);
    assert.equal(findCode("", codes), null);
    assert.equal(findCode("x", undefined), null);
  });

  it("apply on the server from the list, and an unknown one is " +
    "harmless", () => {
    const known = validateOrder({ ...base(), code: "FALL5", claimedTotal:
      5500 }, { ...ctx, codes });

    assert.ok(known.ok, JSON.stringify(known));
    // $60 subtotal: the $5 tier and the $5 code tie, the code wins
    // nothing extra; the total is the same and the label is the code's.
    assert.equal(known.order.totals.discountAmount, 500);
    assert.equal(known.order.code, "FALL5");
    assert.equal(known.order.totals.total, 5500);

    const unknown = validateOrder({ ...base(), code: "EGGBOI" },
      { ...ctx, codes });

    assert.ok(unknown.ok, JSON.stringify(unknown));
    assert.equal(unknown.order.code, null);
    assert.equal(unknown.order.totals.total, 5500);
    assert.equal(unknown.order.flags.totalMismatch, false,
      "the joke changes nothing the server sees");
  });

  it("take the page's resolved entry when there is no list", () => {
    const r = validateOrder({ ...base(), code: "BIG", claimedTotal: 3000 },
      { ...ctx, code: { code: "BIG", label: "Big", off: 30 } });

    assert.ok(r.ok, JSON.stringify(r));
    assert.equal(r.order.totals.discountAmount, 3000);
    assert.equal(r.order.code, "BIG");
    assert.equal(r.order.flags.totalMismatch, false);
  });
});
