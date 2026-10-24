// The customer's packing slip and the farm's sheets (#292, design
// pass): the embedded Aller and logo, the slip's words, and which
// pages carry the brand or the FARM COPY band.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import { render } from "../bin/slip-assets.mjs";
import { METHODS } from "../netlify/functions/lib/checkout.mjs";
import { company } from "../netlify/functions/lib/company.mjs";
import { samplePacket } from "../netlify/functions/lib/library.mjs";
import {
  FARM_COPY, PAY_WORDS, acceptedWays, dueLines, packetPdf, paidLine,
  paymentName, paymentState, slipAddress, slipContacts,
} from "../netlify/functions/lib/packing.mjs";
import { readWoff } from "../netlify/functions/lib/ttf.mjs";

const root = join(import.meta.dirname, "..");
const PAYPAL = { PAYPAL_CLIENT_ID: "id", PAYPAL_CLIENT_SECRET: "secret" };
const now = new Date("2026-10-06T10:00:00Z");
const entries = samplePacket().entries;
const text = (list) => packetPdf({
  entries: list, now, title: "T", cover: false, env: PAYPAL,
}).toString("latin1");
const farmCopy = `(${FARM_COPY.replace("·", "\\267")})`;

describe("the slip's embedded files", () => {
  it("match the fonts and logos they come from", () => {
    const module = readFileSync(
      join(root, "netlify/functions/lib/slip-assets.mjs"), "utf8");

    assert.equal(module, render(),
      "run node bin/slip-assets.mjs: the fonts or logo SVGs changed");
  });

  it("reads Aller back to the TrueType file its WOFF holds", () => {
    const woff = readFileSync(join(root, "static/fonts/aller-regular.woff"));
    const font = readWoff(woff);

    assert.equal(font.name, "Aller");
    assert.equal(font.file.length, woff.readUInt32BE(16),
      "the size the WOFF header gives");
    assert.equal(font.file.toString("latin1", 0, 4), "\0\x01\0\0");
    assert.ok(font.advance(0x41) > 0);
    assert.notEqual(font.advance(0xb7), font.advance(0xffff),
      "the middle dot has its own glyph");
    assert.throws(() => readWoff(Buffer.from("wOF2")), /WOFF 1.0/);
  });
});

describe("the slip's words", () => {
  it("says how it was paid, in the customer's words", () => {
    const paid = (...methods) => paidLine({
      payments: methods.map(([method, via]) => ({
        method, via, amount: 100, status: "paid",
      })),
    });

    assert.equal(paid(["card", "square"]), "Paid by card. Thank you!");
    assert.equal(paid(["applepay", "square"]),
      "Paid with Apple Pay. Thank you!");
    assert.equal(paid(["venmo", "venmo"], ["card", "square"]),
      "Paid by card and Venmo. Thank you!");
    assert.equal(paid(), "Paid. Thank you!");
  });

  it("lists every way checkout takes payment, Venmo only when shown",
    () => {
      for (const m of Object.keys(METHODS)) assert.ok(PAY_WORDS[m], m);
      assert.deepEqual(acceptedWays(PAYPAL),
        ["card", "Apple Pay", "Google Pay", "Cash App Pay", "Venmo"]);
      assert.ok(!acceptedWays({ ...PAYPAL, VENMO_HIDDEN: "1" })
        .includes("Venmo"));
      assert.ok(!acceptedWays({}).includes("Venmo"), "PayPal unset");
    });

  it("says what is due, and where", () => {
    const state = { paid: false, due: 9400, refunded: 0 };
    const at = (method) => dueLines({ fulfilment: { method } }, state,
      PAYPAL)[0];

    assert.equal(at("onfarm"), "Amount due at pickup: $94");
    assert.equal(at("scituate"), "Amount due at pickup: $94");
    assert.equal(at("delivery"), "Amount due at delivery: $94");
    assert.equal(dueLines({ fulfilment: { method: "onfarm" } }, state,
      PAYPAL)[1], "We accept cash, cards, Apple Pay, Google Pay, " +
      "Cash App Pay and Venmo.");
  });

  it("ends with the farm's phone, email, website and Instagram", () => {
    assert.deepEqual(slipContacts().split("  ·  "), [
      company.phone.display, company.email, "northfosterfarm.com",
      "@northfosterfarm",
    ]);
  });
});

