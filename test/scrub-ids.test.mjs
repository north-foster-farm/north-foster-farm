// The scrubber's own tests for what #730's criteria tests do not reach
// (test/scrub-paypal-2.test.mjs): the helpers behind its id keys,
// PayPal's links, notes and environment. Crafted values only.

// PayPal's keys are snake_case.
/* eslint camelcase: ["error", { "properties": "never" }] */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { scrubAll } from "../bin/fixtures/scrub";

const record = (method, path, { body = null, response = null } = {}) => ({
  name: "crafted",
  service: "paypal",
  status: 200,
  request: { method, path, headers: {}, body },
  response,
  recorded: "2026-11-21",
});
const one = (raw) => scrubAll([raw])[0];

describe("bin/fixtures/scrub, beyond the #730 criteria", () => {
  it("takes no camelCase word ending in id for an id key", () => {
    const made = one(record("GET", "/v1/reporting/x?paid=QzkxMwrtPlhvb"));

    assert.equal(made.json.request.path, "/v1/reporting/x?paid=QzkxMwrtPlhvb");
    assert.deepEqual(made.review, ["request.path"]);
  });

  it("swaps an id that only a PayPal link shows", () => {
    const raw = "CraftedOnly7310";
    const made = one(record("GET", "/v2/checkout/orders/CraftedOrd7310", {
      response: { links: [{ rel: "up", method: "GET",
        href: `https://api-m.paypal.com/v2/payments/captures/${raw}` }] },
    }));

    assert.ok(!JSON.stringify(made.json).includes(raw));
    assert.equal(made.json.response.links[0].href,
      "https://api-m.paypal.com/v2/payments/captures/CAPTURE_ID_1");
    assert.deepEqual(made.review, []);
  });

  it("lists a brand_name that is not ours", () => {
    const made = one(record("GET", "/v2/checkout/orders/CraftedOrd7311", {
      response: { payee: { display_data: { brand_name: "Elsewhere Co" } } },
    }));

    assert.deepEqual(made.review, ["payee.display_data.brand_name"]);
  });

  it("takes a note to payer out of another string that quotes it", () => {
    const typed = "Short a loaf, sorry";
    const made = one(record("POST", "/v2/payments/captures/CraftedCap7312/"
      + "refund", {
      body: { note_to_payer: typed },
      response: { message: `Refunded: ${typed}.` },
    }));

    assert.equal(made.json.response.message, "Refunded: Note to payer.");
  });

  it("names a webhook resource by its resource_type", () => {
    const capture = "CraftedCap7313";
    const [captured, hook] = scrubAll([
      record("GET", `/v2/payments/captures/${capture}`,
        { response: { id: capture, status: "COMPLETED" } }),
      record("POST", "/api/paypal/webhook", { body: {
        id: "WH-CRAFTED7313-0730", event_type: "PAYMENT.CAPTURE.COMPLETED",
        resource_type: "capture", resource: { id: capture },
      } }),
    ]);

    assert.equal(captured.json.response.id, "CAPTURE_ID_1");
    assert.equal(hook.json.request.body.resource.id, "CAPTURE_ID_1");
    assert.equal(hook.json.request.body.id, "WEBHOOK_EVENT_ID_1");
  });

  it("names a refund's answer a refund", () => {
    const made = one(record("POST",
      "/v2/payments/captures/CraftedCap7314/refund",
      { response: { id: "CraftedRef7314", status: "COMPLETED" } }));

    assert.equal(made.json.response.id, "REFUND_ID_1");
  });

  it("tells sandbox from production, and says unknown when the run "
    + "is mixed", () => {
    const linked = (host) => record("GET", "/v2/checkout/orders/Crafted7315",
      { response: { links: [{ rel: "self", method: "GET",
        href: `https://${host}/v2/checkout/orders/Crafted7315` }] } });
    const bare = record("GET", "/v2/checkout/orders/Crafted7316",
      { response: { status: "COMPLETED" } });
    const env = (files) => scrubAll(files)
      .map((file) => file.json._source.environment);

    assert.deepEqual(env([linked("api-m.sandbox.paypal.com"), bare]),
      ["sandbox", "sandbox"]);
    assert.deepEqual(env([linked("api-m.paypal.com"), bare]),
      ["production", "production"]);
    assert.deepEqual(env([linked("api-m.paypal.com"),
      linked("api-m.sandbox.paypal.com"), bare]),
    ["production", "sandbox", "unknown"]);
  });

  it("takes a short note out of free text only, never a path, a link or "
    + "a one-word value", () => {
    const path = "/v2/payments/captures/CraftedCap7312/refund";
    const href = "https://api-m.paypal.com/v2/payments/refunds/CraftedRef7312";
    const [made] = scrubAll([{
      ...record("POST", path, {
        body: { note_to_payer: "Refund" },
        response: { id: "CraftedRef7312", status: "COMPLETED",
          resource_type: "refund", message: "Refund",
          detail: "Refund sent to the buyer",
          links: [{ href, rel: "self", method: "GET" }] },
      }),
      name: "paypal-20261121T140100123Z-post-v2-payments-captures-"
        + "craftedcap7312-refund-1a2b3c",
    }]);
    const { response } = made.json;

    assert.equal(made.json.request.path,
      "/v2/payments/captures/CAPTURE_ID_1/refund");
    assert.match(made.name, /-refund-1a2b3c$/);
    assert.equal(response.resource_type, "refund");
    assert.equal(response.message, "Note to payer");
    assert.equal(response.detail, "Note to payer sent to the buyer");
    assert.equal(response.links[0].href,
      "https://api-m.paypal.com/v2/payments/refunds/REFUND_ID_1");
    assert.ok(!made.review.includes("request.path"),
      JSON.stringify(made.review));
  });

  it("fixes a note of the description form when no record names its id",
    () => {
      const made = one(record("POST",
        "/v2/payments/captures/CraftedCap7313/refund", {
          body: { note_to_payer: "North Foster Farm order NFF-2611-QZXM" },
        }));

      assert.equal(made.json.request.body.note_to_payer, "Note to payer");
      assert.ok(!JSON.stringify(made.json).includes("QZXM"));
    });

  it("keeps an API link's own query keys, and lists any other", () => {
    const linked = (query) => one(record("GET", "/v1/reporting/x", {
      response: { links: [{ rel: "next", method: "GET",
        href: `https://api.paypal.com/v1/reporting/transactions?${query}` }] },
    }));

    assert.deepEqual(linked("page=2&page_size=10&total_required=true"
      + "&fields=all,payer_info").review, []);
    assert.deepEqual(linked("page=two").review, ["links.href"]);
    assert.deepEqual(linked("constructor=1").review, ["links.href"]);
  });
});
