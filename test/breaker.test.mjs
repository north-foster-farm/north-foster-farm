/* eslint-disable camelcase -- Resend names its fields its way */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  STATE, UNSENT, counts, declare, flush, guard, incidentReport, onFeedback,
  onSent, reset, status,
} from "../netlify/functions/lib/breaker.mjs";
import { sendMail } from "../netlify/functions/lib/mail.mjs";
import { testStores } from "../netlify/functions/lib/store.mjs";
import { handle } from "../netlify/functions/resend-webhook.mjs";

const env = {
  MAIL_DRIVER: "resend",
  MAIL_FROM: "North Foster Farm <orders@example.com>",
  RESEND_API_KEY: "re_sending_secret",
  RESEND_AUDIENCE_KEY: "re_full_secret",
  RESEND_SENDING_KEY_NAME: "Sending",
  HEALTHCHECKS_ALERT_URL: "https://hc.example/alert",
  SITE_CONTEXT: "production",
};
const now = new Date("2026-10-20T14:30:00Z");
const noWait = async () => {};

const message = (n = 1, extra = {}) => ({
  to: Array.from({ length: n }, (_, i) => `pat${i}@example.com`),
  subject: "Hi",
  text: "hello",
  ...extra,
});

// A Resend and a Healthchecks that answer and remember what was asked.
// Real keys are never involved: every call lands here.
const world = () => {
  const calls = [];
  let counter = 0;
  const keys = [
    { id: "k_audience", name: "Audience" },
    { id: "k_sending", name: "Sending" },
  ];

  return {
    calls,
    keys,
    fetchImpl: async (url, init = {}) => {
      const method = init.method || "GET";

      calls.push({ url: String(url), method, auth: init.headers });

      if (url === "https://api.resend.com/emails") {
        counter += 1;

        return Response.json({ id: `msg_${counter}` });
      }
      if (url.startsWith("https://api.resend.com/api-keys?")) {
        return Response.json({ data: keys, has_more: false });
      }
      if (method === "DELETE") {
        const id = String(url).split("/").pop();
        const at = keys.findIndex((k) => k.id === id);

        if (at >= 0) keys.splice(at, 1);

        return Response.json({});
      }

      return new Response("OK", { status: 200 });
    },
  };
};

const sent = (id) => ({ type: "email.sent", data: { email_id: id } });

describe("the send breaker: our own sends", () => {
  it("sends, records the id and counts the recipient", async () => {
    const stores = testStores();
    const { fetchImpl } = world();
    const r = await sendMail(message(2), { env, fetchImpl, stores });

    assert.equal(r.id, "msg_1");
    assert.deepEqual(await counts(stores, new Date()), { hour: 2, day: 2 });
    assert.ok(await stores.jobs.get("breaker/ledger/msg_1"));
  });

  it("does not trip on a send it recorded", async () => {
    const stores = testStores();
    const { fetchImpl, calls } = world();
    const r = await sendMail(message(), { env, fetchImpl, stores });
    const result = await onSent(stores, sent(r.id), {
      env, fetchImpl, wait: noWait,
    });

    assert.equal(result.matched, true);
    assert.equal(await stores.jobs.get(STATE), null);
    assert.equal(calls.filter((c) => c.method === "DELETE").length, 0);
  });
});

