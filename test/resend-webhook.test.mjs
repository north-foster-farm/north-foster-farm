/* eslint-disable camelcase -- Resend names contact fields its way */
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { describe, it } from "node:test";

import {
  SYNC_KEY, optIn, syncAudience,
} from "../netlify/functions/lib/news.mjs";
import {
  getCustomer, saveCustomer,
} from "../netlify/functions/lib/records.mjs";
import { testStores } from "../netlify/functions/lib/store.mjs";
import {
  TOLERANCE, applyEvent, handle, verifyWebhook,
} from "../netlify/functions/resend-webhook.mjs";

const KEY = Buffer.from("resend-test-signing-key").toString("base64");
const env = {
  RESEND_WEBHOOK_SECRET: `whsec_${KEY}`, RESEND_SEGMENT_ID: "aud",
};
const now = new Date("2026-10-01T12:00:00Z");
const later = new Date("2026-10-02T12:00:00Z");

const customer = (email, extra = {}) => ({
  email, name: "Pat Example", firstName: "Pat", lastName: "Example",
  phone: "", avatar: null, discountGroup: null, address: null,
  createdAt: "2026-09-01T00:00:00.000Z", lastOrderAt: null, ...extra,
});

const event = (type, data = {}) => ({
  type,
  created_at: "2026-10-01T11:59:00.000Z",
  data: {
    id: "c1", audience_id: "aud", segment_ids: ["aud"],
    created_at: "2026-09-01T00:00:00.000Z",
    updated_at: "2026-10-01T11:59:00.000Z",
    email: "pat@example.com", first_name: "Pat", last_name: "Example",
    unsubscribed: true,
    ...data,
  },
});

const sign = (body, { id = "msg_1", at = now, key = KEY } = {}) => {
  const timestamp = String(Math.floor(at.getTime() / 1000));
  const signature = createHmac("sha256", Buffer.from(key, "base64"))
    .update(`${id}.${timestamp}.${body}`).digest("base64");

  return {
    "svix-id": id,
    "svix-timestamp": timestamp,
    "svix-signature": `v1,${signature}`,
  };
};

const request = (body, headers) =>
  new Request("https://northfosterfarm.com/api/resend/webhook", {
    method: "POST", headers, body,
  });

describe("the Resend webhook's signature", () => {
  const body = JSON.stringify(event("contact.updated"));
  const check = (headers, opts = {}) =>
    verifyWebhook(new Headers(headers), body, { env, now, ...opts });

  it("accepts a signed delivery, among several signatures", () => {
    const headers = sign(body);

    assert.equal(check(headers), true);
    assert.equal(check({
      ...headers,
      "svix-signature": `v1,AAAA ${headers["svix-signature"]}`,
    }), true);
  });

  it("rejects a wrong key, a changed body, a stale or future time, " +
    "missing headers and a missing secret", () => {
    assert.equal(check(sign(body, {
      key: Buffer.from("another").toString("base64"),
    })), false);
    assert.equal(verifyWebhook(new Headers(sign(body)), `${body} `,
      { env, now }), false);
    assert.equal(check(sign(body, {
      at: new Date(now.getTime() - TOLERANCE - 1000),
    })), false);
    assert.equal(check(sign(body, {
      at: new Date(now.getTime() + TOLERANCE + 1000),
    })), false);
    assert.equal(check({ "svix-id": "msg_1" }), false);
    assert.equal(check(sign(body), { env: { RESEND_SEGMENT_ID: "aud" } }),
      false);
  });
});

