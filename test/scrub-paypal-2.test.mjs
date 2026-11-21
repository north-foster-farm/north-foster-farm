// Criteria tests for #730 (Scrub: a bare id key and any-case Token as
// id keys), one per box of its "Done when" but the last two: every
// existing scrub test is its own check, and the run on the live
// recordings is the fixtures-tests lane's. The link-forms box and the
// two after it are security's, from its review of #735 (2026-11-21).
//
// Every value below is crafted: none comes from a real recording. The
// records
// take netlify/functions/lib/recorder.mjs's shape, { name, service:
// "paypal", status, request: { method, path, headers, body }, response,
// at }, plus the `recorded` date bin/fixtures/scrub's main() adds.
//
// The seam assumed: bin/fixtures/scrub's scrubAll(files) ->
// [{ service, name, json, review }], as today, where `review` lists
// paths with array positions left out (purchase_units.description) and
// request paths prefixed "request.", and a placeholder matches
// /^[A-Z][A-Z0-9_]*_\d+$/. A record carries no environment of its own,
// so the scrubber tells production from the record itself: the test of
// that box gives it PayPal's live hosts (api-m.paypal.com in links,
// api.paypal.com in the cert URL) and expects "production" or "live".
// Where the spec leaves a placeholder's kind open, the tests ask only
// for a placeholder; the one-name box asks for ORDER_ID_n, the name a
// path gives an order today. A checkoutnow token survives raw only when
// it is too short to swap (under six characters, as today), so the
// tests' raw token is four. A doc link holds no id, so it comes out as
// it went in.

// PayPal's keys are snake_case, as in test/scrub-paypal.test.mjs.
/* eslint camelcase: ["error", { "properties": "never" }] */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { scrubAll } from "../bin/fixtures/scrub";

const COMPANY = JSON.parse(readFileSync(
  new URL("../data/company.json", import.meta.url), "utf8")).name;
const PLACEHOLDER = /^[A-Z][A-Z0-9_]*_\d+$/;
const LIVE = "https://api-m.paypal.com";
const SANDBOX = "https://api-m.sandbox.paypal.com";

// A recorder's name for an exchange: the raw path, slugged.
const nameFor = (method, path) => [
  "paypal-20261121T140100123Z", method.toLowerCase(),
  path.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""),
  "1a2b3c",
].join("-");

const record = (method, path, { body = null, headers = {}, status = 200,
  response = null } = {}) => ({
  name: nameFor(method, path),
  service: "paypal",
  status,
  request: { method, path, headers, body },
  response,
  at: "2026-11-21T14:01:00.000Z",
  recorded: "2026-11-21",
});

const failed = { name: "UNPROCESSABLE_ENTITY", details: [] };

const one = (raw) => scrubAll([raw])[0];

const text = (made) => JSON.stringify([made.json, made.name, made.review]);

const at = (node, path) => path.split(".")
  .reduce((here, key) => (here == null ? here : here[key]), node);

// The webhook event PayPal delivers, and the verify call lib/paypal.mjs
// makes for it, which carries the event again as webhook_event.
const webhook = (event) => record("POST", "/api/paypal/webhook", {
  headers: {
    "content-type": "application/json",
    "paypal-auth-algo": "SHA256withRSA",
    "paypal-cert-url":
      "https://api.paypal.com/v1/notifications/certs/CERT-crafted-0730",
    "paypal-transmission-id": "c4f7e2a0-crafted-transmission-0730",
    "paypal-transmission-sig": "craftedSIG730x9Qv7LmN2pR4tW6yZ8bD0fH3==",
    "paypal-transmission-time": "2026-11-21T14:01:00Z",
  },
  body: event,
  response: { ignored: true },
});
const verify = (event) => record("POST",
  "/v1/notifications/verify-webhook-signature", {
    headers: { "content-type": "application/json" },
    body: {
      auth_algo: "SHA256withRSA",
      cert_url:
        "https://api.paypal.com/v1/notifications/certs/CERT-crafted-0730",
      transmission_id: "c4f7e2a0-crafted-transmission-0730",
      transmission_sig: "craftedSIG730x9Qv7LmN2pR4tW6yZ8bD0fH3==",
      transmission_time: "2026-11-21T14:01:00Z",
      webhook_id: "CRAFTEDWEBHOOK730",
      webhook_event: event,
    },
    response: { verification_status: "SUCCESS" },
  });