describe("the send breaker: a foreign send", () => {
  it("trips at once, deletes the sending key, alerts without Resend",
    async () => {
      const stores = testStores();
      const w = world();
      const result = await onSent(stores, sent("msg_not_ours"), {
        env, now, fetchImpl: w.fetchImpl, wait: noWait,
      });

      assert.equal(result.tripped, true);

      const state = await stores.jobs.get(STATE);

      assert.equal(state.reason, "foreign");
      assert.deepEqual(state.key, { done: true, deleted: 1 });
      assert.equal(state.alerted, true);
      assert.deepEqual(w.keys.map((k) => k.id), ["k_audience"]);

      // The deletion used the full-access key, never the sending one.
      const del = w.calls.find((c) => c.method === "DELETE");

      assert.equal(del.auth.Authorization, "Bearer re_full_secret");

      // The alert: Healthchecks' /fail, then the re-arm. No email.
      const alerts = w.calls.filter((c) => c.url.startsWith("https://hc."));

      assert.deepEqual(alerts.map((c) => c.url), [
        "https://hc.example/alert/fail", "https://hc.example/alert",
      ]);
      assert.equal(w.calls.some((c) => c.url.endsWith("/emails")), false);
    });

  it("waits for the ledger before calling a send foreign", async () => {
    const stores = testStores();
    const { fetchImpl } = world();
    let waits = 0;

    const result = await onSent(stores, sent("msg_late"), {
      env, now, fetchImpl,
      wait: async () => {
        waits += 1;
        if (waits === 1) {
          await stores.jobs.set("breaker/ledger/msg_late", {
            at: now.toISOString(),
          });
        }
      },
    });

    assert.equal(result.matched, true);
    assert.equal(await stores.jobs.get(STATE), null);
  });

  it("stops our code: later mail is refused and held, not sent", async () => {
    const stores = testStores();
    const w = world();

    await onSent(stores, sent("msg_x"), {
      env, now, fetchImpl: w.fetchImpl, wait: noWait,
    });
    w.calls.length = 0;

    await assert.rejects(
      sendMail(message(1, { idempotencyKey: "order-1" }), {
        env, fetchImpl: w.fetchImpl, stores,
      }),
      { name: "MailError", retryable: false },
    );
    assert.equal(w.calls.length, 0);
    assert.equal((await stores.jobs.list(UNSENT)).length, 1);
  });

  it("reports a key it cannot delete, and still stops", async () => {
    const stores = testStores();
    const w = world();
    const bare = { ...env, RESEND_SENDING_KEY_NAME: "" };

    await onSent(stores, sent("msg_x"), {
      env: bare, now, fetchImpl: w.fetchImpl, wait: noWait,
    });

    const state = await stores.jobs.get(STATE);

    assert.equal(state.key.done, false);
    assert.match(state.key.why, /RESEND_SENDING_KEY_NAME/);
    assert.equal(state.alerted, true);
  });
});

describe("the send breaker: volume", () => {
  it("trips when the hour's ceiling is passed, and holds the mail",
    async () => {
      const stores = testStores();
      const w = world();

      for (let i = 0; i < 25; i++) {
        await sendMail(message(), {
          env, fetchImpl: w.fetchImpl, stores,
        });
      }
      assert.equal(await stores.jobs.get(STATE), null);

      await assert.rejects(
        sendMail(message(), { env, fetchImpl: w.fetchImpl, stores }),
        /breaker: volume/,
      );

      const state = await stores.jobs.get(STATE);

      assert.equal(state.reason, "volume");
      assert.equal(state.detail.window, "hour");
      assert.equal((await stores.jobs.list(UNSENT)).length, 1);
      assert.equal(w.keys.some((k) => k.id === "k_sending"), false);
    });

  it("checks a message's whole recipient list against the ceiling",
    async () => {
      const stores = testStores();
      const { fetchImpl } = world();
      const r = await guard(stores, message(26), { env, now, fetchImpl });

      assert.deepEqual(r, { allowed: false, reason: "volume" });
    });

  it("does not trip on a declared bulk send, for its window only",
    async () => {
      const stores = testStores();
      const { fetchImpl } = world();

      await declare(stores, { count: 90, hours: 3, note: "launch", now });

      const during = await guard(stores, message(90), {
        env, now, fetchImpl,
      });

      assert.deepEqual(during, { allowed: true });
      assert.equal(await stores.jobs.get(STATE), null);

      // Past the window the ceiling is the normal one again.
      const later = new Date(now.getTime() + 4 * 3600 * 1000);
      const after = await guard(testStores(), message(90), {
        env, now: later, fetchImpl,
      });

      assert.equal(after.allowed, false);
    });

  it("still trips on a bulk send bigger than declared", async () => {
    const stores = testStores();
    const { fetchImpl } = world();

    await declare(stores, { count: 40, hours: 3, now });

    const r = await guard(stores, message(90), { env, now, fetchImpl });

    assert.equal(r.allowed, false);
  });

  it("rejects a declaration with no count", async () => {
    await assert.rejects(declare(testStores(), { count: 0 }), /how many/);
  });
});

