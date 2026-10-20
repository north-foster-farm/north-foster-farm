// The consent log, the schema-only fields and the list template
// (#273).
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  confirmSubscribe, optIn, optOut, requestSubscribe, subscribe,
} from "../netlify/functions/lib/news.mjs";
import {
  CONSENT_TYPES, SCHEMA_DEFAULTS, consentLog, currentOptIn, getCustomer,
  saveCustomer, touchCustomer,
} from "../netlify/functions/lib/records.mjs";
import { testStores } from "../netlify/functions/lib/store.mjs";
import {
  listBlocks, listMail, newsConfirm, newsWelcome, optInPhrase,
} from "../netlify/functions/lib/templates.mjs";

const now = new Date("2026-10-20T14:00:00Z");
const later = new Date("2026-10-22T14:00:00Z");
const env = { SITE_URL: "https://northfosterfarm.com" };
const links = { site: "https://x", order: "https://x/order/" };
const mailbox = () => {
  const sent = [];

  return { sent, mail: async (m) => { sent.push(m); return { id: "m" }; } };
};
const tokenIn = (url) => new URL(url).searchParams.get("token");

describe("the consent log", () => {
  it("logs a sign-up with its page and time", async () => {
    const stores = testStores();
    const { mail } = mailbox();

    await subscribe(stores, { email: "pat@example.com" },
      { now, env, mail, page: "/news/" });

    const [event] = (await getCustomer(stores, "pat@example.com")).consent;

    assert.deepEqual(event, {
      action: "in", type: "website-form",
      detail: "the sign-up form on /news/", at: now.toISOString(),
      recordedAt: now.toISOString(), capturedBy: null, evidence: null,
    });
  });

  it("appends, never rewrites: out and in again keeps all three",
    async () => {
      const stores = testStores();

      await optIn(stores, "pat@example.com", { source: "signup" }, now);
      await optOut(stores, "pat@example.com",
        { source: "unsubscribe" }, later);
      await optIn(stores, "pat@example.com", {
        source: "market-sheet", detail: "the Foster Farmers Market",
        capturedBy: "Jim", evidence: "foster-2026-07.pdf",
        givenAt: "2026-07-12T14:00:00.000Z",
      }, new Date("2026-10-25T14:00:00Z"));

      const log = (await getCustomer(stores, "pat@example.com")).consent;

      assert.deepEqual(log.map((e) => [e.action, e.type]), [
        ["in", "website-form"], ["out", "unsubscribe-link"],
        ["in", "market-sheet"],
      ]);
      assert.equal(log[2].at, "2026-07-12T14:00:00.000Z",
        "when it was given, not when it was entered");
      assert.equal(log[2].recordedAt, "2026-10-25T14:00:00.000Z");
      assert.equal(log[2].capturedBy, "Jim");
      assert.equal(log[2].evidence, "foster-2026-07.pdf");
    });

  it("adds nothing for a write that leaves consent alone", async () => {
    const stores = testStores();
    const saved = await optIn(stores, "pat@example.com",
      { source: "signup" }, now);

    await saveCustomer(stores, { ...saved, phone: "401-555-0100" });

    assert.equal(
      (await getCustomer(stores, "pat@example.com")).consent.length, 1);
  });

  it("logs the checkout box with the order", async () => {
    const stores = testStores();

    await touchCustomer(stores, {
      email: "pat@example.com", name: "Pat", marketing: true,
    }, now, { orderId: "NFF-1" });

    const [event] = (await getCustomer(stores, "pat@example.com")).consent;

    assert.equal(event.type, "checkout");
    assert.equal(event.detail, "order NFF-1");
  });

  it("logs a change made without an event from its source", async () => {
    const stores = testStores();

    await saveCustomer(stores, {
      email: "pat@example.com", marketing: true,
      marketingAt: now.toISOString(), marketingSource: "account",
    });

    const [event] = (await getCustomer(stores, "pat@example.com")).consent;

    assert.equal(event.type, "account-settings");
  });

  it("gives a record from before the log one event", () => {
    const old = {
      email: "pat@example.com", marketing: true,
      marketingAt: "2026-09-30T12:00:00.000Z", marketingSource: "order",
    };

    assert.deepEqual(consentLog(old).map((e) => [e.type, e.at]),
      [["checkout", "2026-09-30T12:00:00.000Z"]]);
    assert.deepEqual(consentLog({ email: "a@b.co" }), []);
    assert.equal(currentOptIn(old).type, "checkout");
    assert.equal(currentOptIn({ ...old, marketing: false }), null);
  });

  it("names a type for every source the code writes", () => {
    for (const type of ["website-form", "checkout", "account-settings",
      "reinvite-confirmation", "market-sheet", "in-person", "resend",
      "unsubscribe-link", "membership"]) {
      assert.ok(CONSENT_TYPES.includes(type), type);
    }
  });
});

