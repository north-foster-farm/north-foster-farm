// Criteria tests for #708 (Record the live Venmo responses as PayPal
// fixtures), its box on bin/fixtures/scrub: it "knows PayPal's shapes on
// the request side as well as the response side (the webhook event body
// and the verify call's webhook_event: surname, full_name, admin_area_2,
// Venmo's user_name, paypal-transmission-sig, paypal-transmission-id,
// the cert URL), with its review list covering both."
//
// Held out of npm test (*.criteria.mjs) until the change lands. Every
// value below is crafted: none comes from a real recording. The records
// take lib/recorder.mjs's shape, { name, service: "paypal", status,
// request: { method, path, headers, body }, response, at }, plus the
// `recorded` date bin/fixtures/scrub's main() adds from the file.
//
// Each record is scrubbed on its own, so a value one record names as an
// id (the verify call's transmission_id) cannot rescue another record
// that only carries it in a header.

// PayPal's keys are snake_case, as in test/fixtures-record.test.mjs.
/* eslint camelcase: ["error", { "properties": "never" }] */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { scrubAll } from "../bin/fixtures/scrub";

const SURNAME = "Zebulonsky";
const FULL_NAME = "Crafted Zebulonsky";
const TOWN = "Quahogton";
const HANDLE = "zeb-crafted-handle";
const SIG = "craftedSIGx9Qv7LmN2pR4tW6yZ8bD0fH3jK5==";
const TRANSMISSION_ID = "c4f7e2a0-crafted-transmission-0001";
const CERT_ID = "CERT-crafted-0001";
const CERT_URL = `https://api.paypal.com/v1/notifications/certs/${CERT_ID}`;

const PAYER_VALUES = [SURNAME, FULL_NAME, TOWN, HANDLE];
const DELIVERY_VALUES = [SIG, TRANSMISSION_ID, CERT_URL, CERT_ID];
const ALL_VALUES = [...PAYER_VALUES, ...DELIVERY_VALUES];

const address = () => ({
  address_line_1: "1 Crafted Lane",
  admin_area_2: TOWN,
  admin_area_1: "QZ",
  postal_code: "09999",
  country_code: "US",
});

// A Venmo order as PayPal returns it, with the payer's details in each
// place PayPal puts them, and one string no rule covers.
const order = () => ({
  id: "CraftedOrder0001",
  intent: "CAPTURE",
  status: "COMPLETED",
  payment_source: {
    venmo: {
      email_address: "zeb.crafted@crafted.test",
      account_id: "CRAFTEDACCT0001",
      user_name: HANDLE,
      name: { given_name: "Crafted", surname: SURNAME },
      address: address(),
    },
  },
  purchase_units: [{
    reference_id: "default",
    shipping: { name: { full_name: FULL_NAME }, address: address() },
    payments: {
      captures: [{
        id: "CraftedCapture01",
        status: "COMPLETED",
        amount: { currency_code: "USD", value: "1.00" },
      }],
    },
  }],
  payer: {
    name: { given_name: "Crafted", surname: SURNAME },
    email_address: "zeb.crafted@crafted.test",
    payer_id: "CRAFTEDPAYER01",
    address: { country_code: "US" },
  },
});

// The webhook event body, as PayPal delivers it.
const event = () => ({
  id: "WH-CRAFTED-0001",
  event_version: "1.0",
  create_time: "2026-11-21T14:01:00Z",
  resource_type: "checkout-order",
  event_type: "CHECKOUT.ORDER.APPROVED",
  resource: { ...order(), something_new: "A Free Text Thing" },
});

const record = (name, request, response) => ({
  name,
  service: "paypal",
  status: 200,
  request,
  response,
  at: "2026-11-21T14:01:00.000Z",
  recorded: "2026-11-21",
});

// The delivery to /api/paypal/webhook: the event is the request body and
// the transmission headers ride along.
const webhook = () => record("webhook-order-approved", {
  method: "POST",
  path: "/api/paypal/webhook",
  headers: {
    "content-type": "application/json",
    "paypal-auth-algo": "SHA256withRSA",
    "paypal-cert-url": CERT_URL,
    "paypal-transmission-id": TRANSMISSION_ID,
    "paypal-transmission-sig": SIG,
    "paypal-transmission-time": "2026-11-21T14:01:00Z",
  },
  body: event(),
}, { ignored: true });

