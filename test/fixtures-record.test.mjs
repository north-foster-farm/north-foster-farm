import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { scrubAll } from "../bin/fixtures/scrub";
import { sampleOrder } from "../bin/fixtures/request.mjs";
import { buildOrder, settings } from "../netlify/functions/lib/square.mjs";

const RECORD = new URL("../bin/fixtures/record", import.meta.url).pathname;
const REQUEST = new URL("../bin/fixtures/request.mjs", import.meta.url)
  .pathname;

const request = (call, args) => JSON.parse(spawnSync(process.execPath,
  [REQUEST, call, JSON.stringify(args)], { encoding: "utf8" }).stdout);

// What bin/fixtures/record keeps, with real-looking values to lose.
const raw = (name, seq, over) => ({
  name, service: "square", seq, status: 200, recorded: "2026-10-26",
  request: {
    method: "POST", path: "/v2/payments",
    headers: { "Square-Version": "2026-09-16", "Idempotency-Key": "k-9f3a" },
    body: {
      idempotency_key: "k-9f3a",
      order_id: "RealOrderId0001",
      customer_id: "RealCustomerId01",
      source_id: "cnon:card-nonce-ok",
      reference_id: "NFF-2610-FIXT",
      buyer_email_address: "pat.real@farmhouse.test",
    },
  },
  response: {},
  ...over,
});

const FILES = [
  raw("order", 1, {
    request: {
      method: "POST", path: "/v2/orders/RealOrderId0001",
      headers: { "Square-Version": "2026-09-16" }, body: null,
    },
    response: {
      order: {
        id: "RealOrderId0001",
        customer_id: "RealCustomerId01",
        tenders: [{ id: "RealPaymentId01", payment_id: "RealPaymentId01" }],
        fulfillments: [{
          uid: "RealFulfilUid01",
          pickup_details: {
            recipient: {
              display_name: "Pat Real",
              email_address: "pat.real@farmhouse.test",
              phone_number: "+14015551234",
            },
          },
        }],
      },
    },
  }),
  raw("payment", 2, {
    response: {
      payment: {
        id: "RealPaymentId01",
        order_id: "RealOrderId0001",
        status: "COMPLETED",
        receipt_url: "https://squareupsandbox.com/receipt/preview/"
          + "RealPaymentId01",
        card_details: { card: { fingerprint: "sq-1-RealPrint" } },
        something_new: "A Free Text Thing",
      },
    },
  }),
  raw("locations", 3, {
    request: {
      method: "GET", path: "/v2/locations",
      headers: { "Square-Version": "2026-09-16" }, body: null,
    },
    response: {
      locations: [{
        id: "RealLocation001",
        name: "Real Farm Stand",
        business_name: "Real Farm LLC",
        address: { address_line_1: "1 Real Road", locality: "Realville" },
        coordinates: { latitude: 41.5, longitude: -71.3 },
        phone_number: "+14015559999",
        status: "ACTIVE",
      }],
    },
  }),
];

describe("bin/fixtures/scrub", () => {
  const out = scrubAll(FILES);
  const text = JSON.stringify(out.map((f) => f.json));
  const named = (name) => out.find((f) => f.name === name).json;

  it("leaves none of the real ids, emails, names or places", () => {
    for (const real of [
      "RealOrderId0001", "RealCustomerId01", "RealPaymentId01",
      "RealFulfilUid01", "pat.real@farmhouse.test", "Pat Real",
      "+14015551234", "Real Farm", "Real Road", "Realville", "k-9f3a",
      "RealPrint", "RealLocation001", "41.5", "4015559999",
    ]) {
      assert.ok(!text.includes(real), real);
    }
  });

  it("gives one value one placeholder in every file", () => {
    const order = named("order");
    const payment = named("payment");

    assert.equal(order.request.path, "/v2/orders/ORDER_ID_1");
    assert.equal(order.response.order.id, "ORDER_ID_1");
    assert.equal(payment.response.payment.order_id, "ORDER_ID_1");
    assert.equal(payment.request.body.order_id, "ORDER_ID_1");
    assert.equal(order.response.order.customer_id, "CUSTOMER_ID_1");
    assert.equal(payment.request.body.customer_id, "CUSTOMER_ID_1");
  });

  it("names a tender's id for the payment it is", () => {
    const tender = named("order").response.order.tenders[0];

    assert.equal(tender.id, "PAYMENT_ID_1");
    assert.equal(tender.payment_id, "PAYMENT_ID_1");
    assert.equal(named("payment").response.payment.id, "PAYMENT_ID_1");
    assert.equal(named("payment").response.payment.receipt_url,
      "https://squareupsandbox.com/receipt/preview/PAYMENT_ID_1");
  });

  it("keeps the test nonce, our reference and the version", () => {
    const { request: sent, _source } = named("payment");

    assert.equal(sent.body.source_id, "cnon:card-nonce-ok");
    assert.equal(sent.body.reference_id, "NFF-2610-FIXT");
    assert.equal(_source.squareVersion, "2026-09-16");
    assert.equal(_source.recorded, "2026-10-26");
  });

  it("numbers an idempotency key and ties the header to the body", () => {
    const { request: sent } = named("payment");

    assert.equal(sent.body.idempotency_key, "IDEMPOTENCY_KEY_1");
    assert.equal(sent.headers["Idempotency-Key"], "IDEMPOTENCY_KEY_1");
  });

  it("swaps emails, phones, names and a location's own fields", () => {
    const [recipient] = [named("order").response.order.fulfillments[0]
      .pickup_details.recipient];
    const place = named("locations").response.locations[0];

    assert.equal(recipient.email_address, "customer@example.com");
    assert.equal(named("payment").request.body.buyer_email_address,
      "customer@example.com");
    assert.match(recipient.phone_number, /^\+1555555\d{4}$/);
    assert.equal(recipient.display_name, "Display Name");
    assert.equal(place.id, "LOCATION_ID_1");
    assert.equal(place.name, "REDACTED");
    assert.equal(place.address.address_line_1, "ADDRESS_LINE_1");
    assert.deepEqual(place.coordinates, { latitude: 0, longitude: 0 });
    assert.equal(place.status, "ACTIVE");
  });

  it("lists, by path, a string no rule covers", () => {
    assert.deepEqual(out.find((f) => f.name === "payment").review,
      ["payment.something_new"]);
    assert.deepEqual(out.find((f) => f.name === "order").review, []);
  });

  it("gives the same answer when run again", () => {
    assert.deepEqual(scrubAll(FILES), out);
  });
});

