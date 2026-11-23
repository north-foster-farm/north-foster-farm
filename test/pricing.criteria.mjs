// Criteria tests for #820, phase 6 of the split of order-form.js
// (docs/refactors/order-form.md, "Phase 6: money"), held out of `npm
// test` until the phase lands.
//
// Turn it on, in the commit that moves the code:
//   git mv test/pricing.criteria.mjs test/pricing.test.mjs
//
// All eight criteria are of the new-module kind: they fail on `next`,
// where form/pricing.mjs does not exist, and pass once the phase draws
// the money out of the class. Nothing retires: the tests that stay
// green test libraries that do not move.
//
// Contract (the design names the functions and their module, not
// their arguments; these are the test agent's choice, plain data so
// that the module stays pure; the call shape may be adapted, the
// expected values may not). `editing` is the change's record
// ({ placed, booked, held, kept }) or null; `pass` the pass's code or
// null, `passFee` whether it waives the fee; `perks` perk types.
//
//   pricesOn({ money, now, placed, timeZone })   -> moneyOn's prices
//   lockOf({ member, now, placed, timeZone })    -> the lock, or null
//   rulesOf({ money, pass, perks })              -> the money rules
//   totalsArgs({ lines, method, index, money, group, code, lock, zip,
//     area, pass, passFee, editing, credit, perks })
//                                                -> computeTotals' args
//   amountDue({ total, editing })                -> cents
//   checkOptions({ editing, pass, passFee, ... }) -> validateOrder's
//                                                   options, in part

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import terms from "../data/delivery.json" with { type: "json" };
import { moneyOn } from "../assets/scripts/order/lib/money-on.mjs";
import { lockOn } from "../assets/scripts/order/lib/totals.mjs";
import { zipInfo } from "../assets/scripts/order/lib/validate.mjs";
import { instant } from "../assets/scripts/order/lib/zoned.mjs";
import {
  amountDue, checkOptions, lockOf, pricesOn, rulesOf, totalsArgs,
} from "../assets/scripts/order/form/pricing.mjs";

const MODULE = new URL(
  "../assets/scripts/order/form/pricing.mjs", import.meta.url
);
const ZONE = terms.timeZone;
const ny = (iso, h, m = 0) => instant(iso, h, m, ZONE);
const money = terms.money;
// The first change data/delivery.json schedules, and the day before.
const CHANGE = money.changes[0].from;
const dayBefore = (iso) => new Date(Date.parse(`${iso}T12:00:00Z`)
  - 86_400_000).toISOString().slice(0, 10);
const EVE = dayBefore(CHANGE);

// Box 1 of #820.
describe("pricesOn", () => {
  it("gives the prices in force today in the farm's zone, and for an order "
    + "being changed, those of the day it was placed", () => {
    // Late on the eve in the farm's zone, already the change's day in
    // UTC: still the eve's prices.
    const late = ny(EVE, 23, 30);

    assert.equal(late.toISOString().slice(0, 10), CHANGE);
    assert.deepEqual(
      pricesOn({ money, now: late, placed: null, timeZone: ZONE }),
      moneyOn(money, EVE)
    );
    assert.deepEqual(
      pricesOn({ money, now: ny(CHANGE, 0, 30), placed: null,
        timeZone: ZONE }),
      moneyOn(money, CHANGE)
    );
    assert.notDeepEqual(moneyOn(money, EVE), moneyOn(money, CHANGE),
      "the change changes something");

    // Changed after the change's day, placed before it.
    assert.deepEqual(
      pricesOn({ money, now: ny(CHANGE, 10), placed: ny(EVE, 9).toISOString(),
        timeZone: ZONE }),
      moneyOn(money, EVE)
    );
  });
});

// Box 2 of #820.
describe("lockOf", () => {
  it("is null with no member or no lock; otherwise the member price for "
    + "that same day, through the lock's last day", () => {
    const lock = { prices: { "NFF-CHK-EGG-LG": 6 } };
    const member = { lock, lockThrough: "2026-12-31" };
    const at = (now, placed = null) => ({ now, placed, timeZone: ZONE });

    assert.equal(lockOf({ member: null, ...at(ny("2026-12-01", 9)) }), null);
    assert.equal(lockOf({ member: { lock: null }, ...at(ny("2026-12-01", 9)) }),
      null);

    assert.deepEqual(lockOf({ member, ...at(ny("2026-12-31", 23)) }),
      lockOn({ ...lock, through: "2026-12-31" }, "2026-12-31"));
    assert.ok(lockOf({ member, ...at(ny("2026-12-31", 23)) }),
      "the last day holds, late in the farm's zone");
    assert.equal(lockOf({ member, ...at(ny("2027-01-01", 0, 30)) }), null,
      "the day after");

    // A change keeps the day it was placed.
    assert.ok(lockOf({
      member, ...at(ny("2027-01-05", 9), ny("2026-12-30", 9).toISOString()),
    }));

    // No last day: it holds.
    assert.ok(lockOf({ member: { lock }, ...at(ny("2030-01-01", 9)) }));
  });
});

