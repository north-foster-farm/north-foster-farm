// #708, last box: the fake's webhook deliveries "answer with those
// shapes": both recorded events, PAYMENT.CAPTURE.COMPLETED and
// PAYMENT.CAPTURE.REFUNDED. One test.
//
// The seam assumed (none exists today; every test that delivers a
// PayPal event builds the body by hand): lib/fake-paypal.mjs exports
//
//   webhookDelivery(eventType, {
//     orderId, paypalOrderId, paypalCaptureId, paypalRefundId, amount,
//   }) -> { headers, body }
//
// `headers` a plain object of the delivery's headers, `body` the event
// as the JSON string PayPal posts. It is the recorded delivery (the
// fixture whose request.path is /api/paypal/webhook) with the given
// values put in where netlify/functions/paypal-webhook.mjs reads them:
// the order id in custom_id, the PayPal order in related_ids.order_id,
// the capture as the completed event's resource and as the refund's
// "up" link, the refund as the refunded event's resource, and the
// amount (cents) as resource.amount.value. Everything else is the
// recording's: the same keys, nesting and header names, and its values
// where the fake has no reason to differ (an amount breakdown may be
// any money string).

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import * as fakePayPal from "../netlify/functions/lib/fake-paypal.mjs";
import { differences } from "./recorded.mjs";

const PAYPAL = fileURLToPath(new URL("./fixtures/paypal/", import.meta.url));

const deliveries = () => readdirSync(PAYPAL)
  .filter((f) => f.endsWith(".json"))
  .map((f) => JSON.parse(readFileSync(join(PAYPAL, f), "utf8")))
  .filter((r) => r.request && r.request.path === "/api/paypal/webhook");

const deliveryOf = (type) => {
  const found = deliveries()
    .find((r) => r.request.body && r.request.body.event_type === type);

  assert.ok(found, `no recorded ${type} delivery in test/fixtures/paypal/`);

  return found;
};

const PUT = {
  orderId: "NFF-2611-CRIT",
  paypalOrderId: "FAKE-PP-700-CRIT",
  paypalCaptureId: "FAKE-CAPTURE-CRIT",
  paypalRefundId: "FAKE-PP-REFUND-CRIT",
  amount: 700,
};

const shapeOf = (node) => {
  if (Array.isArray(node)) return node.map(shapeOf);
  if (node && typeof node === "object") {
    return Object.fromEntries(Object.entries(node)
      .map(([key, value]) => [key, shapeOf(value)]));
  }

  return node === null ? "null" : typeof node;
};

const MONEY = /^\d+\.\d{2}$/;

// The value at a path as differences() writes one: .resource.links[0].
const leafAt = (node, at) => [...at.matchAll(/\.([^.[]+)|\[(\d+)\]/g)]
  .reduce((here, [, key, i]) => here && here[key ?? Number(i)], node);
const lower = (headers) => Object.keys(headers)
  .map((name) => name.toLowerCase()).sort();

describe("#708: the fake's webhook deliveries match the recorded events",
  () => {
    it("delivers both recorded events, with ours put in", () => {
      assert.equal(typeof fakePayPal.webhookDelivery, "function",
        "fake-paypal.mjs exports no webhookDelivery");

      for (const type of [
        "PAYMENT.CAPTURE.COMPLETED", "PAYMENT.CAPTURE.REFUNDED",
      ]) {
        const recording = deliveryOf(type);
        const want = recording.request.body;
        const { headers, body } = fakePayPal.webhookDelivery(type, PUT);
        const got = JSON.parse(body);

        assert.deepEqual(shapeOf(got), shapeOf(want), type);
        assert.deepEqual(lower(headers), lower(recording.request.headers),
          type);
        // Placeholders and times match any string; a money value is
        // the fake's to set.
        const departs = differences(want, got).filter((line) => {
          const at = line.slice(0, line.indexOf(":"));

          return !(at.endsWith(".value") && MONEY.test(String(leafAt(got,
            at))));
        });

        assert.deepEqual(departs, [], type);

        const resource = got.resource;

        assert.equal(resource.custom_id, PUT.orderId, type);
        assert.equal(resource.amount.value, "7.00", type);
        if (type === "PAYMENT.CAPTURE.COMPLETED") {
          assert.equal(resource.id, PUT.paypalCaptureId);
          assert.equal(resource.supplementary_data.related_ids.order_id,
            PUT.paypalOrderId);
        } else {
          assert.equal(resource.id, PUT.paypalRefundId);
          const up = (resource.links || []).find((l) => l.rel === "up");

          assert.ok(up, "the refund names no capture in an up link");
          assert.match(up.href,
            new RegExp(`/captures/${PUT.paypalCaptureId}$`));
        }
      }
    });
  });