describe("the schema-only fields", () => {
  it("fill every record on write, default English", async () => {
    const stores = testStores();
    const saved = await saveCustomer(stores, { email: "pat@example.com" });

    assert.deepEqual(SCHEMA_DEFAULTS, {
      language: "en", memberId: null, memberIdStatus: null,
      memberSince: null, memberGroup: null,
    });
    for (const [key, value] of Object.entries(SCHEMA_DEFAULTS)) {
      assert.deepEqual(saved[key], value, key);
    }
  });

  it("keep a value already set", async () => {
    const stores = testStores();
    const saved = await saveCustomer(stores, {
      email: "pat@example.com", language: "es",
    });

    assert.equal(saved.language, "es");
  });
});

describe("the re-invite's click", () => {
  it("starts the welcome, naming the confirmation", async () => {
    const stores = testStores();
    const { sent, mail } = mailbox();
    const r = await requestSubscribe(stores, { email: "sam@example.com" },
      { now, env, mail });

    await confirmSubscribe(stores, tokenIn(r.url),
      { now: later, env, mail });

    assert.equal(sent.length, 2);
    assert.match(sent[1].text,
      /because you confirmed you'd like to stay on our list/);
    assert.match(sent[1].text, /moved our list to a new email provider/);
    assert.ok(sent[1].headers["List-Unsubscribe"]);
  });
});

describe("the welcome", () => {
  const who = (type, detail = "", at = now.toISOString()) => ({
    firstName: "Pat", marketing: true, marketingAt: now.toISOString(),
    consent: [{ action: "in", type, detail, at,
      recordedAt: now.toISOString(), capturedBy: null, evidence: null }],
  });

  it("names how each person opted in", () => {
    assert.match(newsWelcome(who("website-form"), "https://u", {}).text,
      /because you signed up on our website\./);
    assert.match(newsWelcome(who("market-sheet", "the Foster Farmers " +
      "Market", "2026-07-12T14:00:00Z"), "https://u", {}).text,
    /you signed up on our sheet at the Foster Farmers Market in July\./);
    assert.match(newsWelcome(who("in-person"), "https://u", {}).text,
      /you asked us to add you when we met in person\./);
  });

  it("tells only the moved contacts about the new provider", () => {
    const moved = /new email provider/;

    assert.doesNotMatch(newsWelcome(who("website-form"), "u", {}).text,
      moved);
    assert.match(newsWelcome(who("market-sheet"), "u", {}).text, moved);
    assert.match(newsWelcome(who("reinvite-confirmation"), "u", {}).text,
      moved);
  });

  it("keeps James's T6 lines and the one-click link", () => {
    const m = newsWelcome(who("checkout"), "https://x/news/?unsubscribe=t",
      { links });

    assert.equal(m.subject, "You're on the North Foster Farm list");
    assert.match(m.text, /^Hi Pat,$/m);
    assert.match(m.text, /we will never sell or give out your address\./);
    assert.match(m.text, /Unsubscribe here: https:\/\/x\/news\/\?unsub/);
    assert.match(m.text, /^— James and Jim$/m);
    assert.match(m.html, /href="https:\/\/x\/news\/\?unsubscribe=t"/);
    assert.match(newsWelcome({}, "u", {}).text, /^Hi,$/m);
  });

  it("words a missing event plainly", () => {
    assert.equal(optInPhrase(null), "you joined our email list");
  });
});

describe("the list template", () => {
  const m = listMail("Sample", {
    preview: "Peek", hero: { src: "https://x/h.jpg", alt: "Chicks" },
    blocks: [
      listBlocks.p("Body"), listBlocks.heading("Week"),
      listBlocks.image("https://x/i.jpg", "Hen", "A hen."),
      listBlocks.button("Order", "https://x/order/"),
    ],
    reason: "you signed up on our website",
    unsubscribeUrl: "https://x/u", links,
  });

  it("has the footer CAN-SPAM asks for, in both versions", () => {
    for (const body of [m.text, m.html]) {
      assert.match(body, /You're getting this because you signed up/);
      assert.match(body, /99 East Killingly Road, Foster, RI 02825/);
      assert.match(body, /https:\/\/x\/u/);
    }
  });

  it("follows dark mode and fits a phone", () => {
    assert.match(m.html, /content="light dark"/);
    assert.match(m.html, /prefers-color-scheme:dark/);
    assert.match(m.html, /max-width:480px/);
  });

  it("carries every block, and the preview text hidden", () => {
    assert.match(m.html, /src="https:\/\/x\/h\.jpg" alt="Chicks"/);
    assert.match(m.html, /alt="Hen"/);
    assert.match(m.html, />A hen\.</);
    assert.match(m.html, /display:none[^>]*>Peek/);
    assert.match(m.text, /\[Photo: Hen\]\nA hen\./);
    assert.match(m.text, /Order: https:\/\/x\/order\//);
  });

  it("leaves the unsubscribe out of the invitation", () => {
    const invite = newsConfirm("a@b.co", "https://x/c", { links });

    assert.doesNotMatch(invite.text, /Unsubscribe/);
    assert.match(invite.text, /we won't email you again/);
  });
});
