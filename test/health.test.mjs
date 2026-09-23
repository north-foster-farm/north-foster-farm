import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  alert, count, mark, noteMail, ping, readCount, readMark,
} from "../netlify/functions/lib/health.mjs";
import { recordRun } from "../netlify/functions/lib/jobs.mjs";
import {
  configured, flush, log, pending,
} from "../netlify/functions/lib/log.mjs";
import { testStores } from "../netlify/functions/lib/store.mjs";
import { handle, snapshot } from "../netlify/functions/health.mjs";

const now = new Date("2026-10-06T13:00:00Z");
const later = (minutes) => new Date(now.getTime() + minutes * 60_000);

const mailbox = () => {
  const sent = [];

  return {
    sent,
    mail: async (m) => {
      sent.push(m);

      return { id: `m${sent.length}`, driver: "test" };
    },
  };
};

// A fetch that records what it was asked and answers as told.
const fakeFetch = (status = 200) => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, method: init.method || "GET", body: init.body });

    return { ok: status < 400, status, json: async () => ({}) };
  };

  return { calls, fetchImpl };
};

// A report as runJobs builds one (lib/jobs.mjs); recordRun summarises
// it into the ledger.
const run = (at, errors = [], invariants = []) => ({
  at: at.toISOString(), deliveryReminded: [], closed: [], squareSynced: [],
  muted: [], checkoutsSwept: 0, pickupsToConfirm: [], tomorrow: null,
  errors, invariants,
});

describe("the log seam", () => {
  it("writes a line and buffers it, and ships only when configured",
    async () => {
      const before = pending();

      log.info({ event: "test.event", id: "A" });
      assert.equal(pending(), before + 1);
      assert.equal(configured({}), false);
      assert.equal(await flush({ env: {} }), 0, "nothing configured");
      assert.equal(pending(), 0, "the buffer is emptied all the same");

      log.error({ event: "test.error" });
      log.warn("plain text");
      const { calls, fetchImpl } = fakeFetch();
      const shipped = await flush({
        env: { AXIOM_TOKEN: "t", AXIOM_DATASET: "nff-site", DEPLOY_ID: "d1" },
        fetchImpl,
      });

      assert.equal(shipped, 2);
      assert.equal(calls.length, 1);
      assert.match(calls[0].url, /datasets\/nff-site\/ingest$/);
      const body = JSON.parse(calls[0].body);

      assert.equal(body[0].event, "test.error");
      assert.equal(body[0].level, "error");
      assert.equal(body[0].deploy, "d1");
      assert.equal(body[1].message, "plain text");
      assert.ok(body[0]._time);
    });

  it("swallows a refusal and a network error", async () => {
    log.info({ event: "x" });
    assert.equal(await flush({
      env: { AXIOM_TOKEN: "t", AXIOM_DATASET: "d" }, fetchImpl: fakeFetch(500)
        .fetchImpl,
    }), 0);
    log.info({ event: "y" });
    assert.equal(await flush({
      env: { AXIOM_TOKEN: "t", AXIOM_DATASET: "d" },
      fetchImpl: async () => { throw new Error("offline"); },
    }), 0);
  });
});