// Box 3 of #820.
describe("rulesOf", () => {
  it("sets the delivery minimum to 0 for a pass or a perk that lifts it, "
    + "and changes nothing else", () => {
    const day = moneyOn(money, EVE);

    assert.deepEqual(rulesOf({ money: day, pass: null, perks: [] }), day);
    assert.deepEqual(
      rulesOf({ money: day, pass: null, perks: ["free-delivery"] }),
      day, "a perk that lifts only the fee"
    );

    for (const lifted of [
      rulesOf({ money: day, pass: "ABCD-1234", perks: [] }),
      rulesOf({ money: day, pass: null, perks: ["minimum-waived"] }),
      rulesOf({ money: day, pass: null, perks: ["friends"] }),
    ]) {
      assert.deepEqual(lifted, { ...day, deliveryMinimum: 0 });
    }
  });
});

const base = {
  lines: [{ sku: "NFF-CHK-EGG-LG", qty: 2 }],
  method: "delivery",
  index: new Map(),
  money: moneyOn(money, EVE),
  group: null,
  code: null,
  lock: null,
  zip: "02825",
  area: terms.area,
  pass: null,
  passFee: false,
  editing: null,
  credit: 500,
  perks: [],
};

// Box 4 of #820.
describe("totalsArgs, the fee", () => {
  it("waives the fee only for a pass that waives it", () => {
    assert.equal(totalsArgs(base).waiveFee, false);
    assert.equal(totalsArgs({ ...base, passFee: true }).waiveFee, false,
      "no pass");
    assert.equal(totalsArgs({ ...base, pass: "ABCD-1234" }).waiveFee, false,
      "a pass that keeps the fee");
    assert.equal(
      totalsArgs({ ...base, pass: "ABCD-1234", passFee: true }).waiveFee, true
    );
  });
});

// Box 5 of #820.
describe("totalsArgs, credit", () => {
  it("counts no credit while an order is being changed", () => {
    assert.equal(totalsArgs(base).credit, 500);
    assert.equal(totalsArgs({
      ...base, editing: { placed: null, booked: null, held: 1400, kept: 0 },
    }).credit, 0);
  });
});

// Box 6 of #820.
describe("totalsArgs, the ZIP", () => {
  it("gives a ZIP status only when the way is delivery", () => {
    assert.equal(totalsArgs(base).zipStatus,
      zipInfo("02825", terms.area).status);
    assert.equal(totalsArgs({ ...base, zip: "10001" }).zipStatus,
      zipInfo("10001", terms.area).status);
    for (const method of ["onfarm", "scheduled"]) {
      assert.equal(totalsArgs({ ...base, method }).zipStatus, null, method);
    }
  });
});

// Box 7 of #820.
describe("amountDue", () => {
  it("is the total for a new order; for a change, the total less what is "
    + "held, plus a kept fee, and never below 0", () => {
    assert.equal(amountDue({ total: 2800, editing: null }), 2800);
    assert.equal(amountDue({ total: 0, editing: null }), 0);

    const change = (held, kept) => ({ placed: null, booked: null, held, kept });

    assert.equal(amountDue({ total: 2800, editing: change(1400, 0) }), 1400);
    assert.equal(amountDue({ total: 2800, editing: change(1400, 500) }), 1900);
    assert.equal(amountDue({ total: 700, editing: change(1400, 0) }), 0);
    assert.equal(amountDue({ total: 700, editing: change(1400, 500) }), 0);
  });
});

// Box 8 of #820.
describe("checkOptions", () => {
  it("passes the day the order was placed and its booked day, and waives "
    + "as the pass says", () => {
    const editing = {
      placed: "2026-12-01T14:00:00.000Z", booked: "2026-12-10",
      held: 6100, kept: 0,
    };
    const changed = checkOptions({ ...base, editing });

    assert.equal(changed.placed, editing.placed);
    assert.equal(changed.keptDate, "2026-12-10");

    const fresh = checkOptions(base);

    assert.ok(!fresh.placed, "a new order has no day placed");
    assert.equal(fresh.keptDate, null);
    assert.deepEqual(fresh.waive, { minimum: false, fee: false });
    assert.deepEqual(checkOptions({ ...base, pass: "ABCD-1234" }).waive,
      { minimum: true, fee: false });
    assert.deepEqual(
      checkOptions({ ...base, pass: "ABCD-1234", passFee: true }).waive,
      { minimum: true, fee: true }
    );
    assert.deepEqual(checkOptions({ ...base, passFee: true }).waive,
      { minimum: false, fee: false }, "no pass, nothing waived");
  });
});

describe("design, phase 6", () => {
  it("keeps form/pricing.mjs pure", () => {
    const code = readFileSync(MODULE, "utf8")
      .replace(/\/\/.*$/gm, "")
      .replace(/\/\*[\s\S]*?\*\//g, "");

    assert.doesNotMatch(code,
      /(?<![.\w])(document|window)\.|\b(querySelector|Date\.now|Element)\b/);
  });
});
