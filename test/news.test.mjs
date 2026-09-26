/* eslint-disable camelcase -- Resend names contact fields its way */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  CONFIRM_TTL, REQUESTS_PER_WINDOW, SYNC_KEY, confirmSubscribe,
  inviteSubscribers, optIn, optOut, parseCsv, requestSubscribe,
  syncAudience,
} from "../netlify/functions/lib/news.mjs";
import {
  getCustomer, saveCustomer,
} from "../netlify/functions/lib/records.mjs";
import { testStores } from "../netlify/functions/lib/store.mjs";
import { newsConfirm } from "../netlify/functions/lib/templates.mjs";
import { handle } from "../netlify/functions/news.mjs";

const now = new Date("2026-10-01T12:00:00Z");
const later = new Date("2026-10-02T12:00:00Z");
const env = { SITE_URL: "https://northfosterfarm.com" };
const mailbox = () => {
  const sent = [];

  return {
    sent,
    mail: async (m) => {
      sent.push(m);

      return { id: "m1", driver: "test" };
    },
  };
};
const tokenIn = (url) => new URL(url).searchParams.get("token");
const customer = (email, extra = {}) => ({
  email, name: "Pat Example", firstName: "Pat", lastName: "Example",
  phone: "", avatar: null, discountGroup: null, address: null,
  createdAt: "2026-09-01T00:00:00.000Z", lastOrderAt: null, ...extra,
});

describe("the confirmation request", () => {
  it("mails a single-use link to a normalised address", async () => {
    const stores = testStores();
    const { sent, mail } = mailbox();
    const r = await requestSubscribe(stores, {
      email: " Pat@Example.COM ", firstName: "Pat",
    }, { now, env, mail });

    assert.equal(r.ok, true);
    assert.equal(r.email, "pat@example.com");
    assert.match(r.url,
      /^https:\/\/northfosterfarm.com\/api\/news\/confirm\?token=/);
    assert.equal(sent[0].to, "pat@example.com");
    assert.equal(sent[0].subject,
      "Confirm your email for North Foster Farm news and updates");
    assert.match(sent[0].text, /^Click the button below/m);
    assert.match(sent[0].text, /7 days/);
    assert.match(sent[0].text, new RegExp(tokenIn(r.url)));
    assert.equal(await getCustomer(stores, "pat@example.com"), null,
      "nothing on the record until the click");
  });

  it("refuses a bad address and rate-limits an eager one", async () => {
    const stores = testStores();
    const { mail } = mailbox();

    assert.equal((await requestSubscribe(stores, { email: "nope" },
      { now, env, mail })).reason, "invalid");
    for (let i = 0; i < REQUESTS_PER_WINDOW; i += 1) {
      assert.equal((await requestSubscribe(stores, { email: "a@b.co" },
        { now, env, mail })).ok, true, `request ${i + 1}`);
    }
    assert.equal((await requestSubscribe(stores, { email: "a@b.co" },
      { now, env, mail })).reason, "rate");
  });
});

describe("the click", () => {
  it("creates a consenting record for an address with none", async () => {
    const stores = testStores();
    const { mail } = mailbox();
    const r = await requestSubscribe(stores, {
      email: "new@example.com", firstName: "Sam", lastName: "New",
    }, { now, env, mail });
    const c = await confirmSubscribe(stores, tokenIn(r.url), { now: later });

    assert.equal(c.ok, true);
    assert.equal(c.email, "new@example.com");

    const saved = await getCustomer(stores, "new@example.com");

    assert.equal(saved.marketing, true);
    assert.equal(saved.marketingAt, later.toISOString());
    assert.equal(saved.marketingSource, "confirm");
    assert.equal(saved.name, "Sam New");
    assert.equal(saved.lastOrderAt, null, "never ordered");

    const again = await confirmSubscribe(stores, tokenIn(r.url),
      { now: later });

    assert.equal(again.reason, "unknown", "single use");
  });

  it("opts an existing record in without touching its name", async () => {
    const stores = testStores();
    const { mail } = mailbox();

    await saveCustomer(stores, customer("pat@example.com"));

    const r = await requestSubscribe(stores, {
      email: "pat@example.com", firstName: "Patricia",
    }, { now, env, mail });

    await confirmSubscribe(stores, tokenIn(r.url), { now: later });

    const saved = await getCustomer(stores, "pat@example.com");

    assert.equal(saved.marketing, true);
    assert.equal(saved.firstName, "Pat", "the record's own name stays");
    assert.equal(saved.createdAt, "2026-09-01T00:00:00.000Z");
  });

  it("refuses an expired or unknown link", async () => {
    const stores = testStores();
    const { mail } = mailbox();
    const r = await requestSubscribe(stores, { email: "a@b.co" },
      { now, env, mail });
    const tooLate = new Date(now.getTime() + CONFIRM_TTL + 1);

    assert.equal((await confirmSubscribe(stores, tokenIn(r.url),
      { now: tooLate })).reason, "expired");
    assert.equal((await confirmSubscribe(stores, "nope", { now })).reason,
      "unknown");
    assert.equal((await confirmSubscribe(stores, "", { now })).reason,
      "invalid");
  });
});