// The verify call lib/paypal.mjs makes for that delivery: the event
// again, as webhook_event, beside the transmission fields.
const verify = () => {
  const body = {
    auth_algo: "SHA256withRSA",
    cert_url: CERT_URL,
    transmission_id: TRANSMISSION_ID,
    transmission_sig: SIG,
    transmission_time: "2026-11-21T14:01:00Z",
    webhook_id: "CRAFTEDWEBHOOK01",
    webhook_event: event(),
  };

  body.webhook_event.resource.something_new = "Another Free Text Thing";

  return record("verify-webhook-signature", {
    method: "POST",
    path: "/v1/notifications/verify-webhook-signature",
    headers: { "content-type": "application/json" },
    body,
  }, { verification_status: "SUCCESS" });
};

// The capture: the payer's details are in the response.
const capture = () => {
  const answer = order();

  answer.payment_source.venmo.something_new = "A Third Free Text Thing";

  return record("capture-venmo", {
    method: "POST",
    path: "/v2/checkout/orders/CraftedOrder0001/capture",
    headers: {
      "content-type": "application/json",
      "paypal-request-id": "crafted-request-0001",
    },
    body: {},
  }, answer);
};

const scrubOne = (raw) => {
  const [made] = scrubAll([raw]);

  return made;
};

const survivors = (json, values) => {
  const text = JSON.stringify(json);

  return values.filter((value) => text.includes(value));
};

const at = (node, path) => path.split(".")
  .reduce((here, key) => (here == null ? here : here[key]), node);

// The vendor's shape stays: each scrubbed key is still there, holding a
// string, so a fake can answer with it.
const assertKept = (json, paths) => {
  for (const path of paths) {
    assert.equal(typeof at(json, path), "string", `${path} is kept`);
  }
};

const PAYER_PATHS = (root) => [
  `${root}.payment_source.venmo.user_name`,
  `${root}.payment_source.venmo.name.surname`,
  `${root}.payment_source.venmo.address.admin_area_2`,
  `${root}.purchase_units.0.shipping.name.full_name`,
  `${root}.purchase_units.0.shipping.address.admin_area_2`,
  `${root}.payer.name.surname`,
];

describe("bin/fixtures/scrub knows PayPal's shapes on the request side "
  + "as well as the response side, with its review list covering both",
() => {
  it("scrubs the webhook event body and the transmission headers", () => {
    const { json } = scrubOne(webhook());

    assert.deepEqual(survivors(json.request, ALL_VALUES), [],
      "no payer detail or delivery header survives in the webhook request");
    assertKept(json, [
      ...PAYER_PATHS("request.body.resource"),
      "request.headers.paypal-transmission-sig",
      "request.headers.paypal-transmission-id",
      "request.headers.paypal-cert-url",
    ]);
  });

  it("scrubs the verify call's webhook_event and transmission fields",
    () => {
      const { json } = scrubOne(verify());

      assert.deepEqual(survivors(json.request, ALL_VALUES), [],
        "no payer detail or delivery field survives in the verify call");
      assertKept(json, [
        ...PAYER_PATHS("request.body.webhook_event.resource"),
        "request.body.transmission_sig",
        "request.body.transmission_id",
        "request.body.cert_url",
      ]);
    });

  it("scrubs the same payer keys in a capture's response", () => {
    const { json } = scrubOne(capture());

    assert.deepEqual(survivors(json.response, PAYER_VALUES), [],
      "no payer detail survives in the capture's response");
    assertKept(json, PAYER_PATHS("response"));
  });

  it("scrubs all three together, leaving none of the crafted values",
    () => {
      const made = scrubAll([capture(), webhook(), verify()]);

      assert.deepEqual(survivors(made.map((f) => f.json), ALL_VALUES), []);
    });

  it("lists, by path, an uncovered string in the request and the response",
    () => {
      const listed = (made, pattern) => made.review
        .some((path) => pattern.test(path));
      const hook = scrubOne(webhook());
      const check = scrubOne(verify());
      const paid = scrubOne(capture());

      assert.ok(listed(hook, /(^|\.)body\.resource\.something_new$/),
        `webhook request listed: ${JSON.stringify(hook.review)}`);
      assert.ok(listed(check,
        /(^|\.)body\.webhook_event\.resource\.something_new$/),
      `verify request listed: ${JSON.stringify(check.review)}`);
      assert.ok(listed(paid, /(^|\.)payment_source\.venmo\.something_new$/),
        `capture response listed: ${JSON.stringify(paid.review)}`);

      for (const made of [hook, check, paid]) {
        assert.deepEqual(survivors(made.review, [
          ...ALL_VALUES, "Free Text Thing",
        ]), [], `${made.name}'s review list quotes no value`);
      }
    });
});
