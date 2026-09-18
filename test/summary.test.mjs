import assert from "node:assert/strict";
import { describe, it } from "node:test";

import terms from "../data/delivery.json" with { type: "json" };
import {
  badges, feeCell, nudge, summarize,
} from "../assets/scripts/order/lib/summary.mjs";
import { computeTotals } from "../assets/scripts/order/lib/totals.mjs";

const { money } = terms;

// A subtotal at any dollar amount, in cents.
const at = (dollarsAmount, method = "") => computeTotals({
  lines: [{ sku: "X", qty: 1 }],
  method,
  index: new Map([["X", { price: dollarsAmount }]]),
  money,
});

const on = (list) => list.filter((b) => b.on).map((b) => b.key);

describe("badges", () => {
  it("are all off on an empty cart", () => {
    assert.deepEqual(on(badges(at(0), money)), []);
  });

  it("light in order as the subtotal climbs", () => {
    assert.deepEqual(on(badges(at(39.99), money)), []);
    assert.deepEqual(on(badges(at(40), money)), ["delivery"]);
    assert.deepEqual(on(badges(at(49.99), money)), ["delivery"]);
    assert.deepEqual(on(badges(at(50), money)), ["delivery", "tier-50"]);
    assert.deepEqual(
      on(badges(at(100), money)), ["delivery", "tier-50", "tier-100"]
    );
    assert.deepEqual(on(badges(at(149.99), money)), [
      "delivery", "tier-50", "tier-100",
    ]);
    assert.deepEqual(on(badges(at(150), money)), [
      "delivery", "tier-50", "tier-100", "tier-150", "free-delivery",
    ]);
    assert.deepEqual(on(badges(at(200), money)), [
      "delivery", "tier-50", "tier-100", "tier-150", "tier-200",
      "free-delivery",
    ]);
    assert.deepEqual(on(badges(at(999), money)), [
      "delivery", "tier-50", "tier-100", "tier-150", "tier-200",
      "free-delivery",
    ]);
  });

  it("judge delivery on the subtotal after the discount", () => {
    // $52 subtotal earns $5 off: $47 after discount, still eligible.
    assert.ok(badges(at(52), money)[0].on);
    // Eligibility never flips back off once a tier is reached, because
    // every tier's threshold minus its discount is above the minimum.
    for (const tier of money.bulkTiers) {
      assert.ok(badges(at(tier.threshold), money)[0].on, `$${tier.threshold}`);
    }
  });

  it("read as labels the customer recognises", () => {
    assert.deepEqual(badges(at(0), money).map((b) => b.label), [
      "Local delivery", "$50+", "$100+", "$150+", "$200+", "Free delivery",
    ]);
  });
});

describe("the nudge", () => {
  it("says nothing on an empty cart", () => {
    assert.equal(nudge(at(0), "", money), "");
    assert.equal(nudge(at(0, "delivery"), "delivery", money), "");
  });

  it("names the next discount and the exact gap", () => {
    assert.equal(nudge(at(1), "", money), "Add $49 and we'll take $5 off.");
    assert.equal(
      nudge(at(42.5), "", money), "Add $7.50 and we'll take $5 off."
    );
    assert.equal(
      nudge(at(49.99), "", money), "Add $0.01 and we'll take $5 off."
    );
    assert.equal(nudge(at(50), "", money), "Add $50 and we'll take $10 off.");
    assert.equal(
      nudge(at(99.99), "", money), "Add $0.01 and we'll take $10 off."
    );
    assert.equal(
      nudge(at(100), "onfarm", money), "Add $50 and we'll take $15 off."
    );
    assert.equal(
      nudge(at(150), "onfarm", money), "Add $50 and we'll take $20 off."
    );
  });

  it("mentions free delivery at the $150 line only when it applies", () => {
    assert.equal(
      nudge(at(120), "", money),
      "Add $30 and we'll take $15 off, and delivery is free."
    );
    assert.equal(
      nudge(at(120, "delivery"), "delivery", money),
      "Add $30 and we'll take $15 off, and delivery is free."
    );
    assert.equal(
      nudge(at(120), "onfarm", money), "Add $30 and we'll take $15 off."
    );
    assert.equal(
      nudge(at(120), "scituate", money), "Add $30 and we'll take $15 off."
    );
  });

  it("stops at the top tier", () => {
    assert.equal(
      nudge(at(200), "", money), "That's our biggest discount: $20 off."
    );
    assert.equal(
      nudge(at(500, "delivery"), "delivery", money),
      "That's our biggest discount: $20 off."
    );
  });

  it("puts the delivery minimum first when delivery is chosen", () => {
    assert.equal(
      nudge(at(25, "delivery"), "delivery", money),
      "Add $15 to reach the $40 delivery minimum."
    );
    assert.equal(
      nudge(at(39.99, "delivery"), "delivery", money),
      "Add $0.01 to reach the $40 delivery minimum."
    );
    assert.equal(
      nudge(at(40, "delivery"), "delivery", money),
      "Add $10 and we'll take $5 off."
    );
    // Without delivery chosen the minimum is not the customer's problem.
    assert.equal(nudge(at(25), "", money), "Add $25 and we'll take $5 off.");
  });

  it("agrees with the totals it promises", () => {
    // Whatever the nudge says, adding that gap must produce that
    // discount row, at every cent from $0.01 to $250.
    const parse = (text) => {
      const m = text.match(/^Add \$([\d.]+) and we'll take \$(\d+) off/);

      if (!m) return null;

      return { gap: Math.round(Number(m[1]) * 100), off: Number(m[2]) };
    };

    for (let cents = 1; cents <= 25000; cents += 1) {
      const totals = at(cents / 100);
      const promise = parse(nudge(totals, "", money));

      if (!promise) continue;

      const after = at((cents + promise.gap) / 100);

      assert.equal(after.discountAmount, promise.off * 100, `at ${cents}`);
      assert.equal(
        at((cents + promise.gap - 1) / 100).discountAmount < promise.off * 100,
        true,
        `one cent short at ${cents}`
      );
    }
  });
});

describe("the fee cell", () => {
  it("is absent unless delivery is chosen", () => {
    assert.deepEqual(feeCell(at(60), "", money), { show: false });
    assert.deepEqual(feeCell(at(60), "onfarm", money), { show: false });
  });

  it("charges under $150 and strikes the fee at $150 or more", () => {
    assert.deepEqual(feeCell(at(149.99, "delivery"), "delivery", money), {
      show: true, waived: false, text: "+$5",
    });
    assert.deepEqual(feeCell(at(150, "delivery"), "delivery", money), {
      show: true, waived: true, was: "$5",
    });
    assert.deepEqual(feeCell(at(250, "delivery"), "delivery", money), {
      show: true, waived: true, was: "$5",
    });
  });
});

describe("summarize", () => {
  it("assembles the panel from one set of totals", () => {
    const s = summarize({
      totals: at(155, "delivery"), method: "delivery", money, count: 3,
    });

    assert.equal(s.countText, "3 items");
    assert.equal(s.subtotal, "$155");
    assert.deepEqual(s.discount, { tier: "$150+", text: "−$15" });
    assert.equal(s.fee.waived, true);
    assert.equal(s.total, "$140");
    assert.equal(s.eligible, true);
    assert.equal(s.nudge, "Add $45 and we'll take $20 off.");
  });

  it("counts one item in the singular and none as nothing", () => {
    assert.equal(summarize({
      totals: at(0), method: "", money, count: 0,
    }).countText, "Nothing yet");
    assert.equal(summarize({
      totals: at(7), method: "", money, count: 1,
    }).countText, "1 item");
  });
});
