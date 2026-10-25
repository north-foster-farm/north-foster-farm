// Quiet accounts and the interaction clock (#189, D-189). One test or
// more for each rule of D-189 that lib/retention.mjs carries; the
// scrub and Delete my details are test/forget.test.mjs.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { describe, it } from "node:test";

import { handle as account } from "../netlify/functions/account.mjs";
import { handle as auth } from "../netlify/functions/auth.mjs";
import { handle as newsHandle } from "../netlify/functions/news.mjs";
import { quietCustomers } from "../netlify/functions/lib/admin.mjs";
import { requestLink } from "../netlify/functions/lib/auth.mjs";
import { runJobs } from "../netlify/functions/lib/jobs.mjs";
import {
  requestSubscribe, unsubscribeLinks,
} from "../netlify/functions/lib/news.mjs";
import {
  CONSENT_TYPES, getCustomer, saveCustomer, touchCustomer,
} from "../netlify/functions/lib/records.mjs";
import {
  INACTIVE_AFTER_YEARS, KINDS, QUIET_PER_RUN, lastInteraction, leavingChange,
  leavingLink, noteInteraction, quietAccounts, quietDue,
} from "../netlify/functions/lib/retention.mjs";
import { testStores } from "../netlify/functions/lib/store.mjs";
import { quietNotice } from "../netlify/functions/lib/templates.mjs";

const PAT = "pat@example.com";
const env = {
  SITE_URL: "https://northfosterfarm.com", ACCOUNTS_ENABLED: "true",
};
// The record was made 2025-09-01; a year later is 2026-09-01.
const made = "2025-09-01T12:00:00.000Z";
const before = new Date("2026-08-31T12:00:00Z");
const yearOn = new Date("2026-09-01T12:00:00Z");

const mailbox = ({ fail = false } = {}) => {
  const sent = [];

  return {
    sent,
    mail: async (m) => {
      if (fail) throw new Error("mail down");
      sent.push(m);

      return { id: `m${sent.length}`, driver: "test" };
    },
  };
};

const customer = (extra = {}) => ({
  email: PAT, name: "Pat Example", firstName: "Pat", lastName: "Example",
  phone: "", address: null, createdAt: made, lastOrderAt: null,
  marketing: true, marketingAt: made, marketingSource: "signup",
  ...extra,
});

const seeded = async (extra) => {
  const stores = testStores();

  await saveCustomer(stores, customer(extra));

  return stores;
};

const signIn = async (stores, now) => {
  const { sent, mail } = mailbox();

  await requestLink(stores, { email: PAT, next: "/account/" },
    { now, env, mail });

  const token = new URL(sent[0].text.match(/https:\S+/)[0])
    .searchParams.get("token");
  const res = await auth(new Request(
    `https://x/api/auth/verify?token=${token}`), { stores, env, now });

  return res.headers.get("set-cookie").match(/nff_session=([^;]+)/)[1];
};

const call = (stores, now, path, method, body, session) => account(
  new Request(`https://x${path}`, {
    method,
    headers: {
      "Content-Type": "application/json", "sec-fetch-site": "same-origin",
      cookie: `nff_session=${session}`,
    },
    body: JSON.stringify(body),
  }), { stores, env, now });

// The body the account page's Save sends (assets/scripts/account/
// main.js, saveProfile): every field, changed or not.
const pageSave = (over = {}) => ({
  firstName: "Pat", lastName: "Example", phone: "", marketing: true,
  reminders: { delivery: true }, ...over,
});

const last = async (stores) => lastInteraction(await getCustomer(stores, PAT));

describe("the interaction clock", () => {
  it("is the latest of the interaction, the last order and the record's " +
    "making", () => {
    assert.equal(lastInteraction(customer()), made);
    assert.equal(lastInteraction(customer({
      lastOrderAt: "2026-01-01T00:00:00.000Z",
    })), "2026-01-01T00:00:00.000Z");
    assert.equal(lastInteraction(customer({
      lastOrderAt: "2026-01-01T00:00:00.000Z",
      interaction: { at: "2026-03-01T00:00:00.000Z", kind: "badge" },
    })), "2026-03-01T00:00:00.000Z");
    assert.equal(lastInteraction(null), null);
  });

  it("never runs back, makes no record, and knows its kinds", async () => {
    const stores = await seeded();

    await noteInteraction(stores, PAT, "badge", { now: yearOn });
    await noteInteraction(stores, PAT, "account", { now: before });
    assert.equal(await last(stores), yearOn.toISOString());

    assert.equal(await noteInteraction(stores, "new@example.com", "sign-in",
      { now: yearOn }), null);
    assert.equal(await getCustomer(stores, "new@example.com"), null);

    await assert.rejects(noteInteraction(stores, PAT, "open", {
      now: yearOn,
    }), /Unknown interaction/);
    assert.deepEqual(KINDS.sort(), [
      "account", "badge", "email-click", "order", "sign-in", "sign-up",
    ]);
  });
});

