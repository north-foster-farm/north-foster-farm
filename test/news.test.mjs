/* eslint-disable camelcase -- Resend names contact fields its way */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";

import {
  CONFIRM_TTL, REQUESTS_PER_WINDOW, SYNC_KEY, confirmSubscribe,
  forgottenKey, importSubscribers, optIn, optOut, parseCsv,
  removeImported, requestSubscribe, sendOwedWelcomes, sentNothing, subscribe,
  syncAudience, unsubscribe,
} from "../netlify/functions/lib/news.mjs";
import { MailError } from "../netlify/functions/lib/mail.mjs";
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
import { resendFake } from "./resend-fixture.mjs";

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
    assert.equal(sent[1].subject, "Welcome to Farm News");
    assert.match(sent[1].text, /^Hi Pat,$/m);
    assert.ok(sent[1].text.includes("Unsubscribe in one click: " +
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
    assert.match(sent[0].text, /^Welcome to Farm News\. Please confirm/m);
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
      held: [],
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
    assert.equal(sent[0].subject, "Welcome to Farm News");
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
    const { calls, fetchImpl } = resendFake();

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

describe("holding the old list's welcomes (--skip)", () => {
  const A = "a@example.com";
  const B = "b@example.com";
  const C = "c@example.com";
  const rows = [A, B, C].map((email) => ({ email }));
  const third = new Date("2026-10-03T12:00:00Z");
  const key = (email) => `welcome-${createHash("sha256")
    .update(`${email} ${now.toISOString()}`).digest("hex").slice(0, 16)}`;
  const empty = {
    sent: [], due: [], failed: [], unsure: [], optedOut: [],
    superseded: [], withheld: [], none: [],
  };
  const held = (stores, mail, extra = {}) => importSubscribers(stores, rows, {
    date: "2024-07-12", market: "the Foster Farmers Market",
    now, env, mail, skip: true, ...extra,
  });
  const run = (stores, mail, extra = {}) => sendOwedWelcomes(stores,
    { now: later, env, mail, ...extra });
  const stateOf = async (stores, email) =>
    ((await getCustomer(stores, email)).welcome || {}).state;

  it("imports and consents as ever, sends nothing, and marks each " +
    "record as owing a welcome", async () => {
    const stores = testStores();
    const { sent, mail } = mailbox();

    await saveCustomer(stores, customer("in@example.com", {
      marketing: true, marketingAt: now.toISOString(),
    }));

    const report = await importSubscribers(stores,
      [{ email: "in@example.com" }, ...rows],
      { date: "2024-07-12", now, env, mail, skip: true });

    assert.deepEqual(report.imported, [A, B, C]);
    assert.deepEqual(report.held, [A, B, C]);
    assert.deepEqual(report.skipped, ["in@example.com"]);
    assert.deepEqual(report.withheld, []);
    assert.equal(sent.length, 0, "no welcome yet");

    const saved = await getCustomer(stores, A);

    assert.equal(saved.marketing, true);
    assert.equal(saved.marketingAt, now.toISOString());
    assert.equal(saved.marketingSource, "import");
    assert.equal(saved.consent.length, 1, "one consent event, not two");
    assert.equal(saved.consent[0].type, "market-sheet");
    assert.deepEqual(saved.welcome, {
      state: "owed", for: now.toISOString(), at: now.toISOString(),
    });
    assert.equal((await getCustomer(stores, "in@example.com")).welcome,
      undefined, "a record already consenting owes nothing");
  });

  it("lists who it would hold on a dry run and writes nothing", async () => {
    const stores = testStores();
    const { sent, mail } = mailbox();
    const report = await held(stores, mail, { dryRun: true });

    assert.deepEqual(report.held, [A, B, C]);
    assert.equal(await getCustomer(stores, A), null);
    assert.equal(sent.length, 0);
  });

  it("sends each owed welcome once, skips whoever has opted out, and " +
    "sends nothing on a rerun", async () => {
    const stores = testStores();
    const { sent, mail } = mailbox();

    await held(stores, mail);
    await optOut(stores, C, { source: "unsubscribe" }, later);

    const first = await run(stores, mail);

    assert.deepEqual(first, { ...empty, sent: [A, B], optedOut: [C] });
    assert.deepEqual(sent.map((m) => m.to), [A, B]);
    assert.equal(sent[0].subject, "Welcome to Farm News");
    assert.match(sent[0].text,
      /you signed up on our sign-up sheet at the Foster Farmers Market/);
    assert.equal(sent[0].idempotencyKey, key(A),
      "the welcome's own key, for the consent it is owed for");
    assert.match(sent[0].headers["List-Unsubscribe"], /^<https:/);
    assert.equal(await stateOf(stores, A), "sent");
    assert.equal(await stateOf(stores, C), undefined, "the mark is gone");
    assert.equal((await getCustomer(stores, C)).marketing, false);

    assert.deepEqual(await run(stores, mail), empty);
    assert.equal(sent.length, 2, "a rerun sends no one twice");
  });

  it("puts a send Resend rejected (a 422) back to owed, and the next " +
    "run sends it", async () => {
    const stores = testStores();
    const { sent, mail } = mailbox();

    await held(stores, mail);

    const rejected = async () => {
      throw new MailError("Resend 422", { status: 422 });
    };
    const first = await run(stores, rejected);

    assert.deepEqual(first.failed, [A, B, C]);
    assert.equal(await stateOf(stores, A), "owed");

    const second = await run(stores, mail);

    assert.deepEqual(second.sent, [A, B, C]);
    assert.equal(sent.length, 3);
  });

  it("leaves a send whose outcome is unknown sending, and no later run " +
    "sends it again, a day on or not", async () => {
    const stores = testStores();
    const { sent, mail } = mailbox();

    await held(stores, mail);

    // Resend may have taken the request and answered after we stopped
    // waiting (4 s), so the welcome may be on its way.
    const timeout = async () => {
      throw new MailError("Resend did not answer in 4 s",
        { retryable: true });
    };
    const first = await run(stores, timeout);

    assert.deepEqual(first.failed, [A, B, C]);
    assert.equal(await stateOf(stores, A), "sending");

    const nextDay = new Date(later.getTime() + 2 * 24 * 60 * 60 * 1000);

    for (const at of [later, nextDay]) {
      const again = await run(stores, mail, { now: at });

      assert.deepEqual(again, { ...empty, unsure: [A, B, C] });
    }
    assert.equal(sent.length, 0, "nothing sent twice, nothing sent");
  });

  it("holds the sends that may have been accepted, and releases the " +
    "ones known to have sent nothing", () => {
    const fail = (status, retryable = false) =>
      new MailError("x", { status, retryable });

    // A 4xx Resend rejected, and a refusal before any request: the
    // breaker, or Resend's own guard (no status, not retryable).
    for (const error of [fail(422), fail(400), fail(403), fail(0),
      new MailError("The breaker", { detail: { breaker: "paused" } })]) {
      assert.equal(sentNothing(error), true, `${error.status}`);
    }
    // The same key in progress, a limit, a 5xx, a timeout or network
    // error (no status, retryable), and anything of a shape we do not
    // know.
    for (const error of [fail(409), fail(429, true), fail(500, true),
      fail(503, true), fail(0, true),
      new Error("Resend 500"), new Error("boom"), null, undefined]) {
      assert.equal(sentNothing(error), false, String(error?.status));
    }
  });

  it("never writes over a welcome another run has marked sent",
    async () => {
      for (const status of [409, 422]) {
        const stores = testStores();
        const { mail } = mailbox();

        await held(stores, mail);

        // Another run sends and marks it sent while this one's request
        // is out, and this one's request then fails.
        const other = async () => {
          const rec = await getCustomer(stores, A);

          await saveCustomer(stores, {
            ...rec, welcome: { ...rec.welcome, state: "sent" },
          });
          throw new MailError(`Resend ${status}`, { status });
        };
        const report = await run(stores, other, { email: A });

        assert.deepEqual(report.failed, [A]);
        assert.equal(await stateOf(stores, A), "sent", `after a ${status}`);
        assert.deepEqual((await run(stores, mail, { email: A })).none, [A]);
      }
    });

  it("lists a record left sending as unsure, sends it only when named, " +
    "and never twice", async () => {
    const stores = testStores();
    const { sent, mail } = mailbox();

    await held(stores, mail);

    const owing = await getCustomer(stores, A);

    await saveCustomer(stores, {
      ...owing, welcome: { ...owing.welcome, state: "sending" },
    });

    const bulk = await run(stores, mail);

    assert.deepEqual(bulk, { ...empty, sent: [B, C], unsure: [A] });
    assert.equal(await stateOf(stores, A), "sending");

    const named = await run(stores, mail, { email: "A@Example.com" });

    assert.deepEqual(named.sent, [A]);
    assert.equal(sent.at(-1).idempotencyKey, key(A), "the same key");
    assert.deepEqual((await run(stores, mail, { email: A })).none, [A]);
    assert.equal(sent.length, 3);
  });

  it("sends the one address it is told to, and no other", async () => {
    const stores = testStores();
    const { sent, mail } = mailbox();

    await held(stores, mail);

    const report = await run(stores, mail, { email: B });

    assert.deepEqual(report.sent, [B]);
    assert.equal(await stateOf(stores, A), "owed");
    assert.deepEqual((await run(stores, mail, { email: "x@y.co" })).none,
      ["x@y.co"]);
    assert.equal(sent.length, 1);
  });

  it("changes nothing and sends nothing on a dry run", async () => {
    const stores = testStores();
    const { sent, mail } = mailbox();

    await held(stores, mail);
    await optOut(stores, C, { source: "unsubscribe" }, later);

    const before = JSON.stringify(await Promise.all(
      [A, B, C].map((e) => getCustomer(stores, e))));
    const report = await run(stores, mail, { dryRun: true });

    assert.deepEqual(report, { ...empty, due: [A, B], optedOut: [C] });
    assert.equal(sent.length, 0);
    assert.equal(JSON.stringify(await Promise.all(
      [A, B, C].map((e) => getCustomer(stores, e)))), before);
  });

  it("owes nothing to one who opted out and joined again since, who " +
    "was welcomed then", async () => {
    const stores = testStores();
    const { sent, mail } = mailbox();

    await held(stores, mail);
    await optOut(stores, A, { source: "unsubscribe" }, later);
    await optIn(stores, A, { source: "site" }, third);

    const report = await run(stores, mail);

    assert.deepEqual(report.superseded, [A]);
    assert.deepEqual(report.sent, [B, C]);
    assert.deepEqual(sent.map((m) => m.to), [B, C]);
    assert.equal(await stateOf(stores, A), undefined);
    assert.equal((await getCustomer(stores, A)).marketing, true);
  });

  it("sends nothing under --no-email, and keeps the debt", async () => {
    const stores = testStores();
    const { sent, mail } = mailbox();

    await held(stores, mail);
    withholdCustomerEmail();

    try {
      const report = await run(stores, mail);

      assert.deepEqual(report.withheld, [A, B, C]);
      assert.equal(sent.length, 0);
      assert.equal(await stateOf(stores, A), "owed");
    } finally {
      withholdCustomerEmail(false);
    }
  });

  it("leaves an unsubscribe made during the send standing", async () => {
    const stores = testStores();
    const { sent } = mailbox();
    const mail = async (message) => {
      sent.push(message);
      await optOut(stores, message.to, { source: "unsubscribe" }, later);

      return { id: "m1", driver: "test" };
    };

    await held(stores, mail);

    const report = await run(stores, mail, { email: A });
    const saved = await getCustomer(stores, A);

    assert.deepEqual(report.sent, [A]);
    assert.equal(saved.marketing, false, "the opt-out was not overwritten");
    assert.equal(saved.welcome.state, "sent");
    assert.equal(sent.length, 1);
  });
});

describe("a stale imported address taken out (#496)", () => {
  const A = "a@example.com";
  const audience = { ...env, RESEND_AUDIENCE_ID: "aud", RESEND_API_KEY: "k" };
  const held = (stores, emails = [A]) => importSubscribers(stores,
    emails.map((email) => ({ email })),
    { date: "2024-07-12", now, env, skip: true });
  // After a removal neither the sync nor the welcomes reach the address.
  const leftOut = async (stores, email) => {
    const { calls, fetchImpl } = resendFake();
    const synced = await syncAudience(stores, {
      env: audience, fetchImpl, now: later, pace: 0,
    });
    const { sent, mail } = mailbox();
    const welcomed = await sendOwedWelcomes(stores,
      { now: later, env, mail });

    assert.ok(!synced.created.includes(email), "the sync adds no contact");
    assert.ok(!calls.some((c) => c.body?.email === email),
      "nothing about it reaches Resend");
    assert.ok(!welcomed.sent.includes(email));
    assert.ok(!sent.some((m) => m.to === email), "no welcome goes");
    assert.equal(await stores.customers.get(forgottenKey(email)), null,
      "no decline is recorded");
  };

  it("deletes a record the import made and nothing else touched, held " +
    "welcome and all", async () => {
    const stores = testStores();

    await held(stores, [A, "b@example.com"]);

    const report = await removeImported(stores, "A@Example.com ",
      { by: "james" });

    assert.deepEqual(report,
      { email: A, outcome: "deleted", cleared: [], dryRun: false });
    assert.equal(await getCustomer(stores, A), null);
    assert.ok(await getCustomer(stores, "b@example.com"), "others stay");

    const due = await sendOwedWelcomes(stores, { now: later, env,
      mail: mailbox().mail, dryRun: true });

    assert.deepEqual(due.due, ["b@example.com"]);
    await leftOut(stores, A);
  });

  it("takes the unsubscribe link a sent welcome left", async () => {
    const stores = testStores();
    const { mail } = mailbox();

    await importSubscribers(stores, [{ email: A }],
      { date: "2024-07-12", now, env, mail });
    assert.equal((await stores.auth.list("unsub/")).length, 1);
    assert.equal((await removeImported(stores, A)).outcome, "deleted");
    assert.equal((await stores.auth.list("unsub/")).length, 0);
  });

  it("keeps a record with orders, clearing only the import's consent and " +
    "welcome", async () => {
    const stores = testStores();
    const before = customer(A, {
      marketing: false, marketingAt: null,
      lastOrderAt: "2026-09-15T12:00:00.000Z",
    });

    await saveCustomer(stores, before);
    await stores.orders.set("order/NFF-1", { id: "NFF-1" });
    await stores.orders.set(`by-email/${A}/NFF-1`, { id: "NFF-1" });
    await held(stores);
    assert.equal((await getCustomer(stores, A)).marketing, true);

    const imported = (await getCustomer(stores, A)).consent;
    const report = await removeImported(stores, A, { now: later });
    const saved = await getCustomer(stores, A);

    assert.deepEqual(report, {
      email: A, outcome: "cleared", cleared: ["marketing", "welcome"],
      dryRun: false,
    });
    assert.equal(saved.marketing, false);
    assert.equal(saved.marketingAt, null);
    assert.equal(saved.marketingSource, undefined);
    assert.equal(saved.welcome, undefined);
    assert.deepEqual(saved.consent.slice(0, -1), imported,
      "the import's event stays");
    assert.equal(imported.at(-1).type, "market-sheet");
    assert.deepEqual(saved.consent.at(-1), {
      action: "out", type: "removed",
      detail: "a stale or duplicate import, taken out",
      at: later.toISOString(), recordedAt: later.toISOString(),
      capturedBy: null, evidence: null,
    }, "and the removal is appended");
    assert.equal(saved.lastOrderAt, before.lastOrderAt);
    assert.equal(saved.name, before.name);
    await leftOut(stores, A);

    const back = await importSubscribers(stores, [{ email: A }],
      { date: "2024-07-12", now: later, env, skip: true });

    assert.deepEqual(back.imported, [A], "a later sign-up is not declined");
  });

  it("keeps an imported record that has credit, a group or a sign-in",
    async () => {
      const stores = testStores();
      const B = "b@example.com";
      const C = "c@example.com";

      await held(stores, [A, B, C]);
      await stores.customers.set(`credit/${A}`, { grants: [] });
      await saveCustomer(stores, { ...await getCustomer(stores, B),
        memberGroup: { id: "vff", joinedAt: now.toISOString() } });
      await saveCustomer(stores, { ...await getCustomer(stores, C),
        interaction: { at: later.toISOString(), kind: "sign-in" } });

      for (const email of [A, B, C]) {
        assert.equal((await removeImported(stores, email)).outcome, "cleared",
          email);
        assert.equal((await getCustomer(stores, email)).marketing, false);
      }
    });

  it("reports and writes nothing on a dry run", async () => {
    const stores = testStores();

    await held(stores);

    const record = await getCustomer(stores, A);
    const report = await removeImported(stores, A, { dryRun: true });

    assert.equal(report.outcome, "deleted");
    assert.equal(report.dryRun, true);
    assert.deepEqual(await getCustomer(stores, A), record);
  });

  it("leaves a record with nothing from the import alone", async () => {
    const stores = testStores();
    const record = customer(A, {
      marketing: true, marketingAt: now.toISOString(),
      marketingSource: "order",
    });

    await saveCustomer(stores, record);
    assert.equal((await removeImported(stores, A)).outcome, "none");
    assert.equal((await getCustomer(stores, A)).marketing, true);
    assert.equal((await removeImported(stores, "x@example.com")).outcome,
      "none");
  });
});

describe("the audience sync", () => {
  const audience = { ...env, RESEND_AUDIENCE_ID: "aud", RESEND_API_KEY: "k" };

  it("does nothing without an audience", async () => {
    const r = await syncAudience(testStores(), { env });

    assert.equal(r.reason, "unconfigured");
  });

  it("adds consenting records, removes withdrawn ones, and takes an " +
    "unsubscribe in Resend as the customer's word", async () => {
    const stores = testStores();
    const { calls, fetchImpl } = resendFake([
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
      const { calls, fetchImpl } = resendFake([
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
    const { calls, fetchImpl } = resendFake([
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

    const next = resendFake([
      { email: "left@example.com", unsubscribed: true },
    ]);
    const again = await syncAudience(stores, {
      env: audience, fetchImpl: next.fetchImpl, now: later, pace: 0,
    });

    assert.deepEqual(again.resubscribed, ["left@example.com"]);
  });

  it("touches nothing on a dry run", async () => {
    const stores = testStores();
    const { calls, fetchImpl } = resendFake([]);

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
    assert.match(m.text,
      /^Welcome to Farm News\. Please confirm your email address /m);
    assert.match(m.text,
      /^This link works for 7 days\. If you didn't sign up, you can /m);
    assert.doesNotMatch(m.text, /previously joined|Unsubscribe/i);
    assert.match(m.html, />Confirm my email address</);
    assert.match(m.html, /https:\/\/x\/confirm\?token=t/);
    assert.match(m.html, /name="format-detection"/);
  });
});