describe("marks and heartbeats", () => {
  it("records a mark and reads it back; a broken store does not throw",
    async () => {
      const stores = testStores();

      await mark(stores, "webhook", { type: "refund.updated" }, now);
      assert.deepEqual(await readMark(stores, "webhook"),
        { at: now.toISOString(), type: "refund.updated" });

      const broken = { jobs: { set: async () => { throw new Error("no"); },
        get: async () => { throw new Error("no"); } } };

      assert.ok(await mark(broken, "x", {}, now));
      assert.equal(await readMark(broken, "x"), null);
    });

  it("tallies a thing per day and reads the tally back", async () => {
    const stores = testStores();
    const monday = new Date("2026-10-05T23:30:00Z"); // 19:30 Sunday, ET.

    assert.equal(await readCount(stores, "declined", "2026-10-06"), 0);
    await count(stores, "declined", now);
    await count(stores, "declined", later(30));
    await count(stores, "declined", monday);
    assert.equal(await readCount(stores, "declined", "2026-10-06"), 2);
    assert.equal(await readCount(stores, "declined", "2026-10-05"), 1,
      "the day is New York's, not UTC's");
    assert.equal(await readCount(stores, "other", "2026-10-06"), 0);
    assert.equal((await stores.jobs.get("health/declined/2026-10-06")).at,
      later(30).toISOString());

    const broken = { jobs: { set: async () => { throw new Error("no"); },
      get: async () => { throw new Error("no"); } } };

    await count(broken, "declined", now);
    assert.equal(await readCount(broken, "declined", "2026-10-06"), 0);
  });

  it("keeps a rolling hour of mail failures beside the last success",
    async () => {
      const stores = testStores();

      await noteMail(stores, false, now, { error: "Resend 500" });
      await noteMail(stores, false, later(15));
      await noteMail(stores, true, later(20));
      await noteMail(stores, false, later(70));
      const m = await readMark(stores, "mail");

      assert.equal(m.lastOkAt, later(20).toISOString());
      assert.equal(m.lastFailAt, later(70).toISOString());
      assert.deepEqual(m.fails, [later(15).toISOString(),
        later(70).toISOString()], "the first is over an hour old");
      assert.equal(m.days["2026-10-06"], 3);
    });

  it("pings well with a GET and badly with a POST to /fail", async () => {
    const ok = fakeFetch();

    assert.equal(await ping("https://hc/abc", { fetchImpl: ok.fetchImpl }),
      true);
    assert.deepEqual(ok.calls[0], { url: "https://hc/abc", method: "GET",
      body: undefined });

    const bad = fakeFetch();

    await ping("https://hc/abc/", {
      ok: false, body: { errors: 2 }, fetchImpl: bad.fetchImpl,
    });
    assert.equal(bad.calls[0].url, "https://hc/abc/fail");
    assert.equal(bad.calls[0].method, "POST");
    assert.equal(JSON.parse(bad.calls[0].body).errors, 2);

    assert.equal(await ping("", { fetchImpl: ok.fetchImpl }), false);
    assert.equal(await ping("https://hc/x", {
      fetchImpl: async () => { throw new Error("offline"); },
    }), false);
  });
});

describe("alerts", () => {
  it("emails the farm once per kind per hour and hits the alert check",
    async () => {
      const stores = testStores();
      const { sent, mail } = mailbox();
      const { calls, fetchImpl } = fakeFetch();
      const env = {
        ADMIN_EMAILS: "farm@x.com", HEALTHCHECKS_ALERT_URL: "https://hc/a",
      };

      assert.equal(await alert(stores, "mail.failed", {
        id: "NFF-1", error: "Resend 500",
      }, { env, mail, now, fetchImpl }), "sent");
      assert.equal(sent.length, 1);
      assert.deepEqual(sent[0].to, ["farm@x.com"]);
      assert.equal(sent[0].subject, "Site alert: mail.failed");
      assert.match(sent[0].text, /NFF-1/);
      assert.match(sent[0].text, /Resend 500/);
      assert.match(sent[0].text, /docs\/monitoring\.md/);
      assert.equal(calls[0].url, "https://hc/a/fail");
      assert.equal(JSON.parse(calls[0].body).kind, "mail.failed");

      assert.equal(await alert(stores, "mail.failed", { id: "NFF-2" }, {
        env, mail, now: later(30), fetchImpl,
      }), "muted");
      assert.equal(sent.length, 1, "held for an hour");
      assert.equal((await readMark(stores, "alert/mail.failed")).muted, 1);

      assert.equal(await alert(stores, "jobs.errors", {}, {
        env, mail, now: later(30), fetchImpl,
      }), "sent", "another kind is its own clock");
      assert.equal(await alert(stores, "mail.failed", {}, {
        env, mail, now: later(61), fetchImpl,
      }), "sent");
      assert.equal(sent.length, 3);
    });

  it("is skipped, not thrown, when nobody is listed or mail fails",
    async () => {
      const stores = testStores();

      assert.equal(await alert(stores, "x", {}, {
        env: {}, mail: async () => {}, now, fetchImpl: fakeFetch().fetchImpl,
      }), "skipped");
      assert.equal(await alert(stores, "y", {}, {
        env: { ADMIN_EMAILS: "a@b" },
        mail: async () => { throw new Error("down"); },
        now, fetchImpl: fakeFetch().fetchImpl,
      }), "skipped");
    });
});