describe("what counts as an interaction", () => {
  it("signing in", async () => {
    const stores = await seeded();

    await signIn(stores, before);

    const c = await getCustomer(stores, PAT);

    assert.equal(c.interaction.kind, "sign-in");
    assert.equal(lastInteraction(c), before.toISOString());
  });

  it("anything done while signed in", async () => {
    const stores = await seeded();
    const session = await signIn(stores, before);
    // The page's own save, with a phone added and farm news left on.
    const res = await call(stores, yearOn, "/api/account/profile", "PATCH",
      pageSave({ phone: "4015550100" }), session);

    assert.equal(res.status, 200);

    const c = await getCustomer(stores, PAT);

    assert.equal(c.interaction.kind, "account");
    assert.equal(lastInteraction(c), yearOn.toISOString());
  });

  it("turning farm news on while signed in", async () => {
    const stores = await seeded({ marketing: false });
    const session = await signIn(stores, before);

    await call(stores, yearOn, "/api/account/profile", "PATCH",
      { marketing: true }, session);
    assert.equal(await last(stores), yearOn.toISOString());
  });

  it("an order", async () => {
    const stores = await seeded();

    await touchCustomer(stores, { email: PAT, name: "Pat Example" }, yearOn,
      { orderId: "NFF-1" });
    assert.equal(await last(stores), yearOn.toISOString());
  });

  it("a market sale linked by the household's badge", async () => {
    const stores = await seeded();

    await noteInteraction(stores, PAT, "badge", { now: yearOn });
    assert.equal(await last(stores), yearOn.toISOString());
  });

  it("the confirmation link in the old list's email", async () => {
    const stores = await seeded({ marketing: false });
    const { sent, mail } = mailbox();

    await requestSubscribe(stores, { email: PAT }, { now: before, env, mail });

    const link = sent[0].text.match(/https:\S+confirm\S+/)[0];

    await newsHandle(new Request(link), {
      stores, env, now: yearOn, mail: mailbox().mail,
    });
    assert.equal(await last(stores), yearOn.toISOString());
  });
});

