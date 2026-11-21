// The scrubber's own tests for what #708's criteria tests do not reach
// (test/scrub-paypal.test.mjs): a name quoted in free text, and a review
// list that holds only what no rule covers. Crafted values only.

// PayPal's keys are snake_case.
/* eslint camelcase: ["error", { "properties": "never" }] */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { scrubAll } from "../bin/fixtures/scrub";

const delivery = (resource) => ({
  name: "webhook",
  service: "paypal",
  status: 200,
  recorded: "2026-11-21",
  request: {
    method: "POST",
    path: "/api/paypal/webhook",
    headers: {
      "content-type": "application/json",
      "paypal-auth-algo": "SHA256withRSA",
      "paypal-transmission-time": "2026-11-21T14:01:00Z",
    },
    body: {
      id: "WH-CRAFTED-0002",
      event_version: "1.0",
      event_type: "PAYMENT.CAPTURE.COMPLETED",
      resource_type: "capture",
      resource,
    },
  },
  response: { ignored: true },
});

describe("bin/fixtures/scrub, beyond the PayPal criteria", () => {
  it("takes a payer's name out of a note that quotes it", () => {
    const [made] = scrubAll([delivery({
      payer: { name: { given_name: "Quill", surname: "Marblethorpe" } },
      note: "Thanks Quill Marblethorpe, from Marblethorpe-Hall",
    })]);
    const { note } = made.json.request.body.resource;

    assert.equal(note, "Thanks NAME NAME, from NAME-Hall");
  });

  it("takes a payer's name out in any case", () => {
    const [made] = scrubAll([delivery({
      payer: { name: { given_name: "Quill", surname: "Marblethorpe" } },
      note: "QUILL paid, handle quill-marblethorpe",
    })]);
    const { note } = made.json.request.body.resource;

    assert.equal(note, "NAME paid, handle NAME-NAME");
  });

  it("names a recorded exchange's file without its ids", () => {
    const orderId = "5O190127TN364715T";
    const captureId = "3C679366HH908993F";
    // Crafted to hold both, as no single PayPal path does.
    const path = `/v2/checkout/orders/${orderId}/captures/${captureId}`;
    const slug = path.toLowerCase().replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");
    const [made] = scrubAll([{
      name: `paypal-20261121T140100123Z-post-${slug}-1a2b3c`,
      service: "paypal",
      status: 201,
      recorded: "2026-11-21",
      request: { method: "POST", path, headers: {}, body: null },
      response: {
        id: orderId,
        status: "COMPLETED",
        purchase_units: [{
          payments: { captures: [{ id: captureId, status: "COMPLETED" }] },
        }],
      },
    }]);

    for (const id of [orderId, captureId]) {
      assert.ok(!made.name.toLowerCase().includes(id.toLowerCase()),
        made.name);
    }
    assert.match(made.name, /^paypal-20261121T140100123Z-post-.*-1a2b3c$/);
  });

  it("puts a fixed date in place of a birth date", () => {
    const [made] = scrubAll([delivery({
      payer: { birth_date: "1984-03-09" },
    })]);

    assert.equal(made.json.request.body.resource.payer.birth_date,
      "1970-01-01");
  });

  // An exchange whose only id is in its request's path, named as
  // netlify/functions/lib/recorder.mjs names it.
  const alone = (method, path, response) => {
    const slug = path.toLowerCase().replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");
    const [made] = scrubAll([{
      name: `paypal-20261121T140100123Z-${method.toLowerCase()}-${slug}-1a2b3c`,
      service: "paypal",
      status: 422,
      recorded: "2026-11-21",
      request: { method, path, headers: {}, body: null },
      response,
    }]);

    return made;
  };
  const noRaw = (made, ids) => {
    for (const id of ids) {
      for (const text of [made.json.request.path, made.name]) {
        assert.ok(!text.toLowerCase().includes(id.toLowerCase()), text);
      }
    }
    assert.deepEqual(made.review, []);
  };
  const failed = { name: "UNPROCESSABLE_ENTITY", details: [] };

  it("takes a capture id out of a refund recorded alone", () => {
    const captureId = "3C679366HH908993F";
    const made = alone("POST", `/v2/payments/captures/${captureId}/refund`,
      failed);

    noRaw(made, [captureId]);
    assert.equal(made.json.request.path,
      "/v2/payments/captures/CAPTURE_ID_1/refund");
  });

  it("takes an order id out of a GET of that order", () => {
    const orderId = "7AB12345CD678901E";
    const made = alone("GET", `/v2/checkout/orders/${orderId}`, failed);

    noRaw(made, [orderId]);
    assert.equal(made.json.request.path, "/v2/checkout/orders/ORDER_ID_1");
  });

  it("takes an EC- token and query values out of a path", () => {
    const token = "EC-4KX12345AB6789012";
    const payer = "QZ7XKCRAFTED";
    const made = alone("GET",
      `/v1/checkout/approve?token=${token}&PayerID=${payer}&page=2`, failed);

    noRaw(made, [token, payer]);
    assert.equal(made.json.request.path,
      "/v1/checkout/approve?token=TOKEN_1&PayerID=PAYER_ID_1&page=2");
  });

  it("leaves a query's enum and time out of every response", () => {
    const query = "?status=COMPLETED&page_size=20"
      + "&start_date=2026-11-01T00:00:00Z";
    const [listed, other] = scrubAll([
      {
        name: "paypal-20261121T140100123Z-get-v1-reporting-1a2b3c",
        service: "paypal",
        status: 200,
        recorded: "2026-11-21",
        request: {
          method: "GET",
          path: `/v1/reporting/transactions${query}`,
          headers: {},
          body: null,
        },
        response: { status: "COMPLETED", start: "2026-11-01T00:00:00Z" },
      },
      {
        name: "paypal-20261121T140200123Z-get-v2-checkout-4d5e6f",
        service: "paypal",
        status: 200,
        recorded: "2026-11-21",
        request: { method: "GET", path: "/v2/checkout", headers: {},
          body: null },
        response: { status: "COMPLETED" },
      },
    ]);

    assert.equal(listed.json.request.path,
      `/v1/reporting/transactions${query}`);
    assert.equal(listed.json.response.status, "COMPLETED");
    assert.equal(listed.json.response.start, "2026-11-01T00:00:00Z");
    assert.equal(other.json.response.status, "COMPLETED");
    assert.match(listed.name, /-status-completed-page-size-20-start-date-/);
    assert.deepEqual(listed.review, []);
  });

  it("takes an all-digit or all-letter order id out of a route", () => {
    for (const orderId of ["48213907", "48213907561230984", "QZKXMWRTPLHVB"]) {
      const made = alone("GET", `/v2/checkout/orders/${orderId}`, failed);

      noRaw(made, [orderId]);
      assert.equal(made.json.request.path, "/v2/checkout/orders/ORDER_ID_1");
    }
  });

  it("takes any value under a query's id key out of a path", () => {
    const token = "EC-4KX12345AB6789012";
    const payer = "QZKXMWRTPLHVB";
    const order = "48213907561230984";
    const made = alone("GET",
      `/v1/checkout/approve?token=${token}&PayerID=${payer}`
        + `&order_id=${order}`, failed);

    noRaw(made, [token, payer, order]);
    assert.equal(made.json.request.path, "/v1/checkout/approve"
      + "?token=TOKEN_1&PayerID=PAYER_ID_1&order_id=ORDER_ID_1");
  });

  it("lists a path whose query keeps a value no rule covers", () => {
    const made = alone("GET", "/v1/reporting/transactions?ref=Marblethorpe"
      + "&status=COMPLETED&page=2", failed);

    assert.equal(made.json.request.path,
      "/v1/reporting/transactions?ref=Marblethorpe&status=COMPLETED&page=2");
    assert.deepEqual(made.review, ["request.path"]);
  });

  it("lists a path word too short to swap", () => {
    const made = alone("GET", "/v2/checkout/orders/AB12", failed);

    assert.deepEqual(made.review, ["request.path"]);
  });

  it("lists nothing for a delivery every rule covers", () => {
    const [made] = scrubAll([delivery({
      id: "CraftedCapture02",
      status: "COMPLETED",
      amount: { currency_code: "USD", value: "1.00" },
    })]);

    assert.deepEqual(made.review, []);
  });
});
