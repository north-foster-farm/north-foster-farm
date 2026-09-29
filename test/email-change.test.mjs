import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { handle as account } from "../netlify/functions/account.mjs";
import { handle as auth } from "../netlify/functions/auth.mjs";
import { createSession } from "../netlify/functions/lib/auth.mjs";
import {
  finishEmailChange, requestEmailChange,
} from "../netlify/functions/lib/email-change.mjs";
import {
  getCustomer, getOrder, saveCustomer, saveOrder,
} from "../netlify/functions/lib/records.mjs";
import { testStores } from "../netlify/functions/lib/store.mjs";

const now = new Date("2026-10-05T13:00:00Z");
const env = { URL: "https://northfosterfarm.com" };
const OLD = "pat@example.com";
const NEW = "pat.new@example.com";

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

// Square and Resend as the rename sees them.
const outside = () => {
  const calls = [];

  return {
    calls,
    square: {
      renameCustomerEmail: async (from, to, { apply = false } = {}) => {
        calls.push(["square", from, to, apply]);

        return ["CUST-1"];
      },
    },
    news: {
      moveContact: async (from, to, { apply = false } = {}) => {
        calls.push(["resend", from, to, apply]);

        return "moved";
      },
    },
  };
};

const seed = async () => {
  const stores = testStores();

  await saveCustomer(stores, { email: OLD, name: "Pat", avatar: "chick" });
  await saveOrder(stores, {
    id: "A", status: "paid", submittedAt: now.toISOString(),
    customer: { name: "Pat Example", email: OLD, phone: "" },
    lines: [], totals: { total: 700 },
    fulfilment: { method: "onfarm", date: "2026-10-07" },
  }, now);

  return stores;
};

const linkIn = (m) => m.text.match(/https:\S+/)[0];
const tokenIn = (m) => new URL(linkIn(m)).searchParams.get("token");