describe("what does not count", () => {
  it("an unsubscribe does not reset the inactivity clock", async () => {
    const stores = await seeded();
    // The one-click link every list email carries.
    const links = await unsubscribeLinks(stores, PAT, {
      env, now: new Date(made),
    });
    const res = await newsHandle(new Request(links.post, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "sec-fetch-site": "cross-site",
      },
      body: "List-Unsubscribe=One-Click",
    }), { stores, env, now: before });

    assert.equal(res.status, 200);

    const c = await getCustomer(stores, PAT);

    assert.equal(c.marketing, false);
    assert.equal(lastInteraction(c), made);
    assert.equal(quietDue(c, yearOn), true);
  });

  it("the public sign-up form: anyone can type any address", async () => {
    const stores = await seeded({ marketing: false });
    const res = await newsHandle(new Request(
      "https://x/api/news/subscribe", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "sec-fetch-site": "same-origin",
        },
        body: JSON.stringify({ email: PAT }),
      }), { stores, env, now: yearOn, mail: mailbox().mail });

    assert.equal(res.status, 200);
    assert.equal((await getCustomer(stores, PAT)).marketing, true);
    assert.equal(await last(stores), made);
  });

  it("turning farm news off with the account page's own save, which " +
    "sends every field", async () => {
    const stores = await seeded();
    const session = await signIn(stores, before);
    const res = await call(stores, before, "/api/account/profile", "PATCH",
      pageSave({ marketing: false }), session);

    assert.equal(res.status, 200);
    assert.equal((await getCustomer(stores, PAT)).marketing, false);
    assert.equal(await last(stores), made);
  });

  it("turning a reminder off with the page's own save", async () => {
    const stores = await seeded();
    const session = await signIn(stores, before);

    await call(stores, before, "/api/account/profile", "PATCH",
      pageSave({ reminders: { delivery: false } }), session);
    assert.equal(await last(stores), made);
  });

  it("signing in only to turn farm news off", async () => {
    const stores = await seeded();
    const session = await signIn(stores, before);

    assert.equal(await last(stores), before.toISOString());

    const res = await call(stores, before, "/api/account/profile", "PATCH",
      { marketing: false }, session);

    assert.equal(res.status, 200);
    assert.equal(await last(stores), made);
    assert.equal(quietDue(await getCustomer(stores, PAT), yearOn), true);
  });

  it("signing in only to turn a reminder off", async () => {
    const stores = await seeded({
      interaction: { at: "2026-01-01T00:00:00.000Z", kind: "badge" },
    });
    const session = await signIn(stores, before);

    await call(stores, before, "/api/account/profile", "PATCH",
      { reminders: { delivery: false } }, session);

    const c = await getCustomer(stores, PAT);

    assert.deepEqual(c.interaction,
      { at: "2026-01-01T00:00:00.000Z", kind: "badge" });
  });

  it("signing in only to delete: the record is gone", async () => {
    const stores = await seeded();
    const session = await signIn(stores, before);
    const res = await call(stores, before, "/api/account/delete", "POST",
      { email: PAT }, session);

    assert.equal(res.status, 200);
    assert.equal(await getCustomer(stores, PAT), null);
  });

  it("an opt-out keeps a sign-in that did something else", async () => {
    const stores = await seeded();
    const session = await signIn(stores, before);

    await call(stores, before, "/api/account/profile", "PATCH",
      { phone: "4015550100" }, session);
    await call(stores, before, "/api/account/profile", "PATCH",
      { marketing: false }, session);
    assert.equal(await last(stores), before.toISOString());
  });

  it("an opt-out in an older session leaves a newer sign-in", async () => {
    const stores = await seeded();
    const old = await signIn(stores, new Date("2026-08-01T12:00:00Z"));

    await signIn(stores, before);
    await call(stores, before, "/api/account/profile", "PATCH",
      { marketing: false }, old);
    assert.equal(await last(stores), before.toISOString());
  });

  it("names the changes and links that are someone leaving", () => {
    const on = customer();
    const off = customer({ marketing: false, reminders: { delivery: false } });
    const leaves = (body, c = on) => leavingChange(body, c);

    // What changed, against the record: only on-to-off is leaving.
    assert.equal(leaves({ marketing: false }), true);
    assert.equal(leaves({ reminders: { delivery: false } }), true);
    assert.equal(leaves(pageSave({ marketing: false })), true);
    assert.equal(leaves(pageSave({
      marketing: false, reminders: { delivery: false },
    })), true);
    assert.equal(leaves(pageSave({ firstName: " Pat " })), false,
      "a save that changed nothing");
    assert.equal(leaves(pageSave({ marketing: false, phone: "1" })), false);
    assert.equal(leaves(pageSave({ marketing: true }), off), false);
    assert.equal(leaves(pageSave({ marketing: false }), off), false);
    assert.equal(leaves({ reminders: { delivery: true } }, off), false);
    assert.equal(leaves({}), false);
    assert.equal(leaves(null), false);
    assert.equal(leavingChange({ marketing: false }, null), false);

    assert.equal(leavingLink(
      "https://northfosterfarm.com/news/unsubscribe/?token=x"), true);
    assert.equal(leavingLink(
      "https://northfosterfarm.com/api/news/unsubscribe?token=x"), true);
    assert.equal(leavingLink(
      "https://northfosterfarm.com/account/#settings"), true);
    assert.equal(leavingLink("https://northfosterfarm.com/order/"), false);
    assert.equal(leavingLink("not a link"), false);
  });
});