describe("the Resend webhook", () => {
  it("answers 401 to a bad signature and changes nothing", async () => {
    const stores = testStores();
    const body = JSON.stringify(event("contact.updated"));

    await saveCustomer(stores, customer("pat@example.com", {
      marketing: true, marketingAt: "2026-09-01T00:00:00.000Z",
    }));

    const res = await handle(request(body, {
      ...sign(body), "svix-signature": "v1,AAAA",
    }), { stores, env, now });

    assert.equal(res.status, 401);
    assert.equal((await getCustomer(stores, "pat@example.com")).marketing,
      true);
  });

  it("opts the record out at once on an unsubscribe", async () => {
    const stores = testStores();
    const body = JSON.stringify(event("contact.updated"));

    await saveCustomer(stores, customer("pat@example.com", {
      marketing: true, marketingAt: "2026-09-01T00:00:00.000Z",
    }));

    const res = await handle(request(body, sign(body)), { stores, env, now });
    const record = await getCustomer(stores, "pat@example.com");

    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { handled: true, optedOut: true });
    assert.equal(record.marketing, false);
    assert.equal(record.marketingSource, "resend");
    assert.equal(record.resendLeftAt, "2026-10-01T11:59:00.000Z");
    assert.equal((await stores.jobs.get("health/webhook")).type,
      "contact.updated");
  });

  it("opts the record out when the contact is deleted", async () => {
    const stores = testStores();

    await saveCustomer(stores, customer("pat@example.com", {
      marketing: true, marketingAt: "2026-09-01T00:00:00.000Z",
    }));

    const r = await applyEvent(stores,
      event("contact.deleted", { unsubscribed: false }), { env, now });

    assert.deepEqual(r, { handled: true, optedOut: true });
    assert.equal((await getCustomer(stores, "pat@example.com")).marketing,
      false);
  });

  it("ignores other audiences, other changes and strangers, with a 200",
    async () => {
      const stores = testStores();

      await saveCustomer(stores, customer("pat@example.com", {
        marketing: true, marketingAt: "2026-09-01T00:00:00.000Z",
      }));

      const other = JSON.stringify(event("contact.updated", {
        audience_id: "production", segment_ids: ["production"],
      }));
      const res = await handle(request(other, sign(other)),
        { stores, env, now });

      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(),
        { handled: false, reason: "other audience" });
      assert.deepEqual(await applyEvent(stores,
        event("contact.updated", { unsubscribed: false }), { env, now }),
      { handled: false, reason: "ignored" });
      assert.deepEqual(await applyEvent(stores,
        event("contact.created"), { env, now }),
      { handled: false, reason: "ignored" });
      assert.deepEqual(await applyEvent(stores,
        event("contact.updated", { email: "who@example.com" }), { env, now }),
      { handled: false, reason: "unknown contact" });
      assert.equal((await getCustomer(stores, "pat@example.com")).marketing,
        true);
    });

  it("leaves a consent given here after the event (a late redelivery)",
    async () => {
      const stores = testStores();

      await saveCustomer(stores, customer("pat@example.com", {
        marketing: true, marketingAt: "2026-10-01T11:59:30.000Z",
      }));
      await applyEvent(stores, event("contact.updated"), { env, now });

      assert.equal((await getCustomer(stores, "pat@example.com")).marketing,
        true);
    });

  it("lets a sign-up here after the unsubscribe resubscribe at the sync",
    async () => {
      const stores = testStores();
      const calls = [];
      const fetchImpl = async (url, init) => {
        calls.push({ method: init.method, body: init.body
          ? JSON.parse(init.body) : null });

        return {
          ok: true,
          json: async () => (init.method === "GET"
            ? { data: [{ email: "pat@example.com", unsubscribed: true }] }
            : {}),
        };
      };

      await stores.jobs.set(SYNC_KEY, { at: "2026-09-30T05:00:00.000Z" });
      await saveCustomer(stores, customer("pat@example.com", {
        marketing: true, marketingAt: "2026-09-01T00:00:00.000Z",
      }));
      await applyEvent(stores, event("contact.updated"), { env, now });
      await optIn(stores, "pat@example.com", { source: "settings" }, later);

      const r = await syncAudience(stores, {
        env: { ...env, RESEND_API_KEY: "k" }, fetchImpl, now: later, pace: 0,
      });

      assert.deepEqual(r.resubscribed, ["pat@example.com"]);
      assert.deepEqual(calls[1].body, { unsubscribed: false });
    });
});