describe("asking to change the email (#240)", () => {
  it("mails a link to the new address and changes nothing yet",
    async () => {
      const stores = await seed();
      const { sent, mail } = mailbox();
      const r = await requestEmailChange(stores, { email: OLD },
        " Pat.New@Example.com ", { now, env, mail });

      assert.deepEqual(r, { ok: true, email: NEW });
      assert.equal(sent.length, 1);
      assert.equal(sent[0].to, NEW);
      assert.match(sent[0].subject, /Confirm your new email/);
      assert.match(sent[0].text, /Until you do, nothing changes/);
      assert.ok(await getCustomer(stores, OLD));
      assert.equal(await getCustomer(stores, NEW), null);
    });

  it("refuses a bad address, the same one, and one with an account",
    async () => {
      const stores = await seed();
      const { sent, mail } = mailbox();
      const ask = (email) => requestEmailChange(stores, { email: OLD },
        email, { now, env, mail });

      await saveCustomer(stores, { email: "taken@example.com", name: "T" });
      assert.match((await ask("nope")).errors.email, /doesn't look right/);
      assert.match((await ask(" PAT@example.com")).errors.email,
        /already your email/);
      assert.match((await ask("taken@example.com")).errors.email,
        /already has an account/);
      assert.equal((await ask("nope")).status, 422);
      assert.equal(sent.length, 0);
    });

  it("sends no more links than sign-in does", async () => {
    const stores = await seed();
    const { sent, mail } = mailbox();
    const ask = () => requestEmailChange(stores, { email: OLD }, NEW, {
      now, env, mail,
    });

    for (let i = 0; i < 3; i++) assert.equal((await ask()).ok, true);
    assert.match((await ask()).errors.email, /a few links already/);
    assert.equal(sent.length, 3);
  });
});

describe("following the link (#240)", () => {
  it("moves the account with the CLI's rename and tells the old address",
    async () => {
      const stores = await seed();
      const { sent, mail } = mailbox();
      const { calls, square, news } = outside();
      const r = await finishEmailChange(stores, {
        email: NEW, changeFrom: OLD,
      }, { now, env, mail, square, news });

      assert.deepEqual(r, { ok: true, email: NEW });
      assert.equal(await getCustomer(stores, OLD), null);
      assert.equal((await getCustomer(stores, NEW)).avatar, "chick");
      assert.equal((await getOrder(stores, "A")).customer.email, NEW);
      assert.deepEqual(calls.map(([k, , , apply]) => [k, apply]),
        [["resend", true], ["square", true]]);
      assert.equal(sent.length, 1);
      assert.equal(sent[0].to, OLD);
      assert.match(sent[0].subject, /was changed/);
      assert.match(sent[0].text, new RegExp(`signs in with ${NEW}`));
      assert.match(sent[0].text, /contact us right away/);
      // Pat never subscribed to farm news, so the notice doesn't
      // claim it will follow (copy's finding on #240).
      assert.doesNotMatch(sent[0].text, /farm news/);
    });

  it("mentions farm news moving only for a subscriber", async () => {
    const stores = await seed();
    const { sent, mail } = mailbox();
    const { square, news } = outside();

    await saveCustomer(stores, {
      email: OLD, name: "Pat", avatar: "chick", marketing: true,
    });

    const r = await finishEmailChange(stores, {
      email: NEW, changeFrom: OLD,
    }, { now, env, mail, square, news });

    assert.equal(r.ok, true);
    assert.match(sent[0].text, /farm news/);
  });

  it("refuses once the new address has an account of its own",
    async () => {
      const stores = await seed();
      const { sent, mail } = mailbox();
      const { square, news } = outside();

      await saveCustomer(stores, { email: NEW, name: "Someone" });

      const r = await finishEmailChange(stores, {
        email: NEW, changeFrom: OLD,
      }, { now, env, mail, square, news });

      assert.deepEqual(r, { ok: false, reason: "change-taken" });
      assert.ok(await getCustomer(stores, OLD));
      assert.equal(sent.length, 0);
    });

  it("fails plainly once the old account is gone", async () => {
    const stores = testStores();
    const { square, news } = outside();

    assert.deepEqual(await finishEmailChange(stores, {
      email: NEW, changeFrom: OLD,
    }, { now, env, mail: mailbox().mail, square, news }), {
      ok: false, reason: "change-failed",
    });
  });
});

describe("the endpoints (#240)", () => {
  const post = (path, body, cookie) => new Request(`https://x${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "sec-fetch-site": "same-origin",
      Cookie: `nff_session=${cookie}`,
    },
    body: JSON.stringify(body),
  });
  const verifyPost = (token) => new Request("https://x/api/auth/verify", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "sec-fetch-site": "same-origin",
    },
    body: JSON.stringify({ token }),
  });

  it("a GET on a change link only peeks: it changes nothing", async () => {
    const stores = await seed();
    const { sent, mail } = mailbox();
    const old = await createSession(stores, OLD, { now });

    await account(post("/api/account/email", { email: NEW }, old.id),
      { stores, env, now, mail });

    const token = tokenIn(sent[0]);
    const res = await auth(
      new Request(`https://x/api/auth/verify?token=${token}`),
      { stores, env, now, mail }
    );

    assert.equal(res.status, 302);
    assert.equal(res.headers.get("location"),
      `/login/#confirm=${token}&email=${encodeURIComponent(NEW)}`);
    assert.equal(res.headers.get("set-cookie"), null);
    assert.ok(await getCustomer(stores, OLD));
    assert.equal(await getCustomer(stores, NEW), null);
    assert.ok(await stores.auth.get(`session/${old.id}`));

    // The token still works: the GET didn't spend it.
    const confirmed = await auth(verifyPost(token), { stores, env, now, mail,
      fetchImpl: async () => { throw new Error("offline"); } });

    assert.equal((await confirmed.json()).ok, true);
  });

  it("ask on the account page, confirm the link, arrive signed in",
    async () => {
      const stores = await seed();
      const { sent, mail } = mailbox();
      const old = await createSession(stores, OLD, { now });
      const asked = await account(post("/api/account/email", { email: NEW },
        old.id), { stores, env, now, mail });

      assert.equal(asked.status, 200);
      assert.equal((await asked.json()).email, NEW);

      // Square and Resend can't be reached here: the site's records
      // move all the same.
      const res = await auth(verifyPost(tokenIn(sent[0])), {
        stores, env, now, mail,
        fetchImpl: async () => { throw new Error("offline"); },
      });

      assert.equal(res.status, 200);

      const body = await res.json();

      assert.equal(body.ok, true);
      assert.equal(body.next, "/account/?email=changed#settings");
      assert.match(res.headers.get("set-cookie"), /^nff_session=/);
      assert.equal(await getCustomer(stores, OLD), null);
      assert.ok(await getCustomer(stores, NEW));
      assert.equal(await stores.auth.get(`session/${old.id}`), null,
        "the old session ended");
      assert.equal(sent[1].to, OLD);

      // The token was spent: following it again fails.
      const again = await auth(verifyPost(tokenIn(sent[0])),
        { stores, env, now, mail });

      assert.equal((await again.json()).reason, "unknown");
    });

  it("send a refused move back as a reason, and change nothing",
    async () => {
      const stores = await seed();
      const { sent, mail } = mailbox();
      const old = await createSession(stores, OLD, { now });

      await account(post("/api/account/email", { email: NEW }, old.id),
        { stores, env, now, mail });
      await saveCustomer(stores, { email: NEW, name: "Someone" });

      const res = await auth(verifyPost(tokenIn(sent[0])),
        { stores, env, now, mail });

      assert.deepEqual(await res.json(),
        { ok: false, reason: "change-taken" });
      assert.equal(res.headers.get("set-cookie"), null);
      assert.ok(await getCustomer(stores, OLD));
      assert.ok(await stores.auth.get(`session/${old.id}`));
    });

  it("need a session to ask", async () => {
    const res = await account(post("/api/account/email", { email: NEW },
      "nope"), { stores: await seed(), env, now });

    assert.equal(res.status, 401);
  });

  it("limits requests per account, even to different addresses",
    async () => {
      const stores = await seed();
      const { mail } = mailbox();
      const old = await createSession(stores, OLD, { now });
      const ask = (to) => account(post("/api/account/email", { email: to },
        old.id), { stores, env, now, mail });

      assert.equal((await ask("a1@example.com")).status, 200);
      assert.equal((await ask("a2@example.com")).status, 200);
      assert.equal((await ask("a3@example.com")).status, 200);

      const blocked = await ask("a4@example.com");

      assert.equal(blocked.status, 422);
      assert.match((await blocked.json()).errors.email,
        /a few links already/);
    });

  it("limits requests per IP across accounts", async () => {
    const stores = await seed();
    const { mail } = mailbox();
    const pat = await createSession(stores, OLD, { now });

    await saveCustomer(stores, { email: "other@example.com", name: "O" });
    const other = await createSession(stores, "other@example.com", { now });
    const withIp = (session, to) => account(
      post("/api/account/email", { email: to }, session),
      { stores, env, now, mail, ip: "10.0.0.1" },
    );

    assert.equal((await withIp(pat.id, "b1@example.com")).status, 200);
    assert.equal((await withIp(other.id, "b2@example.com")).status, 200);
    assert.equal((await withIp(pat.id, "b3@example.com")).status, 200);

    // The IP is shared, so a fourth request is blocked even though
    // neither account has hit its own limit.
    const blocked = await withIp(other.id, "b4@example.com");

    assert.equal(blocked.status, 422);
    assert.match((await blocked.json()).errors.email,
      /a few links already/);
  });

  it("voids an earlier change link once a new one is sent", async () => {
    const stores = await seed();
    const { sent, mail } = mailbox();
    const old = await createSession(stores, OLD, { now });

    await account(post("/api/account/email", { email: NEW }, old.id),
      { stores, env, now, mail });
    const firstToken = tokenIn(sent[0]);

    await account(post("/api/account/email",
      { email: "later@example.com" }, old.id), { stores, env, now, mail });

    const res = await auth(verifyPost(firstToken), { stores, env, now, mail });

    assert.deepEqual(await res.json(), { ok: false, reason: "unknown" });
  });
});
