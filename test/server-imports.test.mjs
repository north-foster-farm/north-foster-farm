// Criteria tests for #964, phase 1 of untangling the server
// libraries' import cycles (#925, docs/refactors/server-cycles.md):
// "Moves the Square shapes to square-shapes.mjs and the PayPal shapes
// to paypal-shapes.mjs. square.mjs and paypal.mjs re-export them. The
// fakes import from the shapes."
//
// One test per box marked (test), named for the box, written before
// the implementation. The two (guard) boxes are checks that already
// exist: the ten driver and fake tests, and the dependency-cruiser
// baseline once #782 step 8 is on next.
//
// The design keeps one file for the series, test/server-imports.test
// .mjs. It reads a module's import specifiers (static, export ... from
// and import()), resolves them, and asserts the edges a phase cuts. It
// uses no dependency. Later phases add their tests here.
//
// A shapes module is found as .mjs, or as .mts if #795 (TypeScript)
// has landed when the phase starts, as the design allows.
//
// Held out of runs as server-imports.criteria.mjs until the
// implementer renames it to server-imports.test.mjs.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { LIB, code, load, need, rel } from "./server-graph.mjs";

// The four forms: import ... from "x", export ... from "x", import "x"
// and import("x").
const SPECIFIERS = [
  /\b(?:import|export)\b[^;"'`()]*?\bfrom\s*["']([^"']+)["']/g,
  /\bimport\s*["']([^"']+)["']/g,
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
];

// Every module a file imports, resolved: a relative specifier as the
// absolute path of the file it names, any other (node:fs) as written.
const importsOf = (file) => {
  const text = code(readFileSync(file, "utf8"));
  const found = SPECIFIERS.flatMap((re) => [...text.matchAll(re)]
    .map((m) => m[1]));

  return [...new Set(found)].map((spec) => (spec.startsWith(".")
    ? resolve(dirname(file), spec) : spec));
};

// The lib/ modules a file reaches through its imports, itself left out.
const reachedFrom = (file) => {
  const seen = new Set();
  const visit = (path) => {
    for (const to of importsOf(path)) {
      if (seen.has(to) || !/\.m?[jt]s$/.test(to)) continue;
      if (!existsSync(to) || !statSync(to).isFile()) continue;
      seen.add(to);
      visit(to);
    }
  };

  visit(file);
  seen.delete(file);

  return [...seen];
};

const DRIVERS = [
  { driver: "square", fake: "fake-square", shapes: "square-shapes" },
  { driver: "paypal", fake: "fake-paypal", shapes: "paypal-shapes" },
];

