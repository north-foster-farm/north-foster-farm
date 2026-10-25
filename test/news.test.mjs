/* eslint-disable camelcase -- Resend names contact fields its way */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";

import {
  CONFIRM_TTL, REQUESTS_PER_WINDOW, SYNC_KEY, confirmSubscribe,
  forgottenKey, importSubscribers, optIn, optOut, parseCsv,
  requestSubscribe, subscribe, syncAudience, unsubscribe,
} from "../netlify/functions/lib/news.mjs";
import {
  withholdCustomerEmail,
} from "../netlify/functions/lib/payments.mjs";
import {
  getCustomer, saveCustomer,
} from "../netlify/functions/lib/records.mjs";
import { testStores } from "../netlify/functions/lib/store.mjs";
import {
  newsConfirm,
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

// The token of the confirmation link in a sent email.
const confirmToken = (m) =>
  tokenIn(m.text.match(/https:\S+confirm\?token=\S+/)[0]);

// A sign-up on the site, confirmed: on the list, welcomed.
const join = async (stores, email, mail, sent) => {
  await subscribe(stores, { email }, { now, env, mail });
  await confirmSubscribe(stores, confirmToken(sent.at(-1)),
    { now, env, mail });
};

describe("a sign-up on the site", () => {
  it("mails a normalised address the confirmation link, and adds nothing " +
    "until it is followed (#303)", async () => {
    const stores = testStores();
    const { sent, mail } = mailbox();
    const r = await subscribe(stores, {
      email: " Pat@Example.COM ", firstName: "Pat",
    }, { now, env, mail, page: "/news/" });

    assert.deepEqual(r, { ok: true, email: "pat@example.com" });
    assert.equal(await getCustomer(stores, "pat@example.com"), null,
      "nothing on the record until the click");
    assert.equal(sent.length, 1);
    assert.equal(sent[0].to, "pat@example.com");
    assert.equal(sent[0].subject, "Confirm your email address for Farm News");

    await confirmSubscribe(stores, confirmToken(sent[0]),
      { now: later, env, mail });

    const saved = await getCustomer(stores, "pat@example.com");

    assert.equal(saved.marketing, true);
    assert.equal(saved.marketingAt, later.toISOString());
    assert.equal(saved.marketingSource, "signup");
    assert.equal(saved.firstName, "Pat");
    assert.equal(saved.lastOrderAt, null, "never ordered");
    assert.equal(saved.consent.at(-1).type, "website-form");
    assert.equal(saved.consent.at(-1).detail,
      "the sign-up form on /news/, confirmed by the link sent 2026-10-01");

    assert.equal(sent.length, 2, "the welcome, once confirmed");
    assert.equal(sent[1].subject, "You're on the North Foster Farm list");
    assert.match(sent[1].text, /^Hi Pat,$/m);
    assert.ok(sent[1].text.includes("Unsubscribe here: " +
      "https://northfosterfarm.com/news/?unsubscribe="));
    assert.ok(sent[1].headers["List-Unsubscribe"].startsWith(
      "<https://northfosterfarm.com/api/news/unsubscribe?token="));
    assert.equal(sent[1].headers["List-Unsubscribe-Post"],
      "List-Unsubscribe=One-Click");

    // Already on the list: no second link, no second welcome.
    assert.deepEqual(await subscribe(stores, { email: "pat@example.com" },
      { now, env, mail }), { ok: true, email: "pat@example.com" });
    assert.equal(sent.length, 2);
  });

  it("takes an address off in one click from the welcome, as often as " +
    "it is clicked", async () => {
    const stores = testStores();
    const { sent, mail } = mailbox();

    await join(stores, "pat@example.com", mail, sent);

    const token = new URL(sent[1].text.match(/https:\S+unsubscribe=[\w-]+/)[0])
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
      "Confirm your email address for Farm News");
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
    assert.equal(saved.marketingSource, "signup");
    assert.equal(saved.name, "Sam New");
    assert.equal(saved.lastOrderAt, null, "never ordered");

    const again = await confirmSubscribe(stores, tokenIn(r.url),
      { now: later });

    assert.equal(again.reason, "unknown", "single use");
  });

  it("confirms a link the old re-invite mailed before #303 as one",
    async () => {
      const stores = testStores();
      const token = "old-invite-token";
      const key = `news/${createHash("sha256").update(token).digest("hex")}`;

      await stores.auth.set(key, {
        email: "old@example.com", firstName: "", lastName: "",
        expires: later.getTime() + 1, createdAt: now.toISOString(),
      });

      assert.equal((await confirmSubscribe(stores, token,
        { now: later, env, mail: mailbox().mail })).ok, true);

      const saved = await getCustomer(stores, "old@example.com");

      assert.equal(saved.marketingSource, "confirm");
      assert.equal(saved.consent.at(-1).type, "reinvite-confirmation");
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

describe("the import of the old list (#303)", () => {
  it("puts each address on the list at once, its consent the dated " +
    "sheet, with the welcome and no confirmation", async () => {
    const stores = testStores();
    const { sent, mail } = mailbox();

    await saveCustomer(stores, customer("in@example.com", {
      marketing: true, marketingAt: now.toISOString(),
    }));
    await saveCustomer(stores, customer("never@example.com"));

    const report = await importSubscribers(stores, [
      { email: "In@Example.com" },
      { email: "new@example.com", firstName: "Sam", lastName: "New" },
      { email: "never@example.com", date: "2025-06-14",
        market: "the Scituate Farmers Market" },
      { email: "not an address" },
    ], {
      date: "2024-07-12", market: "the Foster Farmers Market",
      capturedBy: "James", evidence: "foster-2024-07-12.pdf",
      now, env, mail,
    });

    assert.deepEqual(report, {
      imported: ["new@example.com", "never@example.com"],
      skipped: ["in@example.com"],
      declined: [],
      invalid: ["not an address"],
      withheld: [],
    });

    const saved = await getCustomer(stores, "new@example.com");
    const event = saved.consent.at(-1);

    assert.equal(saved.marketing, true);
    assert.equal(saved.marketingAt, now.toISOString(), "when it was written");
    assert.equal(saved.marketingSource, "import");
    assert.equal(saved.name, "Sam New");
    assert.deepEqual(event, {
      action: "in", type: "market-sheet",
      detail: "the Foster Farmers Market",
      at: "2024-07-12T12:00:00.000Z", recordedAt: now.toISOString(),
      capturedBy: "James", evidence: "foster-2024-07-12.pdf",
    });

    const row = (await getCustomer(stores, "never@example.com")).consent
      .at(-1);

    assert.equal(row.at, "2025-06-14T12:00:00.000Z", "the row's own date");
    assert.equal(row.detail, "the Scituate Farmers Market");

    assert.deepEqual(sent.map((m) => m.to),
      ["new@example.com", "never@example.com"], "a welcome each");
    assert.equal(sent[0].subject, "You're on the North Foster Farm list");
    assert.match(sent[0].text,
      /you signed up on our sign-up sheet at the Foster Farmers Market/);
    assert.doesNotMatch(sent.map((m) => m.text).join("\n"),
      /confirm\?token=/, "no confirmation round");
  });

  it("leaves alone an address that said no here, or was deleted, and " +
    "refuses a row with no real date", async () => {
    const stores = testStores();
    const { sent, mail } = mailbox();

    await saveCustomer(stores, customer("left@example.com", {
      marketing: false, marketingAt: "2026-09-20T12:00:00.000Z",
      marketingSource: "unsubscribe",
    }));
    await stores.customers.set(forgottenKey("gone@example.com"), {});

    const report = await importSubscribers(stores, [
      { email: "left@example.com" },
      { email: "gone@example.com" },
      { email: "nodate@example.com", date: "" },
      { email: "unreal@example.com", date: "2025-02-30" },
      { email: "future@example.com", date: "2026-12-01" },
    ], { date: "2024-07-12", now, env, mail });

    assert.deepEqual(report.declined,
      ["left@example.com", "gone@example.com"]);
    assert.deepEqual(report.invalid, ["unreal@example.com",
      "future@example.com"]);
    assert.deepEqual(report.imported, ["nodate@example.com"],
      "an empty cell takes the flag's date");
    assert.equal((await getCustomer(stores, "left@example.com")).marketing,
      false);
    assert.equal(await getCustomer(stores, "gone@example.com"), null);

    const none = await importSubscribers(stores, [{ email: "x@y.co" }],
      { now, env, mail });

    assert.deepEqual(none.invalid, ["x@y.co"], "a date is required");
    assert.equal(sent.length, 1);
  });

  it("writes and sends nothing on a dry run", async () => {
    const stores = testStores();
    const { sent, mail } = mailbox();
    const dry = await importSubscribers(stores, [{ email: "x@y.co" }],
      { date: "2024-07-12", now, env, mail, dryRun: true });

    assert.deepEqual(dry.imported, ["x@y.co"]);
    assert.equal(await getCustomer(stores, "x@y.co"), null);
    assert.equal(sent.length, 0);
  });

  it("imports with no welcome under --no-email, and lists who it held",
    async () => {
      const stores = testStores();
      const { sent, mail } = mailbox();

      withholdCustomerEmail();

      try {
        const report = await importSubscribers(stores, [
          { email: "new@example.com" },
        ], { date: "2024-07-12", now, env, mail });

        assert.deepEqual(report.withheld, ["new@example.com"]);
        assert.deepEqual(report.imported, ["new@example.com"]);
        assert.equal((await getCustomer(stores, "new@example.com"))
          .marketing, true);
        assert.equal(sent.length, 0);
      } finally {
        withholdCustomerEmail(false);
      }
    });

  it("reaches Resend at the next sync as a new contact", async () => {
    const stores = testStores();
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ method: init.method, body: init.body
        ? JSON.parse(init.body) : null });

      return { ok: true, json: async () => ({ data: [] }) };
    };

    await importSubscribers(stores, [{ email: "new@example.com" }],
      { date: "2024-07-12", now, env, mail: mailbox().mail });

    const r = await syncAudience(stores, {
      env: { ...env, RESEND_AUDIENCE_ID: "aud", RESEND_API_KEY: "k" },
      fetchImpl, now, pace: 0,
    });

    assert.deepEqual(r.created, ["new@example.com"]);
    assert.equal(calls[1].body.unsubscribed, false);
  });

  it("reads a CSV with or without a header", () => {
    assert.deepEqual(parseCsv("Email,First name,Last name\n" +
      "a@b.co,Pat,Example\n\"b@c.co\",,\n"), [
      { email: "a@b.co", firstName: "Pat", lastName: "Example",
        date: "", market: "" },
      { email: "b@c.co", firstName: "", lastName: "", date: "", market: "" },
    ]);
    assert.deepEqual(parseCsv("last,email\nExample,a@b.co\n"), [
      { email: "a@b.co", firstName: "", lastName: "Example",
        date: "", market: "" },
    ]);
    assert.deepEqual(parseCsv("a@b.co,Pat\n"), [
      { email: "a@b.co", firstName: "Pat", lastName: "", date: "",
        market: "" },
    ]);
    assert.deepEqual(parseCsv("email,sheet date,market\n" +
      "a@b.co,2024-07-12,Foster\n"), [
      { email: "a@b.co", firstName: "", lastName: "", date: "2024-07-12",
        market: "Foster" },
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

  it("mail a sign-up its link and land the click on the news page",
    async () => {
      const stores = testStores();
      const { sent, mail } = mailbox();
      const ok = await handle(req("/api/news/subscribe", "POST",
        { email: "Pat@Example.com" }, {
          referer: "https://northfosterfarm.com/news/",
        }), { stores, env, now, mail });

      assert.equal(ok.status, 200);
      assert.deepEqual(await ok.json(), { ok: true });
      assert.equal(await getCustomer(stores, "pat@example.com"), null,
        "not on the list until the click");
      assert.equal(sent.length, 1, "the confirmation link");

      const landed = await handle(
        req(`/api/news/confirm?token=${confirmToken(sent[0])}`),
        { stores, env, now: later, mail }
      );

      assert.equal(landed.status, 303);
      assert.equal(landed.headers.get("location"),
        "https://northfosterfarm.com/news/?news=confirmed");

      const saved = await getCustomer(stores, "pat@example.com");

      assert.equal(saved.marketing, true);
      assert.match(saved.consent.at(-1).detail,
        /^the sign-up form on \/news\/, confirmed/);
      assert.equal(sent.length, 2, "then the welcome");

      const again = await handle(
        req(`/api/news/confirm?token=${confirmToken(sent[0])}`),
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

    await join(stores, "pat@example.com", mail, sent);

    const header = sent[1].headers["List-Unsubscribe"].slice(1, -1);
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

describe("the confirmation email", () => {
  it("reads as James wrote it, for a stranger's sign-up (#303)", () => {
    const m = newsConfirm("a@b.co", "https://x/confirm?token=t", {
      days: 7, links: { site: "https://x" },
    });

    assert.equal(m.subject, "Confirm your email address for Farm News");
    assert.match(m.text, /^Click the button below to receive Farm News /m);
    assert.match(m.text, /^This link expires in 7 days\. If you didn't /m);
    assert.match(m.text,
      /request this email, you can safely ignore it\.$/m);
    assert.doesNotMatch(m.text, /previously joined/);
    assert.match(m.html, />Sign up</);
    assert.match(m.html, /https:\/\/x\/confirm\?token=t/);
    assert.match(m.html, /name="format-detection"/);
  });
});