describe("consent on the record", () => {
  it("is dated on the way in and out, and never repeated", async () => {
    const stores = testStores();

    await saveCustomer(stores, customer("pat@example.com"));

    const yes = await optIn(stores, "pat@example.com", {}, now);

    assert.equal(yes.marketing, true);
    assert.equal(yes.marketingAt, now.toISOString());

    const still = await optIn(stores, "pat@example.com", {}, later);

    assert.equal(still.marketingAt, now.toISOString(), "untouched");

    const no = await optOut(stores, "pat@example.com", { source: "resend" },
      later);

    assert.equal(no.marketing, false);
    assert.equal(no.marketingAt, later.toISOString());
    assert.equal(no.marketingSource, "resend");
    assert.equal(await optOut(stores, "nobody@example.com", {}, later), null);
  });
});

describe("the invitation of an old list", () => {
  it("mails each address not already in, once, and reports the rest",
    async () => {
      const stores = testStores();
      const { sent, mail } = mailbox();

      await saveCustomer(stores, customer("in@example.com", {
        marketing: true, marketingAt: now.toISOString(),
      }));

      const report = await inviteSubscribers(stores, [
        { email: "In@Example.com" },
        { email: "new@example.com", firstName: "Sam" },
        { email: "not an address" },
      ], { now, env, mail });

      assert.deepEqual(report, {
        invited: ["new@example.com"],
        skipped: ["in@example.com"],
        invalid: ["not an address"],
      });
      assert.equal(sent.length, 1);
      assert.equal(sent[0].to, "new@example.com");
      assert.match(sent[0].text, /news and updates from North Foster/);

      const dry = await inviteSubscribers(stores, [{ email: "x@y.co" }],
        { now, env, mail, dryRun: true });

      assert.deepEqual(dry.invited, ["x@y.co"]);
      assert.equal(sent.length, 1, "a dry run sends nothing");
    });

  it("reads a CSV with or without a header", () => {
    assert.deepEqual(parseCsv("Email,First name,Last name\n" +
      "a@b.co,Pat,Example\n\"b@c.co\",,\n"), [
      { email: "a@b.co", firstName: "Pat", lastName: "Example" },
      { email: "b@c.co", firstName: "", lastName: "" },
    ]);
    assert.deepEqual(parseCsv("last,email\nExample,a@b.co\n"), [
      { email: "a@b.co", firstName: "", lastName: "Example" },
    ]);
    assert.deepEqual(parseCsv("a@b.co,Pat\n"), [
      { email: "a@b.co", firstName: "Pat", lastName: "" },
    ]);
  });
});

describe("the audience sync", () => {
  const audience = { ...env, RESEND_AUDIENCE_ID: "aud", RESEND_API_KEY: "k" };
  const fake = (contacts) => {
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ method: init.method, url, body: init.body
        ? JSON.parse(init.body) : null });

      return {
        ok: true,
        json: async () => (init.method === "GET" ? { data: contacts } : {}),
      };
    };

    return { calls, fetchImpl };
  };

  it("does nothing without an audience", async () => {
    const r = await syncAudience(testStores(), { env });

    assert.equal(r.reason, "unconfigured");
  });

  it("adds consenting records, removes withdrawn ones, and takes an " +
    "unsubscribe in Resend as the customer's word", async () => {
    const stores = testStores();
    const { calls, fetchImpl } = fake([
      { email: "gone@example.com", unsubscribed: true },
      { email: "left@example.com", unsubscribed: false },
      { email: "hand@example.com", first_name: "By", last_name: "Hand",
        unsubscribed: false },
      { email: "quiet@example.com", unsubscribed: true },
    ]);

    await stores.jobs.set(SYNC_KEY, { at: "2026-09-30T05:00:00.000Z" });
    await saveCustomer(stores, customer("new@example.com", {
      marketing: true, marketingAt: "2026-09-30T12:00:00.000Z",
    }));
    await saveCustomer(stores, customer("gone@example.com", {
      marketing: true, marketingAt: "2026-09-01T00:00:00.000Z",
    }));
    await saveCustomer(stores, customer("left@example.com", {
      marketing: false, marketingAt: "2026-09-30T12:00:00.000Z",
    }));
    await saveCustomer(stores, customer("never@example.com"));

    const r = await syncAudience(stores, {
      env: audience, fetchImpl, now, pace: 0,
    });

    assert.deepEqual({
      created: r.created, resubscribed: r.resubscribed,
      unsubscribed: r.unsubscribed, optedOut: r.optedOut,
      imported: r.imported,
    }, {
      created: ["new@example.com"],
      resubscribed: [],
      unsubscribed: ["left@example.com"],
      optedOut: ["gone@example.com"],
      imported: ["hand@example.com"],
    });
    assert.deepEqual(calls.map((c) => [c.method, c.url.replace(
      "https://api.resend.com", "")]), [
      ["GET", "/audiences/aud/contacts"],
      ["PATCH", "/audiences/aud/contacts/left%40example.com"],
      ["POST", "/audiences/aud/contacts"],
    ], "records in key order: the withdrawn one first");
    assert.deepEqual(calls[1].body, { unsubscribed: true });
    assert.deepEqual(calls[2].body, {
      email: "new@example.com", first_name: "Pat", last_name: "Example",
      unsubscribed: false,
    });
    assert.equal((await getCustomer(stores, "gone@example.com")).marketing,
      false, "unsubscribed in Resend, opted out here");
    assert.equal((await getCustomer(stores, "hand@example.com")).marketing,
      true, "added by hand in Resend, a record here");
    assert.equal((await getCustomer(stores, "hand@example.com")).name,
      "By Hand");
    assert.equal(await getCustomer(stores, "quiet@example.com"), null,
      "an unsubscribed stranger stays a stranger");
    assert.equal((await stores.jobs.get(SYNC_KEY)).at, now.toISOString());
  });

  it("lets a fresh consent here override an old unsubscribe there",
    async () => {
      const stores = testStores();
      const { calls, fetchImpl } = fake([
        { email: "back@example.com", unsubscribed: true },
      ]);

      await stores.jobs.set(SYNC_KEY, { at: "2026-09-30T05:00:00.000Z" });
      await saveCustomer(stores, customer("back@example.com", {
        marketing: true, marketingAt: "2026-09-30T12:00:00.000Z",
      }));

      const r = await syncAudience(stores, {
        env: audience, fetchImpl, now, pace: 0,
      });

      assert.deepEqual(r.resubscribed, ["back@example.com"]);
      assert.deepEqual(calls[1].body, { unsubscribed: false });
    });

  it("touches nothing on a dry run", async () => {
    const stores = testStores();
    const { calls, fetchImpl } = fake([]);

    await saveCustomer(stores, customer("new@example.com", {
      marketing: true, marketingAt: now.toISOString(),
    }));

    const r = await syncAudience(stores, {
      env: audience, fetchImpl, now, pace: 0, dryRun: true,
    });

    assert.deepEqual(r.created, ["new@example.com"]);
    assert.equal(calls.length, 1, "only the listing");
    assert.equal(await stores.jobs.get(SYNC_KEY), null);
  });
});