describe("#964: phase 1, the fakes", () => {
  it("fake-square.mjs imports nothing from square.mjs, and "
    + "fake-paypal.mjs nothing from paypal.mjs", () => {
    for (const { driver, fake } of DRIVERS) {
      const file = need(fake);
      const target = need(driver);
      const direct = importsOf(file);

      // The reader sees the fake's imports at all: each takes fakeId
      // from fake.mjs.
      assert.ok(direct.includes(need("fake")),
        `the reader found no import of fake.mjs in ${rel(file)}`);
      assert.ok(!direct.includes(target),
        `${rel(file)} imports ${rel(target)}`);
      // Nor through another module: a shapes module that re-exported
      // the driver's names would still hand the fake the driver's.
      assert.ok(!reachedFrom(file).includes(target),
        `${rel(file)} reaches ${rel(target)} through its imports`);
    }
  });

  it("square-shapes.mjs and paypal-shapes.mjs import none of fake*, "
    + "http, recorder, store and clock: no call can sit in them", () => {
    const BANNED = /^(?:fake[\w-]*|http|recorder|store|clock)\.m[jt]s$/;

    for (const { shapes } of DRIVERS) {
      const file = need(shapes);
      const banned = importsOf(file)
        .filter((to) => dirname(to) === LIB && BANNED.test(basename(to)))
        .map(rel);

      assert.deepEqual(banned, [], `${rel(file)} imports ${banned}`);
    }
  });

  // The moved names that square.mjs exports today, from the design's
  // table of new modules ("square-shapes.mjs SquareError, ..."). The
  // private helpers it moves with them (money, stateFor, staffNote,
  // fulfillment, SITE_REFERENCE) are not read from square.mjs, so the
  // box does not reach them. The ten the fake takes are among these.
  const MOVED = {
    square: [
      "DECLINE_MESSAGES", "FRIENDS_SQUARE_NAME", "ORDER_METADATA",
      "SITE_VERSION", "SOURCE_NAME", "SquareError", "buildChangeOrder",
      "buildOrder", "customerView", "e164", "failure", "orderMetadata",
      "paymentRecord", "paymentView", "receiptLink", "refundRecord",
      "replaceableReference",
    ],
    paypal: ["PayPalError", "captureOf", "orderOf", "refundOf"],
  };

  it("each moved name read from square.mjs or paypal.mjs is the same "
    + "binding as in the shapes, so instanceof SquareError holds for an "
    + "error the fake throws", async () => {
    for (const { driver, shapes } of DRIVERS) {
      const from = await load(driver);
      const to = await load(shapes);

      for (const name of MOVED[driver]) {
        assert.ok(name in to, `${shapes} exports no ${name}`);
        assert.equal(from[name], to[name],
          `${driver}.${name} is not ${shapes}.${name}`);
      }
    }

    const square = await load("square");
    const squareShapes = await load("square-shapes");
    const fakeSquare = await load("fake-square");
    // The fake's own guard: a payment with no source is refused.
    const declined = await fakeSquare.createPayment({
      order: {}, squareOrderId: "FAKE-ORDER", key: "criteria-964",
      source: null, amount: 100,
    }).then(() => null, (error) => error);

    assert.ok(declined, "the fake took a payment with no source");
    assert.ok(declined instanceof squareShapes.SquareError,
      "the fake's error is no square-shapes SquareError");
    assert.ok(declined instanceof square.SquareError,
      "the fake's error is no square.mjs SquareError");

    const paypal = await load("paypal");
    const paypalShapes = await load("paypal-shapes");
    const fakePaypal = await load("fake-paypal");
    // An order the fake never made is PayPal's 404.
    const missing = await fakePaypal.getOrder("NOT-A-FAKE-ORDER")
      .then(() => null, (error) => error);

    assert.ok(missing, "the fake found an order it never made");
    assert.ok(missing instanceof paypalShapes.PayPalError,
      "the fake's error is no paypal-shapes PayPalError");
    assert.ok(missing instanceof paypal.PayPalError,
      "the fake's error is no paypal.mjs PayPalError");
  });

  // What each driver exports on next before the move (2026-11-23,
  // 2ae6c0d7), written out. The move adds none and drops none.
  const EXPORTS = {
    square: [
      "CALL_MS", "DECLINE_MESSAGES", "FIND_PAGES", "FIND_WINDOW",
      "FRIENDS_SQUARE_NAME", "ORDER_ID", "ORDER_METADATA", "PAYMENT_MS",
      "SDK_URLS", "SITE_VERSION", "SOURCE_NAME", "STOCK_MS",
      "STOCK_PAGES", "SquareError", "VERSION_TRIES", "VERSION_WAIT_MS",
      "buildChangeOrder", "buildOrder", "cancelFulfillment",
      "cancelOrder", "clientConfig", "completeOrder", "createChangeOrder",
      "createOrder", "createPayment", "customerEmail", "customerOrders",
      "customerView", "customersByEmail", "dashboardUrl",
      "deleteCustomer", "e164", "failure", "findPaid", "getOrder",
      "getPayment", "getRefund", "inventoryCounts", "isFake",
      "orderMetadata", "payZeroOrder", "paymentRecord", "paymentView",
      "receiptLink", "refundPayment", "refundRecord",
      "renameCustomerEmail", "replaceableReference", "searchOpenOrders",
      "setCustomerEmail", "setCustomerReference", "settings",
      "squareEnv", "updateFulfillment",
    ],
    paypal: [
      "CALL_MS", "CAPTURE_MS", "DECLINE_MESSAGES", "ISSUE_ADVICE",
      "PayPalError", "SDK_URL", "SIGNATURE_HEADER", "captureOf",
      "captureOrder", "clientConfig", "configured", "createOrder",
      "describeError", "forgetTokens", "getOrder", "getRefund", "isFake",
      "orderOf", "paypalEnv", "recordingsFor", "refundCapture",
      "refundOf", "settings", "venmoHidden", "verifyWebhook",
      "webhookConfigured",
    ],
  };

  it("the names square.mjs and paypal.mjs export are the same set as "
    + "before", async () => {
    for (const { driver } of DRIVERS) {
      const names = Object.keys(await load(driver)).sort();

      assert.deepEqual(names, [...EXPORTS[driver]].sort(),
        `${driver}.mjs exports another set of names`);
    }
  });
});
