/* eslint-disable camelcase -- Resend names contact fields its way */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  CONFIRM_TTL, REQUESTS_PER_WINDOW, SYNC_KEY, confirmSubscribe,
  inviteSubscribers, optIn, optOut, parseCsv, requestSubscribe,
  subscribe, syncAudience, unsubscribe,
} from "../netlify/functions/lib/news.mjs";
import {
  getCustomer, saveCustomer,
} from "../netlify/functions/lib/records.mjs";
import { testStores } from "../netlify/functions/lib/store.mjs";
import {
  newsConfirm, newsWelcome,
} from "../netlify/functions/lib/templates.mjs";
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

describe("a sign-up on the site", () => {
  it("opts a normalised address in at once, dated, and welcomes it once",
    async () => {
      const stores = testStores();
      const { sent, mail } = mailbox();
      const r = await subscribe(stores, {
        email: " Pat@Example.COM ", firstName: "Pat",
      }, { now, env, mail });

      assert.deepEqual(r, { ok: true, email: "pat@example.com" });

      const saved = await getCustomer(stores, "pat@example.com");

      assert.equal(saved.marketing, true);
      assert.equal(saved.marketingAt, now.toISOString());
      assert.equal(saved.marketingSource, "signup");
      assert.equal(saved.firstName, "Pat");
      assert.equal(saved.lastOrderAt, null, "never ordered");

      assert.equal(sent.length, 1);
      assert.equal(sent[0].to, "pat@example.com");
      assert.equal(sent[0].subject, "You're on the North Foster Farm list");
      assert.match(sent[0].text, /^Hi Pat,$/m);
      assert.ok(sent[0].text.includes("Unsubscribe here: " +
        "https://northfosterfarm.com/news/?unsubscribe="));
      assert.ok(sent[0].headers["List-Unsubscribe"].startsWith(
        "<https://northfosterfarm.com/api/news/unsubscribe?token="));
      assert.equal(sent[0].headers["List-Unsubscribe-Post"],
        "List-Unsubscribe=One-Click");

      // Already on the list: no second welcome.
      await subscribe(stores, { email: "pat@example.com" }, { now, env, mail });
      assert.equal(sent.length, 1);
    });

  it("takes an address off in one click from the welcome, as often as " +
    "it is clicked", async () => {
    const stores = testStores();
    const { sent, mail } = mailbox();

    await subscribe(stores, { email: "pat@example.com" }, { now, env, mail });

    const token = new URL(sent[0].text.match(/https:\S+unsubscribe=[\w-]+/)[0])
      .searchParams.get("unsubscribe");

    assert.deepEqual(await unsubscribe(stores, token, { now: later }),
      { ok: true, email: "pat@example.com" });

    const saved = await getCustomer(stores, "pat@example.com");

    assert.equal(saved.marketing, false);
    assert.equal(saved.marketingAt, later.toISOString());
    assert.equal(saved.marketingSource, "unsubscribe");
    assert.equal((await unsubscribe(stores, token, { now })).ok, true);
    assert.deepEqual(await unsubscribe(stores, "nope", { now }),
      { ok: false, reason: "unknown" });
    assert.deepEqual(await unsubscribe(stores, "", { now }),
      { ok: false, reason: "invalid" });
  });

  it("refuses a bad address and rate-limits an eager one", async () => {
    const stores = testStores();

    assert.equal((await subscribe(stores, { email: "nope" }, { now }))
      .reason, "invalid");
    for (let i = 0; i < REQUESTS_PER_WINDOW; i += 1) {
      assert.equal((await subscribe(stores, { email: "a@b.co" }, { now }))
        .ok, true, `request ${i + 1}`);
    }
    assert.equal((await subscribe(stores, { email: "a@b.co" }, { now }))
      .reason, "rate");
  });
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
      "Confirm your email for farm news from North Foster Farm");
    assert.match(sent[0].text, /^Click the button below/m);
    assert.match(sent[0].text, /7 days/);
    assert.match(sent[0].text, new RegExp(tokenIn(r.url)));
    assert.equal(await getCustomer(stores, "pat@example.com"), null,
      "nothing on the record until the click");
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
      assert.match(sent[0].text, /farm news from North Foster Farm/);
      assert.match(sent[0].text,
        /because you previously joined our mailing list\.$/m);

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

describe("the segment sync", () => {
  const audience = {
    ...env, RESEND_SEGMENT_ID: "seg", RESEND_API_KEY: "k",
    SITE_CONTEXT: "production",
  };
  // The segment's `contacts`, in pages of `size`; `account` the
  // contacts Resend has outside it, found by address.
  const fake = (contacts, { account = [], size = 100 } = {}) => {
    const calls = [];
    const reply = (status, body) => ({
      ok: status < 300, status, json: async () => body,
    });
    const fetchImpl = async (url, init) => {
      const u = new URL(url);

      calls.push({ method: init.method, url, body: init.body
        ? JSON.parse(init.body) : null });

      if (init.method !== "GET") return reply(200, {});
      if (u.pathname.startsWith("/segments/")) {
        const after = u.searchParams.get("after");
        const from = after
          ? contacts.findIndex((c) => c.id === after) + 1 : 0;

        return reply(200, {
          data: contacts.slice(from, from + size),
          has_more: from + size < contacts.length,
        });
      }

      const found = account.find((c) =>
        `/contacts/${encodeURIComponent(c.email)}` === u.pathname);

      return found ? reply(200, found)
        : reply(404, { message: "Contact not found" });
    };

    return { calls, fetchImpl };
  };
  const paths = (calls) => calls.map((c) => [c.method,
    c.url.replace("https://api.resend.com", "")]);

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
    assert.deepEqual(paths(calls), [
      ["GET", "/segments/seg/contacts?limit=100"],
      ["PATCH", "/contacts/left%40example.com"],
      ["GET", "/contacts/new%40example.com"],
      ["POST", "/contacts"],
    ], "records in key order: the withdrawn one first");
    assert.deepEqual(calls[1].body, { unsubscribed: true });
    assert.deepEqual(calls[3].body, {
      email: "new@example.com", first_name: "Pat", last_name: "Example",
      unsubscribed: false, segments: [{ id: "seg" }],
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

  it("lets a consent here after leaving through Resend resubscribe there",
    async () => {
      const stores = testStores();
      const { calls, fetchImpl } = fake([
        { email: "back@example.com", unsubscribed: true },
      ]);

      await stores.jobs.set(SYNC_KEY, { at: "2026-09-30T05:00:00.000Z" });
      await saveCustomer(stores, customer("back@example.com", {
        marketing: true, marketingAt: "2026-09-30T12:00:00.000Z",
        resendLeftAt: "2026-09-29T12:00:00.000Z",
      }));

      const r = await syncAudience(stores, {
        env: audience, fetchImpl, now, pace: 0,
      });

      assert.deepEqual(r.resubscribed, ["back@example.com"]);
      assert.deepEqual(calls[1].body, { unsubscribed: false });
    });

  it("never undoes an unsubscribe in Resend that came after the consent " +
    "(#234)", async () => {
    const stores = testStores();
    const { calls, fetchImpl } = fake([
      { email: "left@example.com", unsubscribed: true },
      { email: "late@example.com", unsubscribed: true },
    ]);

    await stores.jobs.set(SYNC_KEY, { at: "2026-09-30T05:00:00.000Z" });
    // Signed up here since the last sync, then left through Resend
    // before this one: the unsubscribe has no time here yet.
    await saveCustomer(stores, customer("left@example.com", {
      marketing: true, marketingAt: "2026-09-30T12:00:00.000Z",
    }));
    // Left through Resend after the consent, as the webhook recorded.
    await saveCustomer(stores, customer("late@example.com", {
      marketing: true, marketingAt: "2026-09-30T12:00:00.000Z",
      resendLeftAt: "2026-09-30T13:00:00.000Z",
    }));

    const r = await syncAudience(stores, {
      env: audience, fetchImpl, now, pace: 0,
    });

    assert.deepEqual(r.resubscribed, []);
    assert.deepEqual(r.optedOut, ["late@example.com", "left@example.com"]);
    assert.equal(calls.length, 1, "only the listing: nothing sent to Resend");

    const left = await getCustomer(stores, "left@example.com");

    assert.equal(left.marketing, false);
    assert.equal(left.marketingSource, "resend");
    assert.equal(left.resendLeftAt, now.toISOString());

    // A sign-up here after that does resubscribe at the next sync.
    await optIn(stores, "left@example.com", { source: "signup" }, later);

    const next = fake([{ email: "left@example.com", unsubscribed: true }]);
    const again = await syncAudience(stores, {
      env: audience, fetchImpl: next.fetchImpl, now: later, pace: 0,
    });

    assert.deepEqual(again.resubscribed, ["left@example.com"]);
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
    assert.deepEqual(paths(calls).map(([m]) => m), ["GET", "GET"],
      "only reads: the listing and the lookup");
    assert.equal(await stores.jobs.get(SYNC_KEY), null);
  });

  it("reads every page of the segment", async () => {
    const stores = testStores();
    const contacts = ["a", "b", "c", "d", "e"].map((n) => ({
      id: `id-${n}`, email: `${n}@example.com`, unsubscribed: false,
    }));
    const { calls, fetchImpl } = fake(contacts, { size: 2 });

    const r = await syncAudience(stores, {
      env: audience, fetchImpl, now, pace: 0,
    });

    assert.equal(r.imported.length, 5);
    assert.deepEqual(paths(calls).map(([, p]) => p), [
      "/segments/seg/contacts?limit=100",
      "/segments/seg/contacts?limit=100&after=id-b",
      "/segments/seg/contacts?limit=100&after=id-d",
    ]);
  });

  it("adds a contact Resend already has to the segment, and takes a " +
    "sign-up here over an unsubscribe the segment never saw", async () => {
    const stores = testStores();
    const { calls, fetchImpl } = fake([], {
      account: [
        { id: "k1", email: "known@example.com", unsubscribed: false },
        { id: "k2", email: "off@example.com", unsubscribed: true },
      ],
    });

    await saveCustomer(stores, customer("known@example.com", {
      marketing: true, marketingAt: now.toISOString(),
    }));
    await saveCustomer(stores, customer("off@example.com", {
      marketing: true, marketingAt: now.toISOString(),
    }));

    const r = await syncAudience(stores, {
      env: audience, fetchImpl, now, pace: 0,
    });

    assert.deepEqual(paths(calls).slice(1), [
      ["GET", "/contacts/known%40example.com"],
      ["POST", "/contacts/known%40example.com/segments/seg"],
      ["GET", "/contacts/off%40example.com"],
      ["POST", "/contacts/off%40example.com/segments/seg"],
      ["PATCH", "/contacts/off%40example.com"],
    ], "no new contact; only the unsubscribed one's flag changes");
    assert.deepEqual(calls[5].body, { unsubscribed: false });
    assert.deepEqual(r.created, ["known@example.com", "off@example.com"]);
    assert.deepEqual(r.resubscribed, ["off@example.com"]);
    assert.deepEqual(r.optedOut, []);
    assert.equal((await getCustomer(stores, "off@example.com")).marketing,
      true, "the footer's 'You're on the list' holds");
  });

  it("never writes the account's unsubscribe flag outside production",
    async () => {
      const stores = testStores();
      const { calls, fetchImpl } = fake([
        { email: "left@example.com", unsubscribed: false },
        { email: "back@example.com", unsubscribed: true },
        { email: "gone@example.com", unsubscribed: true },
      ], {
        account: [{ id: "k2", email: "off@example.com", unsubscribed: true }],
      });

      // Withdrew on staging: production may still mail this address.
      await saveCustomer(stores, customer("left@example.com", {
        marketing: false, marketingAt: "2026-09-30T12:00:00.000Z",
      }));
      // Consented on staging after leaving: the unsubscribe may be
      // production's, and only production may undo it.
      await saveCustomer(stores, customer("back@example.com", {
        marketing: true, marketingAt: "2026-09-30T12:00:00.000Z",
        resendLeftAt: "2026-09-29T12:00:00.000Z",
      }));
      await saveCustomer(stores, customer("gone@example.com", {
        marketing: true, marketingAt: "2026-09-01T00:00:00.000Z",
      }));
      await saveCustomer(stores, customer("off@example.com", {
        marketing: true, marketingAt: now.toISOString(),
      }));

      for (const context of ["branch-deploy", "deploy-preview", "dev", ""]) {
        calls.length = 0;

        const r = await syncAudience(stores, {
          env: { ...audience, SITE_CONTEXT: context }, fetchImpl, now,
          pace: 0,
        });

        assert.equal(r.flags, false);
        assert.equal(calls.filter((c) => c.method === "PATCH").length, 0,
          `no flag written on "${context}"`);
        assert.deepEqual(r.resubscribed, []);
        assert.deepEqual(r.unsubscribed, []);
      }

      const r = await syncAudience(stores, {
        env: { ...audience, SITE_CONTEXT: "branch-deploy" }, fetchImpl, now,
        pace: 0,
      });

      assert.deepEqual(r.held, [
        { email: "back@example.com", unsubscribed: false },
        { email: "left@example.com", unsubscribed: true },
        { email: "off@example.com", unsubscribed: false },
      ]);
      assert.equal((await getCustomer(stores, "gone@example.com")).marketing,
        false, "its own record still follows Resend's flag");
    });

  it("reads the old audience id as the segment's", async () => {
    const { calls, fetchImpl } = fake([]);

    await syncAudience(testStores(), {
      env: { ...env, RESEND_AUDIENCE_ID: "aud", RESEND_API_KEY: "k" },
      fetchImpl, now, pace: 0,
    });
    assert.deepEqual(paths(calls), [
      ["GET", "/segments/aud/contacts?limit=100"],
    ]);
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

  it("take a sign-up at once and land the click on the news page",
    async () => {
      const stores = testStores();
      const { sent, mail } = mailbox();
      const ok = await handle(req("/api/news/subscribe", "POST",
        { email: "Pat@Example.com" }), { stores, env, now, mail });

      assert.equal(ok.status, 200);
      assert.deepEqual(await ok.json(), { ok: true });
      assert.equal((await getCustomer(stores, "pat@example.com")).marketing,
        true);

      assert.equal(sent.length, 1, "the welcome");

      const r = await requestSubscribe(stores, { email: "old@example.com" },
        { now, env, mail });
      const url = sent[1].text.match(/https:\S+confirm\?token=\S+/)[0];
      const landed = await handle(
        req(`/api/news/confirm?token=${tokenIn(url)}`),
        { stores, env, now: later }
      );

      assert.equal(r.ok, true);
      assert.equal(landed.status, 303);
      assert.equal(landed.headers.get("location"),
        "https://northfosterfarm.com/news/?news=confirmed");
      assert.equal((await getCustomer(stores, "old@example.com")).marketing,
        true);

      const again = await handle(
        req(`/api/news/confirm?token=${tokenIn(url)}`),
        { stores, env, now: later }
      );

      assert.equal(again.headers.get("location"),
        "https://northfosterfarm.com/news/?news=invalid");
    });

  it("refuse a bad address, a cross-site post, and say nothing about " +
    "a rate limit", async () => {
    const stores = testStores();

    assert.equal((await handle(req("/api/news/subscribe", "POST",
      { email: "nope" }), { stores, env, now })).status, 422);
    assert.equal((await handle(req("/api/news/subscribe", "POST",
      { email: "a@b.co" }, { "sec-fetch-site": "cross-site" }),
    { stores, env, now })).status, 403);
    assert.equal(await getCustomer(stores, "a@b.co"), null,
      "a cross-site post adds nobody");
    for (let i = 0; i < REQUESTS_PER_WINDOW + 1; i += 1) {
      const res = await handle(req("/api/news/subscribe", "POST",
        { email: "a@b.co" }), { stores, env, now });

      assert.equal(res.status, 200);
    }
  });
});

describe("the unsubscribe endpoint", () => {
  it("takes the page's post and a mail app's one-click post, from " +
    "anywhere", async () => {
    const stores = testStores();
    const { sent, mail } = mailbox();

    await subscribe(stores, { email: "pat@example.com" }, { now, env, mail });

    const header = sent[0].headers["List-Unsubscribe"].slice(1, -1);
    const token = new URL(header).searchParams.get("token");
    const page = await handle(new Request(
      "https://northfosterfarm.com/api/news/unsubscribe", {
        method: "POST",
        headers: {
          "Content-Type": "application/json", "sec-fetch-site": "same-origin",
        },
        body: JSON.stringify({ token }),
      }), { stores, env, now });

    assert.equal(page.status, 200);
    assert.equal((await getCustomer(stores, "pat@example.com")).marketing,
      false);

    const app = await handle(new Request(header, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "sec-fetch-site": "cross-site",
      },
      body: "List-Unsubscribe=One-Click",
    }), { stores, env, now });

    assert.equal(app.status, 200);

    const bad = await handle(new Request(
      "https://northfosterfarm.com/api/news/unsubscribe?token=nope",
      { method: "POST" }), { stores, env, now });

    assert.equal(bad.status, 404);
  });
});

describe("the welcome email", () => {
  it("reads as James drafted it (T6a)", () => {
    const url = "https://x/news/?unsubscribe=t";
    const m = newsWelcome({ firstName: "Pat" }, url, {});

    assert.equal(m.subject, "You're on the North Foster Farm list");
    assert.ok(m.text.includes("Hi Pat,\nThanks for signing up. You're on " +
      "our farm news list.\nEvery now and then, we'll email you what's " +
      "happening on the farm: what's in stock, where to find us, and news " +
      "from the pasture. We hope it goes without saying, but we will " +
      "never sell or give out your address.\nDon't want these after " +
      `all? Unsubscribe here: ${url}. One click and you're off.\n` +
      "— James and Jim"), m.text);
    assert.match(m.html, /<a href="https:\/\/x\/news\/\?unsubscribe=t"/);
    assert.match(newsWelcome({}, url, {}).text, /^Hi,$/m);
  });
});

describe("the confirmation email", () => {
  it("reads as James wrote it", () => {
    const m = newsConfirm("a@b.co", "https://x/confirm?token=t", {
      days: 7, links: { site: "https://x" },
    });

    assert.equal(m.subject,
      "Confirm your email for farm news from North Foster Farm");
    assert.match(m.text, /^Click the button below to receive farm news /m);
    assert.match(m.text, /^This link expires in 7 days\. You're receiving /m);
    assert.match(m.text,
      /because you previously joined our mailing list\.$/m);
    assert.match(m.html, />Sign up</);
    assert.match(m.html, /https:\/\/x\/confirm\?token=t/);
    assert.match(m.html, /name="format-detection"/);
  });
});