describe("the endpoints", () => {
  const req = (path, method = "GET", body, headers = {}) =>
    new Request(`https://northfosterfarm.com${path}`, {
      method,
      headers: {
        "Content-Type": "application/json", "sec-fetch-site": "same-origin",
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  it("take a request and land the click on the news page", async () => {
    const stores = testStores();
    const { sent, mail } = mailbox();
    const ok = await handle(req("/api/news/subscribe", "POST",
      { email: "Pat@Example.com" }), { stores, env, now, mail });

    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { ok: true });
    assert.equal(sent.length, 1);

    const url = sent[0].text.match(/https:\S+confirm\?token=\S+/)[0];
    const landed = await handle(req(`/api/news/confirm?token=${tokenIn(url)}`),
      { stores, env, now: later });

    assert.equal(landed.status, 303);
    assert.equal(landed.headers.get("location"),
      "https://northfosterfarm.com/news/?news=confirmed");
    assert.equal((await getCustomer(stores, "pat@example.com")).marketing,
      true);

    const again = await handle(req(`/api/news/confirm?token=${tokenIn(url)}`),
      { stores, env, now: later });

    assert.equal(again.headers.get("location"),
      "https://northfosterfarm.com/news/?news=invalid");
  });

  it("refuse a bad address, a cross-site post, and say nothing about " +
    "a rate limit", async () => {
    const stores = testStores();
    const { sent, mail } = mailbox();

    assert.equal((await handle(req("/api/news/subscribe", "POST",
      { email: "nope" }), { stores, env, now, mail })).status, 422);
    assert.equal((await handle(req("/api/news/subscribe", "POST",
      { email: "a@b.co" }, { "sec-fetch-site": "cross-site" }),
    { stores, env, now, mail })).status, 403);
    for (let i = 0; i < REQUESTS_PER_WINDOW + 1; i += 1) {
      const res = await handle(req("/api/news/subscribe", "POST",
        { email: "a@b.co" }), { stores, env, now, mail });

      assert.equal(res.status, 200);
    }
    assert.equal(sent.length, REQUESTS_PER_WINDOW);
  });
});

describe("the confirmation email", () => {
  it("reads as James wrote it", () => {
    const m = newsConfirm("a@b.co", "https://x/confirm?token=t", {
      days: 7, links: { site: "https://x" },
    });

    assert.equal(m.subject,
      "Confirm your email for North Foster Farm news and updates");
    assert.match(m.text, /^Click the button below to receive news and /m);
    assert.match(m.text, /^This link expires in 7 days\. You're receiving /m);
    assert.match(m.text, /you previously joined our mailing list\.$/m);
    assert.match(m.html, />Sign up</);
    assert.match(m.html, /https:\/\/x\/confirm\?token=t/);
    assert.match(m.html, /name="format-detection"/);
  });
});