describe("bin/fixtures/record", () => {
  const envFile = (text) => {
    const dir = mkdtempSync(join(tmpdir(), "record-"));
    const path = join(dir, ".env.test");

    writeFileSync(path, text);

    return path;
  };

  it("refuses an env file that is not the sandbox's", () => {
    for (const text of [
      "SQUARE_ENV=production\nSQUARE_ACCESS_TOKEN=x\nSQUARE_LOCATION_ID=L\n",
      "SQUARE_ACCESS_TOKEN=x\nSQUARE_LOCATION_ID=L\n",
      "SQUARE_ENV=fake\n",
    ]) {
      const ran = spawnSync("bash", [RECORD, envFile(text)],
        { encoding: "utf8", env: { PATH: process.env.PATH } });

      assert.equal(ran.status, 1, text);
      assert.match(ran.stderr, /Refusing/, text);
      assert.ok(!ran.stdout.includes("Recording"), text);
    }
  });

  it("writes nothing and prints no key when it refuses", () => {
    const ran = spawnSync("bash", [RECORD, envFile(
      "SQUARE_ENV=production\nSQUARE_ACCESS_TOKEN=sq0secret\n"
    )], { encoding: "utf8", env: { PATH: process.env.PATH } });

    assert.ok(!(ran.stdout + ran.stderr).includes("sq0secret"));
    assert.ok(!existsSync(new URL("../.ignored/fixtures-raw/order.json",
      import.meta.url)));
  });

  it("asks for the file when given none", () => {
    const ran = spawnSync("bash", [RECORD],
      { encoding: "utf8", env: { PATH: process.env.PATH } });

    assert.equal(ran.status, 1);
    assert.match(ran.stderr, /Usage/);
  });
});

describe("bin/fixtures/request.mjs", () => {
  const args = {
    key: "k1", kind: "pickup", email: "a@example.com", locationId: "LOC",
  };

  it("prints the customer search, the profile and the order", () => {
    const sent = request("create-order", args);

    assert.deepEqual(sent.map((s) => `${s.method} ${s.path}`), [
      "POST /v2/customers/search", "POST /v2/customers", "POST /v2/orders",
    ]);
  });

  it("sends the order square.mjs builds, at the version it sends", () => {
    const sent = request("create-order", args);
    const cfg = settings({
      SQUARE_ENV: "sandbox", SQUARE_ACCESS_TOKEN: "t",
      SQUARE_LOCATION_ID: "LOC",
    });

    assert.deepEqual(sent[2].body.order, buildOrder(
      sampleOrder(args), "__CUSTOMER_ID__", cfg
    ));
    assert.equal(sent[2].headers["Square-Version"], cfg.version);
    assert.equal(sent[2].body.idempotency_key, "k1-order");
  });

  it("asks for catalog lines only when told there is a variation", () => {
    const sent = request("create-order", {
      ...args, kind: "catalog", variationId: "VAR1",
    });

    assert.deepEqual(sent[2].body.order.line_items, [
      { catalog_object_id: "VAR1", quantity: "2" },
    ]);
  });

  it("pays a $0 order with no payment ids", () => {
    const [sent] = request("pay-zero", { ...args, orderId: "O1" });

    assert.equal(sent.path, "/v2/orders/O1/pay");
    assert.deepEqual(sent.body.payment_ids, []);
  });

  it("never sends the access token on to a fixture", () => {
    const sent = request("create-payment", {
      ...args, orderId: "O1", customerId: "C1", amount: 100,
      source: { sourceId: "cnon:card-nonce-ok" },
    });

    assert.ok(!JSON.stringify(sent).includes("stub"));
    assert.ok(!("Authorization" in sent[0].headers));
  });
});
