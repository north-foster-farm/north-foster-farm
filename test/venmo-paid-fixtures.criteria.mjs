// #708, last box: "e2e/venmo-paid.spec.mjs answer[s] with those
// shapes". One test.
//
// The seam assumed: the spec's stubbed answers take their PayPal values
// from the recordings by loading them by name, through lib/fake.mjs's
// or test/recorded.mjs's `recorded("paypal", "<name>")` (or `body` or
// `reply`, with the same arguments), or by a path under
// test/fixtures/paypal/. Playwright cannot be run here (common.md: no
// e2e on the Mac) and a spec cannot be imported outside it, so this
// reads the spec's source: it must name at least one recording, each
// one it names must exist, and one of them must be the recorded capture
// (the spec stubs an order Venmo already paid). It also holds the spec
// to no hand-written PayPal answer: no literal PayPal order, capture or
// refund id (paypalOrderId, paypalCaptureId, paypalRefundId) set to a
// quoted string.
//
// Held out of `npm test` (the glob is *.test.mjs) until the swap lands:
//   node --import ./test/setup.mjs --test \
//     test/venmo-paid-fixtures.criteria.mjs

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const SPEC = fileURLToPath(new URL("../e2e/venmo-paid.spec.mjs",
  import.meta.url));
const fixture = (name) => fileURLToPath(new URL(
  `./fixtures/paypal/${name}.json`, import.meta.url));

const LOADS = [
  /\b(?:recorded|body|reply)\(\s*["'`]paypal["'`]\s*,\s*["'`]([^"'`]+)["'`]/g,
  /fixtures\/paypal\/([\w.-]+)\.json/g,
];
const HAND_WRITTEN =
  /\bpaypal(?:Order|Capture|Refund)Id\s*:\s*["'`][^"'`]*["'`]/;

const isCapture = (name) => {
  const r = JSON.parse(readFileSync(fixture(name), "utf8"));

  return r.request.method === "POST"
    && /\/capture$/.test(r.request.path)
    && r.status >= 200 && r.status < 300;
};

describe("#708: e2e/venmo-paid.spec.mjs stubs from the recordings", () => {
  it("takes its stubbed PayPal answers from test/fixtures/paypal/", () => {
    const source = readFileSync(SPEC, "utf8");
    const names = [...new Set(LOADS.flatMap((pattern) => [
      ...source.matchAll(pattern),
    ].map((m) => m[1])))];

    assert.ok(names.length,
      "the spec loads no recording from test/fixtures/paypal/");
    for (const name of names) {
      assert.ok(existsSync(fixture(name)),
        `the spec names ${name}, which is not in test/fixtures/paypal/`);
    }
    assert.ok(names.some(isCapture),
      "the spec loads no recorded capture");
    assert.doesNotMatch(source, HAND_WRITTEN,
      "the spec writes a PayPal id by hand");
  });
});