describe("#730: bin/fixtures/scrub's id keys and PayPal's safe fields", () => {
  it("?id=ALLLETTERS comes out swapped, with nothing raw in the path, "
    + "the responses or the file name", () => {
    const raw = "QZKXMWRTPLHVB";
    const made = one(record("GET", `/v2/checkout/orders?id=${raw}`, {
      status: 404,
      response: {
        name: "RESOURCE_NOT_FOUND",
        details: [{ field: "id", value: raw, location: "query",
          issue: "INVALID_RESOURCE_ID" }],
      },
    }));
    const [, swapped] = made.json.request.path.split("?id=");

    assert.match(swapped, PLACEHOLDER, made.json.request.path);
    assert.ok(!made.json.request.path.includes(raw), "path");
    assert.ok(!JSON.stringify(made.json.response).includes(raw),
      "responses");
    assert.ok(!made.name.toLowerCase().includes(raw.toLowerCase()),
      made.name);
  });

  it("?Token=EC-... comes out swapped like ?token=", () => {
    // One all letters after EC-, one with digits.
    for (const raw of ["EC-QZKXMWRTPLHVBN", "EC-4KX12345AB6789012"]) {
      const lower = one(record("GET", `/v1/checkout/approve?token=${raw}`,
        { response: failed }));
      const upper = one(record("GET", `/v1/checkout/approve?Token=${raw}`,
        { response: failed }));

      assert.equal(upper.json.request.path,
        lower.json.request.path.replace("?token=", "?Token="), raw);
      assert.match(upper.json.request.path.split("?Token=")[1],
        PLACEHOLDER, upper.json.request.path);
      assert.ok(!upper.name.toLowerCase().includes(raw.toLowerCase()),
        upper.name);
      assert.deepEqual(upper.review, lower.review, raw);
    }
  });

  it("a query value that is a comma list of lowercase words or enums "
    + "does not list request.path", () => {
    const path = "/v1/reporting/transactions"
      + "?fields=all,transaction_info,payer_info"
      + "&transaction_status=S,P,V&status=COMPLETED,PENDING&page=2";
    const made = one(record("GET", path, { response: { status: "OK" } }));

    assert.equal(made.json.request.path, path);
    assert.ok(!made.review.includes("request.path"),
      JSON.stringify(made.review));

    // A list holding a word that is neither still is.
    const named = one(record("GET",
      "/v1/reporting/transactions?fields=all,Marblethorpe",
      { response: { status: "OK" } }));

    assert.deepEqual(named.review, ["request.path"]);
  });

  it("PayPal's links (rel, and href in one of PayPal's own link forms: an "
    + "API URL on api.paypal.com, api-m.paypal.com or a sandbox host, the "
    + "checkoutnow approve link with a placeholder token, a "
    + "developer.paypal.com doc link) are not listed for review, with ids "
    + "in href swapped; an href on any other host, or a checkoutnow link "
    + "whose token is not a placeholder, is listed", () => {
    const order = "CraftedOrd7301";
    const capture = "CraftedCap7301";
    const hook = "WH-CRAFTED7301-0730";
    const captureLinks = (host) => [
      { href: `${host}/v2/payments/captures/${capture}`, rel: "self",
        method: "GET" },
      { href: `${host}/v2/payments/captures/${capture}/refund`,
        rel: "refund", method: "POST" },
      { href: `${host}/v2/checkout/orders/${order}`, rel: "up",
        method: "GET" },
    ];
    const answer = (host) => ({
      id: order,
      status: "COMPLETED",
      purchase_units: [{
        reference_id: "default",
        payments: { captures: [{
          id: capture, status: "COMPLETED", links: captureLinks(host),
        }] },
      }],
      links: [
        { href: `${host}/v2/checkout/orders/${order}`, rel: "self",
          method: "GET" },
      ],
    });
    const event = (host) => ({
      id: hook,
      event_version: "1.0",
      create_time: "2026-11-21T14:01:00Z",
      resource_type: "capture",
      event_type: "PAYMENT.CAPTURE.COMPLETED",
      resource: { id: capture, status: "COMPLETED",
        links: captureLinks(host) },
      links: [
        { href: `${host}/v1/notifications/webhooks-events/${hook}`,
          rel: "self", method: "GET" },
        { href: `${host}/v1/notifications/webhooks-events/${hook}/resend`,
          rel: "resend", method: "POST" },
      ],
    });
    const isLink = (path) => /(^|\.)links\.(rel|href)$/.test(path);

    for (const host of [LIVE, SANDBOX, "https://api.paypal.com",
      "https://api.sandbox.paypal.com"]) {
      const made = scrubAll([
        record("POST", `/v2/checkout/orders/${order}/capture`,
          { body: {}, status: 201, response: answer(host) }),
        webhook(event(host)),
        verify(event(host)),
      ]);

      for (const file of made) {
        assert.deepEqual(file.review.filter(isLink), [],
          `${host}: ${JSON.stringify(file.review)}`);
        const hrefs = [];

        JSON.stringify(file.json, (key, value) => {
          if (key === "href") hrefs.push(value);

          return value;
        });
        assert.ok(hrefs.length > 0, file.name);
        for (const href of hrefs) {
          assert.ok(href.startsWith(`${host}/`), href);
          for (const raw of [order, capture, hook]) {
            assert.ok(!href.includes(raw), href);
          }
          assert.ok(href.slice(host.length).split("/").filter(Boolean)
            .some((word) => PLACEHOLDER.test(word)), href);
        }
      }
    }

    // Any other host stays for review, by path.
    const other = answer(LIVE);

    other.links.push({ href: "https://crafted.example/elsewhere",
      rel: "self", method: "GET" });
    const [elsewhere] = scrubAll([record("GET", `/v2/checkout/orders/${order}`,
      { response: other })]);

    assert.ok(elsewhere.review.includes("links.href"),
      JSON.stringify(elsewhere.review));

    // The approve link carries the order id as its token, and an error
    // answer links to PayPal's docs.
    for (const site of ["https://www.paypal.com",
      "https://www.sandbox.paypal.com"]) {
      const approve = `${site}/checkoutnow?token=${order}`;
      const docs = "https://developer.paypal.com/docs/api/orders/v2/"
        + "#error-INSTRUMENT_DECLINED";
      const [created, declined] = scrubAll([
        record("POST", "/v2/checkout/orders", {
          body: { intent: "CAPTURE" },
          status: 201,
          response: {
            id: order,
            status: "PAYER_ACTION_REQUIRED",
            links: [
              { href: `${LIVE}/v2/checkout/orders/${order}`, rel: "self",
                method: "GET" },
              { href: approve, rel: "payer-action", method: "GET" },
            ],
          },
        }),
        record("POST", `/v2/checkout/orders/${order}/capture`, {
          body: {},
          status: 422,
          response: {
            ...failed,
            links: [{ href: docs, rel: "information_link",
              method: "GET" }],
          },
        }),
      ]);
      const [, link] = created.json.response.links;

      assert.deepEqual(created.review.filter(isLink), [],
        `${site}: ${JSON.stringify(created.review)}`);
      assert.equal(link.href,
        `${site}/checkoutnow?token=${created.json.response.id}`, site);
      assert.match(link.href.split("?token=")[1], PLACEHOLDER, link.href);
      assert.deepEqual(declined.review.filter(isLink), [],
        `${site}: ${JSON.stringify(declined.review)}`);
      assert.equal(declined.json.response.links[0].href, docs,
        "a doc link holds no id");
    }

    // A token too short to swap survives raw, so its link is listed.
    const [raw] = scrubAll([record("GET", `/v2/checkout/orders/${order}`, {
      response: {
        id: order,
        status: "PAYER_ACTION_REQUIRED",
        links: [{ href: "https://www.paypal.com/checkoutnow?token=Q7X2",
          rel: "payer-action", method: "GET" }],
      },
    })]);

    const kept = raw.json.response.links[0].href.split("?token=")[1];

    assert.ok(!PLACEHOLDER.test(kept), `the case needs a raw token: ${kept}`);
    assert.ok(raw.review.includes("links.href"), JSON.stringify(raw.review));
  });

  it("brand_name, a webhook's summary and an error's details.description "
    + "are not listed for review", () => {
    const event = {
      id: "WH-CRAFTED7302-0730",
      event_version: "1.0",
      create_time: "2026-11-21T14:01:00Z",
      resource_type: "checkout-order",
      event_type: "CHECKOUT.ORDER.APPROVED",
      summary: "An order has been approved by buyer",
      resource: { id: "CraftedOrd7302", status: "APPROVED" },
    };
    const made = scrubAll([
      record("POST", "/v2/checkout/orders", {
        body: {
          intent: "CAPTURE",
          application_context: { brand_name: COMPANY,
            shipping_preference: "NO_SHIPPING", user_action: "PAY_NOW" },
        },
        status: 201,
        response: { id: "CraftedOrd7302", status: "CREATED" },
      }),
      record("GET", "/v2/checkout/orders/CraftedOrd7302", {
        response: {
          id: "CraftedOrd7302",
          status: "APPROVED",
          purchase_units: [{
            reference_id: "default",
            payee: { display_data: { brand_name: COMPANY } },
          }],
        },
      }),
      webhook(event),
      verify(event),
      record("POST", "/v2/checkout/orders/CraftedOrd7302/capture", {
        body: {},
        status: 422,
        response: {
          name: "UNPROCESSABLE_ENTITY",
          message: "The requested action could not be performed, "
            + "semantically incorrect, or failed business validation.",
          debug_id: "crafteddebug7302",
          details: [{ issue: "INSTRUMENT_DECLINED",
            description: "The instrument presented was either declined "
              + "by the processor or bank, or it can't be used for this "
              + "payment." }],
        },
      }),
    ]);
    const safe = /(^|\.)(brand_name|summary|details\.description)$/;

    for (const file of made) {
      assert.deepEqual(file.review.filter((path) => safe.test(path)), [],
        `${file.name}: ${JSON.stringify(file.review)}`);
    }
  });

  it("purchase_units.description of the form <company name> order "
    + "<order id> comes out with the id swapped and is not listed; any "
    + "other text is listed", () => {
    const ours = "NFF-2611-QZXK";
    const [made] = scrubAll([record("POST", "/v2/checkout/orders", {
      body: {
        intent: "CAPTURE",
        purchase_units: [{
          reference_id: ours,
          custom_id: ours,
          description: `${COMPANY} order ${ours}`,
          amount: { currency_code: "USD", value: "1.00" },
        }],
      },
      status: 201,
      response: { id: "CraftedOrd7303", status: "CREATED" },
    })]);
    const unit = made.json.request.body.purchase_units[0];

    assert.match(unit.custom_id, PLACEHOLDER);
    assert.equal(unit.description, `${COMPANY} order ${unit.custom_id}`);
    assert.ok(!text(made).includes(ours), "the order id is swapped");
    assert.ok(!made.review
      .includes("request.body.purchase_units.description"),
    JSON.stringify(made.review));

    const [other] = scrubAll([record("GET",
      "/v2/checkout/orders/CraftedOrd7304", {
        response: {
          id: "CraftedOrd7304",
          status: "APPROVED",
          purchase_units: [{
            reference_id: "default",
            description: "Sourdough for Marblethorpe, by the barn door",
          }],
        },
      })]);

    assert.ok(other.review.includes("purchase_units.description"),
      JSON.stringify(other.review));
  });

  it("note_to_payer becomes a fixed placeholder wherever it sits, and its "
    + "text appears nowhere else in the output", () => {
    const capture = "CraftedCap7305";
    const typed = "Sorry Quill Zanzibrook, we were short a loaf";
    const other = "Refund for the Pellingworth eggs, cracked in transit";
    const refundEvent = {
      id: "WH-CRAFTED7305-0730",
      event_version: "1.0",
      create_time: "2026-11-21T14:01:00Z",
      resource_type: "refund",
      event_type: "PAYMENT.CAPTURE.REFUNDED",
      resource: {
        id: "CraftedRef7305",
        status: "COMPLETED",
        note_to_payer: other,
        amount: { currency_code: "USD", value: "1.00" },
      },
    };
    const made = scrubAll([
      record("POST", `/v2/payments/captures/${capture}/refund`, {
        body: { amount: { currency_code: "USD", value: "1.00" },
          note_to_payer: typed },
        status: 201,
        response: { id: "CraftedRef7305", status: "COMPLETED",
          note_to_payer: typed },
      }),
      webhook(refundEvent),
      verify(refundEvent),
    ]);
    const notes = [
      at(made[0].json, "request.body.note_to_payer"),
      at(made[0].json, "response.note_to_payer"),
      at(made[1].json, "request.body.resource.note_to_payer"),
      at(made[2].json, "request.body.webhook_event.resource.note_to_payer"),
    ];

    assert.equal(typeof notes[0], "string");
    assert.deepEqual(notes, notes.map(() => notes[0]),
      "one fixed placeholder, whatever the farm typed");
    for (const file of made) {
      for (const word of [typed, other, "Zanzibrook", "Pellingworth",
        "short a loaf", "cracked in transit"]) {
        assert.ok(!text(file).includes(word), `${file.name}: ${word}`);
      }
    }
  });

  it("a note_to_payer whose text is exactly an order's <company name> "
    + "order <order id> reads as that form with the id swapped, in the note "
    + "and in the order's description alike", () => {
    const ours = "NFF-2611-QZXN";
    const form = `${COMPANY} order ${ours}`;
    const order = record("POST", "/v2/checkout/orders", {
      body: {
        intent: "CAPTURE",
        purchase_units: [{ reference_id: ours, custom_id: ours,
          description: form,
          amount: { currency_code: "USD", value: "1.00" } }],
      },
      status: 201,
      response: { id: "CraftedOrd7308", status: "CREATED" },
    });
    const refunded = {
      id: "WH-CRAFTED7308-0730",
      event_version: "1.0",
      create_time: "2026-11-21T14:01:00Z",
      resource_type: "refund",
      event_type: "PAYMENT.CAPTURE.REFUNDED",
      resource: { id: "CraftedRef7308", status: "COMPLETED",
        note_to_payer: form,
        amount: { currency_code: "USD", value: "1.00" } },
    };
    const refund = record("POST", "/v2/payments/captures/CraftedCap7308/"
      + "refund", {
      body: { amount: { currency_code: "USD", value: "1.00" },
        note_to_payer: form },
      status: 201,
      response: { id: "CraftedRef7308", status: "COMPLETED",
        note_to_payer: form },
    });

    // Whichever the scrubber meets first, the order or the note.
    for (const files of [[order, refund, webhook(refunded),
      verify(refunded)], [refund, webhook(refunded), verify(refunded),
      order]]) {
      const made = scrubAll(files);
      const placed = made.find((f) => f.json.request.path
        === "/v2/checkout/orders");
      const [refundOut, hookOut, verifyOut] = made
        .filter((f) => f !== placed);
      const unit = placed.json.request.body.purchase_units[0];
      const swapped = `${COMPANY} order ${unit.custom_id}`;

      assert.match(unit.custom_id, PLACEHOLDER);
      assert.equal(unit.description, swapped, "the description");
      for (const [file, path] of [
        [refundOut, "request.body.note_to_payer"],
        [refundOut, "response.note_to_payer"],
        [hookOut, "request.body.resource.note_to_payer"],
        [verifyOut, "request.body.webhook_event.resource.note_to_payer"],
      ]) {
        assert.equal(at(file.json, path), swapped, path);
      }
      for (const file of made) {
        assert.ok(!text(file).includes(ours), file.name);
      }
    }
  });

  it("a PayPal order id gets one name everywhere, whether a top-level id "
    + "or a path shows it first", () => {
    const raw = "CraftedOrd7306";
    const created = record("POST", "/v2/checkout/orders", {
      body: { intent: "CAPTURE" },
      status: 201,
      response: { id: raw, status: "CREATED" },
    });
    const captured = record("POST", `/v2/checkout/orders/${raw}/capture`, {
      body: {},
      status: 201,
      response: { id: raw, status: "COMPLETED" },
    });
    const namesOf = (made) => {
      const create = made.find((f) => f.json.request.path
        === "/v2/checkout/orders");
      const capture = made.find((f) => f !== create);

      return [
        create.json.response.id,
        capture.json.request.path.split("/")[4],
        capture.json.response.id,
      ];
    };
    const idFirst = scrubAll([created, captured]);
    const pathFirst = scrubAll([captured, created]);

    for (const [made, order] of [[idFirst, "id first"],
      [pathFirst, "path first"]]) {
      const names = namesOf(made);

      assert.match(names[0], /^ORDER_ID_\d+$/, order);
      assert.deepEqual(names, names.map(() => names[0]), order);
      for (const file of made) {
        assert.ok(!/(^|-)id-id(-|$)/.test(file.name), file.name);
        assert.ok(!text(file).includes(raw), file.name);
      }
    }
  });

  it("_source.environment is right for a PayPal record from production",
    () => {
      const made = scrubAll([
        record("GET", "/v2/checkout/orders/CraftedOrd7307", {
          response: {
            id: "CraftedOrd7307",
            status: "COMPLETED",
            links: [{ href: `${LIVE}/v2/checkout/orders/CraftedOrd7307`,
              rel: "self", method: "GET" }],
          },
        }),
        webhook({
          id: "WH-CRAFTED7307-0730",
          event_version: "1.0",
          create_time: "2026-11-21T14:01:00Z",
          resource_type: "checkout-order",
          event_type: "CHECKOUT.ORDER.COMPLETED",
          resource: { id: "CraftedOrd7307", status: "COMPLETED" },
          links: [{ href:
            `${LIVE}/v1/notifications/webhooks-events/WH-CRAFTED7307-0730`,
          rel: "self", method: "GET" }],
        }),
      ]);

      for (const file of made) {
        assert.match(file.json._source.environment, /^(production|live)$/,
          file.name);
      }
    });

  it("an href counts as safe only in PayPal's exact link forms, each with "
    + "a crafted negative test", () => {
    const order = "CraftedOrd7309";
    const linked = (href) => one(record("GET",
      `/v2/checkout/orders/${order}`, {
        response: { id: order, status: "APPROVED",
          links: [{ href, rel: "self", method: "GET" }] },
      }));
    const docs = "https://developer.paypal.com";

    for (const href of [
      // API hosts: a fragment, a query key not PayPal's, a route word
      // not PayPal's.
      `${LIVE}/v2/checkout/orders/${order}#Quill-Zanzibrook`,
      `${SANDBOX}/v2/checkout/orders/${order}#crafted`,
      `${LIVE}/v2/checkout/orders/${order}?payer=janedoe`,
      `https://api.paypal.com/v2/checkout/orders/${order}?payer=janedoe`,
      `${SANDBOX}/v1/janedoe/${order}`,
      `https://api.sandbox.paypal.com/v1/janedoe/${order}`,
      // On www, any path but /checkoutnow, another query key, a raw token.
      "https://www.paypal.com/paypalme/quillzanzibrook",
      "https://www.sandbox.paypal.com/myaccount/summary",
      `https://www.paypal.com/checkoutnow?token=${order}&payer=janedoe`,
      `https://www.paypal.com/checkoutnow?token=${order}#crafted`,
      "https://www.paypal.com/checkoutnow?token=Q7X2",
      // On developer, a path outside /docs/ and /api/, a query, a fragment
      // holding text.
      `${docs}/community/janedoe`,
      `${docs}/docs/api/orders/v2/?payer=janedoe`,
      `${docs}/docs/api/orders/v2/#Quill%20Zanzibrook`,
      `${docs}/api/rest/#note=janedoe`,
    ]) {
      const made = linked(href);

      assert.ok(made.review.includes("links.href"),
        `${href}: ${JSON.stringify(made.review)}`);
    }
  });

  it("rel, summary and details.description are safe only at PayPal's own "
    + "paths and shapes", () => {
    const free = "Quill Zanzibrook asked for the barn door";
    const [answer] = scrubAll([record("GET",
      "/v2/checkout/orders/CraftedOrd7310", {
        response: {
          id: "CraftedOrd7310",
          status: "APPROVED",
          payer: { rel: free, summary: free, details: { description: free } },
          links: [{ href: `${LIVE}/v2/checkout/orders/CraftedOrd7310`,
            rel: free, method: "GET" }],
        },
      })]);

    for (const path of ["payer.rel", "payer.summary",
      "payer.details.description", "links.rel"]) {
      assert.ok(answer.review.includes(path),
        `${path}: ${JSON.stringify(answer.review)}`);
    }

    const event = {
      id: "WH-CRAFTED7310-0730",
      event_version: "1.0",
      create_time: "2026-11-21T14:01:00Z",
      resource_type: "checkout-order",
      event_type: "CHECKOUT.ORDER.APPROVED",
      summary: "An order has been approved by buyer",
      resource: { id: "CraftedOrd7310", status: "APPROVED", summary: free },
    };
    const [hook, check] = scrubAll([webhook(event), verify(event)]);

    assert.ok(hook.review.includes("request.body.resource.summary"),
      JSON.stringify(hook.review));
    assert.ok(check.review
      .includes("request.body.webhook_event.resource.summary"),
    JSON.stringify(check.review));
  });

  it("a note_to_payer echoed elsewhere with different whitespace, or "
    + "truncated, is still taken out (or listed), never left raw in a safe "
    + "key such as message", () => {
    const typed = "Sorry Quill  Zanzibrook,\nwe were short a loaf";
    const refund = (message) => record("POST",
      "/v2/payments/captures/CraftedCap7311/refund", {
        body: { amount: { currency_code: "USD", value: "1.00" },
          note_to_payer: typed },
        status: 422,
        response: { name: "UNPROCESSABLE_ENTITY", message, details: [] },
      });

    for (const echo of [
      "Sorry Quill Zanzibrook, we were short a loaf",
      "Sorry Quill Zanzibrook,\twe were  short a loaf",
      "Sorry Quill Zanzibrook, we were sh",
    ]) {
      const made = one(refund(echo));
      const out = made.json.response.message;

      assert.ok(!/Zanzibrook|short a loaf/.test(out)
        || made.review.includes("message"),
      `${JSON.stringify(echo)} -> ${JSON.stringify(out)}: ${
        JSON.stringify(made.review)}`);
    }
  });
});