describe("GET /api/health", () => {
  it("is 200 with the picture when the run is fresh and mail is fine",
    async () => {
      const stores = testStores();

      await recordRun(stores, run(later(-10)), later(-10));
      await mark(stores, "webhook", {}, later(-5));
      await mark(stores, "paid", { id: "A" }, later(-5));
      await noteMail(stores, true, later(-3));
      const res = await handle(new Request("https://x/api/health"), {
        stores, env: { MAIL_DRIVER: "resend" }, now,
      });
      const s = await res.json();

      assert.equal(res.status, 200, JSON.stringify(s));
      assert.equal(s.ok, true);
      assert.deepEqual(s.problems, []);
      assert.equal(s.jobs.minutesAgo, 10);
      assert.equal(s.jobs.runsLastDay, 1);
      assert.equal(s.jobs.errorsLastRun, 0);
      assert.equal(s.jobs.invariantsLastRun, 0);
      assert.equal(s.mail.driver, "resend");
      assert.equal(s.mail.failuresLastHour, 0);
      assert.equal(s.webhook.lastAt, later(-5).toISOString());
      assert.equal(s.orders.lastPaidAt, later(-5).toISOString());
      assert.equal(s.log, false);
    });

  it("is 503 for a stale run, a run with errors, or repeated mail " +
    "failures", async () => {
    const stores = testStores();
    const none = await snapshot(stores, { env: {}, now });

    assert.equal(none.ok, false);
    assert.match(none.problems[0], /no jobs run/);

    await recordRun(stores, run(later(-50)), later(-50));
    const stale = await snapshot(stores, { env: {}, now });

    assert.match(stale.problems[0], /50 minutes ago/);

    await recordRun(stores, run(later(-5), [{ id: "A", error: "boom" }]),
      later(-5));
    const errored = await snapshot(stores, { env: {}, now });

    assert.match(errored.problems[0], /1 error/);

    const fresh = testStores();

    await recordRun(fresh, run(later(-5)), later(-5));
    for (const m of [-30, -20, -10]) await noteMail(fresh, false, later(m));
    const mailDown = await snapshot(fresh, { env: {}, now });

    assert.equal(mailDown.ok, false);
    assert.match(mailDown.problems[0], /3 mail failures/);

    await noteMail(fresh, true, later(-1));
    assert.equal((await snapshot(fresh, { env: {}, now })).ok, true,
      "a success since clears it");
  });
});

describe("POST /api/health, the checkout beacon", () => {
  const post = (body) => new Request("https://x/api/health", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  it("turns a checkout failure into an alert", async () => {
    const stores = testStores();
    const { sent, mail } = mailbox();
    const res = await handle(post({
      kind: "checkout.failed", message: "We couldn't reach our payment " +
        "system after several tries.", method: "delivery", page: "/order/",
    }), {
      stores, env: { ADMIN_EMAILS: "farm@x.com" }, now, mail,
      fetchImpl: fakeFetch().fetchImpl,
    });

    assert.equal(res.status, 202);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].subject, "Site alert: client.checkout_failed");
    assert.match(sent[0].text, /several tries/);
    assert.match(sent[0].text, /delivery/);
  });

  it("refuses an unknown beacon and caps a chatty address", async () => {
    const stores = testStores();
    const { sent, mail } = mailbox();

    assert.equal((await handle(post({ kind: "anything" }), {
      stores, env: {}, now, mail,
    })).status, 400);
    for (let i = 0; i < 12; i += 1) {
      await handle(post({ kind: "checkout.failed" }), {
        stores, env: { ADMIN_EMAILS: "farm@x.com" }, now, mail, ip: "1.2.3.4",
        fetchImpl: fakeFetch().fetchImpl,
      });
    }
    assert.equal(sent.length, 1, "one alert an hour, however many beacons");
  });
});