describe("quiet accounts", () => {
  it("are quiet after a year without interaction, not before", () => {
    assert.equal(INACTIVE_AFTER_YEARS, 1);
    assert.equal(quietDue(customer(), before), false);
    assert.equal(quietDue(customer(), yearOn), true);
  });

  it("come off farm news and get one notice, and are never deleted",
    async () => {
      const stores = await seeded();
      const { sent, mail } = mailbox();
      const r = await quietAccounts(stores, { env, mail, now: yearOn });

      assert.deepEqual(r, {
        due: [PAT], noticed: [PAT], failed: [], left: 0,
      });
      assert.equal(sent.length, 1);
      assert.equal(sent[0].to, PAT);
      assert.equal(sent[0].subject, "Your account is still here");
      assert.match(sent[0].text, /stopped sending you our Farm News/);
      assert.match(sent[0].text, /delete them/);
      assert.match(sent[0].text, /northfosterfarm\.com\/account\//);

      const c = await getCustomer(stores, PAT);

      assert.ok(c, "the record stays");
      assert.equal(c.marketing, false);
      assert.equal(c.marketingSource, "inactive");
      assert.equal(c.consent.at(-1).type, "inactivity");
      assert.equal(c.consent.at(-1).action, "out");
      assert.ok(CONSENT_TYPES.includes("inactivity"));
      assert.equal(c.quietNoticeAt, yearOn.toISOString());
      // The opt-out is not an interaction.
      assert.equal(lastInteraction(c), made);

      const again = await quietAccounts(stores, {
        env, mail, now: new Date("2027-06-01T12:00:00Z"),
      });

      assert.deepEqual(again.due, []);
      assert.equal(sent.length, 1);
      assert.ok(await getCustomer(stores, PAT));
    });

  it("leave out the farm news line for someone never on the list",
    async () => {
      const stores = await seeded({ marketing: false, marketingAt: null });
      const { sent, mail } = mailbox();

      await quietAccounts(stores, { env, mail, now: yearOn });
      assert.equal(sent.length, 1);
      assert.doesNotMatch(sent[0].text, /farm news/i);
    });

  it("start a new year with a new interaction, and a second quiet year " +
    "sends a second notice", async () => {
    const stores = await seeded();
    const { sent, mail } = mailbox();

    await quietAccounts(stores, { env, mail, now: yearOn });
    await noteInteraction(stores, PAT, "account",
      { now: new Date("2026-10-01T12:00:00Z") });
    assert.deepEqual((await quietAccounts(stores, {
      env, mail, now: new Date("2027-09-30T12:00:00Z"),
    })).due, []);
    assert.deepEqual((await quietAccounts(stores, {
      env, mail, now: new Date("2027-10-01T12:00:00Z"),
    })).noticed, [PAT]);
    assert.equal(sent.length, 2);
  });

  it("try a failed notice again, and a dry run changes nothing",
    async () => {
      const stores = await seeded();
      const dry = await quietAccounts(stores, {
        env, mail: mailbox().mail, now: yearOn, apply: false,
      });

      assert.deepEqual(dry, { due: [PAT], noticed: [], failed: [], left: 0 });
      assert.equal((await getCustomer(stores, PAT)).marketing, true);

      const down = await quietAccounts(stores, {
        env, mail: mailbox({ fail: true }).mail, now: yearOn,
      });

      assert.deepEqual(down.failed, [PAT]);
      assert.equal((await getCustomer(stores, PAT)).quietNoticeAt, undefined);

      const { sent, mail } = mailbox();

      await quietAccounts(stores, { env, mail, now: yearOn });
      assert.equal(sent.length, 1);
      // Taken off on the first try, it still says so.
      assert.match(sent[0].text, /stopped sending you our Farm News/);
    });

  it("get at most QUIET_PER_RUN notices a run, the longest quiet first",
    async () => {
      const stores = testStores();
      const quiet = (email, createdAt) => saveCustomer(stores, customer({
        email, createdAt, marketingAt: createdAt,
      }));

      assert.equal(QUIET_PER_RUN, 50);
      await quiet("c@example.com", "2025-08-03T12:00:00.000Z");
      await quiet("a@example.com", "2025-08-01T12:00:00.000Z");
      await quiet("b@example.com", "2025-08-02T12:00:00.000Z");

      const { sent, mail } = mailbox();
      const first = await quietAccounts(stores, {
        env, mail, now: yearOn, limit: 2,
      });

      assert.deepEqual(first.noticed, ["a@example.com", "b@example.com"]);
      assert.equal(first.left, 1);

      const next = await quietAccounts(stores, {
        env, mail, now: yearOn, limit: 2,
      });

      assert.deepEqual(next.noticed, ["c@example.com"]);
      assert.equal(next.left, 0);
      assert.equal(sent.length, 3);
    });

  it("are listed for the farm without being touched", async () => {
    const stores = await seeded();

    assert.deepEqual(await quietCustomers(stores, before), []);
    assert.deepEqual(await quietCustomers(stores, yearOn), [
      { email: PAT, lastInteraction: made, onFarmNews: true },
    ]);
    assert.equal((await getCustomer(stores, PAT)).marketing, true);
  });

  it("run once a day in the jobs", async () => {
    const stores = await seeded();
    const { sent, mail } = mailbox();
    const opts = { env: {}, mail, now: yearOn, realNow: yearOn };
    const first = await runJobs(stores, opts);

    assert.deepEqual(first.quiet, { noticed: 1, failed: 0, left: 0 });
    assert.equal(sent.filter((m) => m.to === PAT).length, 1);

    const second = await runJobs(stores, opts);

    assert.equal(second.quiet, null);
    assert.ok(await getCustomer(stores, PAT));
  });
});

describe("open tracking", () => {
  // D-189: never used. Resend sets it per domain (guide step
  // rs-no-open-tracking); no code may ask for it.
  it("is asked for nowhere in the functions", () => {
    const root = new URL("../netlify/functions/", import.meta.url);
    const files = readdirSync(root, { recursive: true })
      .filter((f) => f.endsWith(".mjs"));

    assert.ok(files.length > 10);
    for (const f of files) {
      const source = readFileSync(new URL(f, root), "utf8");

      assert.doesNotMatch(source, /open_?tracking|track_?opens/i, f);
    }
  });
});

describe("the notice", () => {
  it("has no open-tracking pixel", () => {
    const { html } = quietNotice(customer(), {
      accountUrl: "https://northfosterfarm.com/account/",
      links: {}, wasSubscribed: true,
    });

    assert.doesNotMatch(html, /<img[^>]+(width|height)="1"/);
  });
});
