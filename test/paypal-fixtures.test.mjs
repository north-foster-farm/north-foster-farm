// #708, last box: "scrubbed fixtures for the capture, the order read,
// the refund and both webhook events are in test/fixtures/paypal/".
// One test.
//
// The seam assumed: bin/fixtures/scrub's file shape (test/fixtures/
// README.md, "What a file holds"), found by what each recorded (method,
// path, status, event type), not by file name. "Both webhook events"
// means the PAYMENT.CAPTURE.COMPLETED and PAYMENT.CAPTURE.REFUNDED
// deliveries to /api/paypal/webhook, each with the verify call PayPal
// answered SUCCESS for that event. "Scrubbed" means the scrubber's own
// review list is empty for each, and no string anywhere under
// test/fixtures/paypal/, nor any file name, holds an email address
// outside example.com or something shaped like a PayPal id (17 letters
// and digits, or an EC- token). The test cannot know the payer's real
// values, and must never hold them; reading each file by eye before it
// is committed covers those.

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { scrubAll } from "../bin/fixtures/scrub";

const PAYPAL = fileURLToPath(new URL("./fixtures/paypal/", import.meta.url));

const files = () => readdirSync(PAYPAL).filter((f) => f.endsWith(".json"));
const recordings = () => files().map((file) => ({
  file, ...JSON.parse(readFileSync(join(PAYPAL, file), "utf8")),
}));

const ok = (status) => status >= 200 && status < 300;
const isHook = (type) => (r) => r.request.path === "/api/paypal/webhook"
  && r.request.body && r.request.body.event_type === type;

const KINDS = {
  capture: (r) => r.request.method === "POST"
    && /^\/v2\/checkout\/orders\/[^/]+\/capture$/.test(r.request.path)
    && ok(r.status) && r.response.status === "COMPLETED",
  "order read": (r) => r.request.method === "GET"
    && /^\/v2\/checkout\/orders\/[^/]+$/.test(r.request.path)
    && r.status === 200,
  refund: (r) => r.request.method === "POST"
    && /^\/v2\/payments\/captures\/[^/]+\/refund$/.test(r.request.path)
    && ok(r.status),
  "PAYMENT.CAPTURE.COMPLETED delivery": isHook("PAYMENT.CAPTURE.COMPLETED"),
  "PAYMENT.CAPTURE.REFUNDED delivery": isHook("PAYMENT.CAPTURE.REFUNDED"),
};

const verifies = (all, event) => all.find((r) => r.request.path
  === "/v1/notifications/verify-webhook-signature"
  && r.request.body && r.request.body.webhook_event
  && r.request.body.webhook_event.id === event.id
  && r.response.verification_status === "SUCCESS");

const strings = (node, out = []) => {
  if (Array.isArray(node)) node.forEach((item) => strings(item, out));
  else if (node && typeof node === "object") {
    Object.values(node).forEach((value) => strings(value, out));
  } else if (typeof node === "string") out.push(node);

  return out;
};

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// PayPal's order, capture, refund and payer ids: 17 letters and digits
// with at least one of each, standing alone (a placeholder's
// underscores break it up); and the EC- checkout token.
const PAYPAL_ID = new RegExp([
  "(?<![A-Za-z0-9])",
  "(?=[A-Za-z0-9]{0,16}\\d)(?=[A-Za-z0-9]{0,16}[A-Za-z])",
  "[A-Za-z0-9]{17}(?![A-Za-z0-9])|EC-[A-Za-z0-9]{6,}",
].join(""));

describe("#708: the scrubbed PayPal fixtures are recorded", () => {
  it("holds the capture, order read, refund and both webhook events, "
    + "scrubbed", () => {
    const all = recordings();
    // The older hand-posted refusal has no request; the id and email
    // checks below still read it.
    const exchanges = all.filter((r) => r.request);

    for (const [kind, is] of Object.entries(KINDS)) {
      const found = exchanges.find(is);

      assert.ok(found, `no recorded PayPal ${kind} in test/fixtures/paypal/`);
      assert.equal(found._source && found._source.service, "paypal", kind);
      assert.match(String(found._source.recorded), /^\d{4}-\d{2}-\d{2}$/,
        kind);
      if (kind.endsWith("delivery")) {
        assert.ok(verifies(exchanges, found.request.body),
          `no SUCCESS verify call recorded for the ${kind}`);
      }

      // Nothing the scrubber would still list for review.
      const [again] = scrubAll([{
        name: found.file.replace(/\.json$/, ""), service: "paypal",
        status: found.status, request: found.request,
        response: found.response, recorded: found._source.recorded,
      }]);

      assert.deepEqual(again.review, [], `${found.file}: left to review`);
    }

    for (const r of all) {
      for (const value of [r.file, ...strings(r)]) {
        for (const email of value.match(EMAIL) || []) {
          assert.match(email, /@example\.com$/,
            `${r.file}: an email address outside example.com`);
        }
        assert.doesNotMatch(value, PAYPAL_ID,
          `${r.file}: a string shaped like a PayPal id`);
      }
    }
  });
});