describe("the slip's round 2 (James, 2026-10-24)", () => {
  const slip = () => text([entries.find((e) => e.kind === "new")]);

  it("names a payment by its method, a card by brand and last 4", () => {
    assert.equal(paymentName({ method: "card", brand: "VISA", last4: "4242" }),
      "Visa *4242");
    assert.equal(paymentName({
      method: "card", brand: "AMERICAN_EXPRESS", last4: "1005",
    }), "American Express *1005");
    assert.equal(paymentName({ method: "card" }), "Card");
    assert.equal(paymentName({ method: "applepay" }), "Apple Pay");
    assert.equal(paymentName({ via: "venmo" }), "Venmo");
  });

  it("lists unit price and amount, and the payment under the total", () => {
    const pdf = slip();

    assert.match(pdf, /\(Amount\)/);
    assert.match(pdf, /\(\$30\)/, "the chicken's unit price");
    assert.match(pdf, /\(\$90\)/, "its row's amount");
    assert.match(pdf, /\(Paid by Visa \*4242\)/);
    assert.match(pdf, /\(-\$94\)/);
    assert.match(pdf, /\(Due\)/);
    assert.match(pdf, /\(\$0\)/);
    assert.ok(!/\(Nov |\(Oct /.test(pdf), "no payment date");
  });

  it("drops the packer's fields and the Printed line", () => {
    const pdf = slip();

    for (const word of ["Cooler", "Delivery notes", "Order notes",
      "Printed"]) {
      assert.ok(!pdf.includes(`(${word}`), `no ${word}`);
    }
  });

  it("ends with the thanks and the farm's address", () => {
    const pdf = slip();

    assert.ok(pdf.includes("(Thank you for supporting local farms.)"));
    assert.deepEqual(slipAddress(), [
      "North Foster Farm", "99 East Killingly Road", "Foster, RI 02825",
    ]);
    for (const row of slipAddress()) assert.ok(pdf.includes(`(${row})`));
  });

  it("leaves the farm's sheets their Printed timestamp", () => {
    assert.match(text([entries.find((e) => e.kind === "cancelled")]),
      /\(Printed /);
  });
});

describe("which pages carry what", () => {
  it("brands the customer's slip and embeds Aller in it", () => {
    const pdf = text([entries.find((e) => e.kind === "new")]);

    assert.match(pdf, /\(Your order\)/);
    assert.match(pdf, /\(PAID\)/);
    assert.match(pdf, /\(Eggs, Grade A \\267 Large\)/);
    assert.match(pdf, /\/BaseFont \/Aller-Bold/);
    assert.match(pdf, /\/FontFile2/);
    assert.ok(!pdf.includes(farmCopy), "no FARM COPY on a slip");
  });

  it("marks the farm's sheets FARM COPY, in plain Helvetica", () => {
    const pdf = text([entries.find((e) => e.kind === "cancelled")]);

    assert.ok(pdf.includes(farmCopy));
    assert.doesNotMatch(pdf, /FontFile2/, "nothing embedded");
    assert.ok(packetPdf({ entries: [], now, title: "T" })
      .toString("latin1").includes(farmCopy), "the cover too");
  });

  it("marks an unpaid slip UNPAID with the amount and the ways to pay",
    () => {
      const unpaid = entries.find((e) => !paymentState(e.order).paid);
      const pdf = text([unpaid]);

      assert.match(pdf, /\(UNPAID\)/);
      assert.match(pdf, /\(Amount due at pickup: \$94\)/);
      assert.match(pdf, /\(We accept cash, cards, Apple Pay/);
    });

  it("writes the same bytes for the same packet", () => {
    assert.ok(text(entries).length > 0);
    assert.equal(text(entries), text(entries));
  });
});