describe("the send breaker: reputation", () => {
  const bounce = (id) => ({
    type: "email.bounced", data: { email_id: id },
  });

  it("trips when bounces pass the rate over enough sends", async () => {
    const stores = testStores();
    const w = world();

    for (let i = 0; i < 12; i++) {
      await guard(stores, message(), { env, now, fetchImpl: w.fetchImpl });
    }
    await onFeedback(stores, bounce("a"), { env, now, fetchImpl: w.fetchImpl });
    await onFeedback(stores, bounce("b"), { env, now, fetchImpl: w.fetchImpl });
    assert.equal(await stores.jobs.get(STATE), null);

    const r = await onFeedback(stores, bounce("c"), {
      env, now, fetchImpl: w.fetchImpl,
    });

    assert.equal(r.tripped, true);
    assert.equal((await stores.jobs.get(STATE)).reason, "bounces");
  });

  it("counts a redelivered bounce once", async () => {
    const stores = testStores();
    const { fetchImpl } = world();

    for (let i = 0; i < 3; i++) {
      await onFeedback(stores, bounce("same"), { env, now, fetchImpl });
    }
    assert.equal((await status(stores, now)).reputation.bounced, 1);
  });

  it("ignores a few bounces among few sends", async () => {
    const stores = testStores();
    const { fetchImpl } = world();

    await guard(stores, message(), { env, now, fetchImpl });
    for (const id of ["a", "b", "c"]) {
      await onFeedback(stores, bounce(id), { env, now, fetchImpl });
    }
    assert.equal(await stores.jobs.get(STATE), null);
  });

  it("trips on two complaints", async () => {
    const stores = testStores();
    const { fetchImpl } = world();

    for (const id of ["a", "b"]) {
      await onFeedback(stores, {
        type: "email.complained", data: { email_id: id },
      }, { env, now, fetchImpl });
    }
    assert.equal((await stores.jobs.get(STATE)).reason, "complaints");
  });
});

describe("the send breaker: reset and flush", () => {
  it("stays tripped until reset, then sends the held mail", async () => {
    const stores = testStores();
    const w = world();

    await onSent(stores, sent("msg_x"), {
      env, now: new Date(), fetchImpl: w.fetchImpl, wait: noWait,
    });
    await assert.rejects(sendMail(message(1, { idempotencyKey: "o-1" }), {
      env, fetchImpl: w.fetchImpl, stores,
    }));
    await assert.rejects(flush(stores, async () => {}), /still tripped/);

    const r = await reset(stores);

    assert.equal(r.state.reason, "foreign");
    assert.equal(r.unsent, 1);

    const out = await flush(stores, (m) => sendMail(m, {
      env, fetchImpl: w.fetchImpl, stores,
    }));

    assert.equal(out.sent, 1);
    assert.equal((await stores.jobs.list(UNSENT)).length, 0);
  });

  it("does not trip again on the sends that caused it", async () => {
    const stores = testStores();
    const { fetchImpl } = world();
    const t = new Date();

    for (let i = 0; i < 25; i++) {
      await guard(stores, message(), { env, now: t, fetchImpl });
    }
    assert.equal((await guard(stores, message(), {
      env, now: t, fetchImpl,
    })).allowed, false);

    await reset(stores, { now: new Date(t.getTime() + 1000) });

    const later = new Date(t.getTime() + 2000);

    assert.equal((await guard(stores, message(), {
      env, now: later, fetchImpl,
    })).allowed, true);
  });

  it("leaves held mail older than the limit unsent", async () => {
    const stores = testStores();
    const old = new Date(now.getTime() - 100 * 3600 * 1000);

    await stores.jobs.set(`${UNSENT}old`, {
      at: old.toISOString(), message: message(),
    });

    const out = await flush(stores, async () => {
      throw new Error("must not send");
    }, { now });

    assert.equal(out.stale, 1);
    assert.equal(out.sent, 0);
  });

  it("writes the incident up for incidents/", () => {
    const text = incidentReport({
      at: "2026-10-20T14:30:00.000Z", reason: "foreign", detail: {},
      key: { done: true, deleted: 1 }, alerted: true,
    }, { now });

    assert.match(text, /Reason: foreign/);
    assert.match(text, /Sending key: deleted/);
  });
});

describe("the webhook carries the events to the breaker", () => {
  const request = (event) => new Request("https://x.example/api/resend/webhook", {
    method: "POST", body: JSON.stringify(event),
  });

  it("trips on a foreign email.sent", async () => {
    const stores = testStores();
    const w = world();
    const res = await handle(request({ type: "email.sent",
      data: { email_id: "msg_stranger" } }), {
      stores, env, now, check: () => null, fetchImpl: w.fetchImpl,
      wait: noWait,
    });

    assert.equal(res.status, 200);
    assert.equal((await stores.jobs.get(STATE)).reason, "foreign");
  });

  it("is quiet for a send it knows", async () => {
    const stores = testStores();
    const { fetchImpl } = world();
    const r = await sendMail(message(), { env, fetchImpl, stores });
    const res = await handle(request(sent(r.id)), {
      stores, env, now, check: () => null, fetchImpl, wait: noWait,
    });

    assert.equal((await res.json()).matched, true);
    assert.equal(await stores.jobs.get(STATE), null);
  });
});
