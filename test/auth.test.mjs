import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  LINK_TTL, SESSION_TTL, createSession, requestLink, requestOrderLink,
  safeNext, sessionFrom, verifyToken,
} from "../netlify/functions/lib/auth.mjs";
import {
  getCustomer, getOrder, saveOrder,
} from "../netlify/functions/lib/records.mjs";
import { testStores } from "../netlify/functions/lib/store.mjs";
import { handle } from "../netlify/functions/auth.mjs";

const now = new Date("2026-10-06T13:00:00Z");
const env = { URL: "https://northfosterfarm.com" };

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

describe("requestLink", () => {
  it("mails a single-use link to a normalised address", async () => {
    const stores = testStores();
    const { sent, mail } = mailbox();
    const r = await requestLink(stores, { email: " Pat@Example.COM " }, {
      now, env, mail,
    });

    assert.equal(r.ok, true);
    assert.equal(r.email, "pat@example.com");
    assert.match(
      r.url, /^https:\/\/northfosterfarm.com\/api\/auth\/verify\?token=/
    );
    assert.equal(sent[0].to, "pat@example.com");
    assert.match(sent[0].text, new RegExp(tokenIn(r.url)));
  });

  it("rejects a bad address and rate-limits an eager one", async () => {
    const stores = testStores();
    const { mail } = mailbox();

    assert.equal((await requestLink(stores, { email: "nope" }, { mail })).ok,
      false);
    for (let i = 0; i < 3; i += 1) {
      const r = await requestLink(stores, { email: "pat@example.com" }, {
        now, env, mail,
      });

      assert.equal(r.ok, true, `link ${i + 1}`);
    }
    const fourth = await requestLink(stores, { email: "pat@example.com" }, {
      now, env, mail,
    });

    assert.deepEqual(fourth, { ok: false, reason: "rate" });

    const later = new Date(now.getTime() + 16 * 60_000);

    assert.equal((await requestLink(stores, { email: "pat@example.com" }, {
      now: later, env, mail,
    })).ok, true);
  });
});

describe("a link the farm mints", () => {
  it("counts against no one and lives as long as asked", async () => {
    const stores = testStores();
    const { sent, mail } = mailbox();
    const farm = { now, env, mail, send: false, limit: false, ttl: 3 * 60_000 };
    const links = [];

    for (let i = 0; i < 4; i += 1) {
      const r = await requestLink(stores, {
        email: "pat@example.com", next: "/account/orders/A/",
      }, farm);

      assert.equal(r.ok, true, `link ${i + 1}`);
      links.push(r.url);
    }
    assert.equal(sent.length, 0);

    // The public form still has its three.
    const pub = await requestLink(stores, { email: "pat@example.com" }, {
      now, env, mail,
    });

    assert.equal(pub.ok, true);

    const token = tokenIn(links[0]);
    const late = new Date(now.getTime() + 4 * 60_000);

    assert.equal((await verifyToken(stores, token, { now: late })).ok, false);
    assert.equal((await verifyToken(stores, tokenIn(links[1]), {
      now: new Date(now.getTime() + 2 * 60_000),
    })).next, "/account/orders/A/");
  });
});

describe("find my order", () => {
  const order = (id, status = "submitted", email = "pat@example.com") => ({
    id,
    status,
    submittedAt: now.toISOString(),
    customer: { name: "Pat Example", email, phone: "" },
    lines: [{ sku: "A", label: "Eggs (per dozen), Large", qty: 1,
      lineTotal: 7 }],
    totals: { subtotal: 700, discountAmount: 0, deliveryFee: 0, total: 700 },
    fulfilment: {
      method: "onfarm", date: "2026-10-08", state: "agreed",
      onfarm: { window: "morning" },
    },
    square: { invoiceId: `INV-${id}`, invoiceUrl: "https://pay/x" },
  });

  it("resends the invoice, with a link to the order, when the pair match",
    async () => {
      const stores = testStores();
      const { sent, mail } = mailbox();

      await saveOrder(stores, order("NFF-2610-K3WM"), now);
      const r = await requestOrderLink(stores, {
        email: " Pat@Example.com ", orderId: "nff-2610-k3wm",
      }, { now, env, mail });

      assert.deepEqual(r, { ok: true, matched: true, sent: "invoice" });
      assert.equal(sent.length, 1);
      assert.equal(sent[0].subject, "One more step: pay for your order");
      assert.match(sent[0].text, /Pay and confirm your order: https:\/\/pay/);

      const link = sent[0].text.match(/View or edit this order: (\S+)/)[1];
      const v = await verifyToken(stores, tokenIn(link), { now });

      assert.equal(v.ok, true);
      assert.equal(v.next, "/account/orders/NFF-2610-K3WM/");
      assert.equal((await getOrder(stores, "NFF-2610-K3WM")).emails[
        "invoiceResent-1"].id, "m1");
    });

  it("sends a plain sign-in link for a paid order, nothing for a mismatch",
    async () => {
      const stores = testStores();
      const { sent, mail } = mailbox();

      await saveOrder(stores, order("NFF-2610-K3WM", "paid"), now);
      const paid = await requestOrderLink(stores, {
        email: "pat@example.com", orderId: "NFF-2610-K3WM",
      }, { now, env, mail });

      assert.equal(paid.sent, "link");
      assert.match(sent[0].subject, /sign-in link/);
      assert.match(sent[0].text, /Sign in: https:\S+token=/);

      const wrong = await requestOrderLink(stores, {
        email: "other@example.com", orderId: "NFF-2610-K3WM",
      }, { now, env, mail });
      const missing = await requestOrderLink(stores, {
        email: "pat@example.com", orderId: "NFF-0000-XXXX",
      }, { now, env, mail });

      assert.deepEqual(wrong, { ok: true, matched: false });
      assert.deepEqual(missing, { ok: true, matched: false });
      assert.equal(sent.length, 1);
      assert.equal((await requestOrderLink(stores, {
        email: "nope", orderId: "NFF-2610-K3WM",
      }, { now, env, mail })).ok, false);
    });

  it("answers the endpoint the same way matched or not", async () => {
    const stores = testStores();
    const { sent, mail } = mailbox();
    const post = (body) => new Request("https://x/api/auth/request", {
      method: "POST",
      headers: {
        "Content-Type": "application/json", "sec-fetch-site": "same-origin",
      },
      body: JSON.stringify(body),
    });

    await saveOrder(stores, order("NFF-2610-K3WM"), now);
    const hit = await handle(post({
      email: "pat@example.com", orderId: "NFF-2610-K3WM",
    }), { stores, env, now, mail });
    const miss = await handle(post({
      email: "pat@example.com", orderId: "NFF-2610-ZZZZ",
    }), { stores, env, now, mail });

    assert.equal(hit.status, 200);
    assert.equal(miss.status, 200);
    assert.deepEqual(await hit.json(), await miss.json());
    assert.equal(sent.length, 1);
  });
});

describe("verifyToken", () => {
  it("works once, within the window", async () => {
    const stores = testStores();
    const { mail } = mailbox();
    const r = await requestLink(stores, {
      email: "pat@example.com", next: "/account/orders/",
    }, { now, env, mail });
    const token = tokenIn(r.url);
    const soon = new Date(now.getTime() + 60_000);

    assert.deepEqual(await verifyToken(stores, token, { now: soon }), {
      ok: true, email: "pat@example.com", next: "/account/orders/",
    });
    assert.equal((await verifyToken(stores, token, { now: soon })).reason,
      "unknown", "second use fails");
  });

  it("expires and refuses junk", async () => {
    const stores = testStores();
    const { mail } = mailbox();
    const r = await requestLink(stores, { email: "pat@example.com" }, {
      now, env, mail,
    });
    const late = new Date(now.getTime() + LINK_TTL + 1);

    assert.equal((await verifyToken(stores, tokenIn(r.url), { now: late }))
      .reason, "expired");
    assert.equal((await verifyToken(stores, "", { now })).reason, "invalid");
    assert.equal((await verifyToken(stores, "x".repeat(300), { now })).reason,
      "invalid");
  });

  it("only follows same-site paths", () => {
    assert.equal(safeNext("/account/orders/"), "/account/orders/");
    assert.equal(safeNext("https://evil.example/"), "/account/");
    assert.equal(safeNext("//evil.example/"), "/account/");
    assert.equal(safeNext(""), "/account/");
  });
});

describe("sessions", () => {
  it("create a customer record and read back from the cookie", async () => {
    const stores = testStores();
    const session = await createSession(stores, "Pat@Example.com", { now });
    const req = new Request("http://x/api/me", {
      headers: { cookie: `other=1; nff_session=${session.id}` },
    });
    const found = await sessionFrom(stores, req, { now });

    assert.equal(found.email, "pat@example.com");
    assert.equal(found.customer.email, "pat@example.com");
    assert.ok(await getCustomer(stores, "pat@example.com"));
  });

  it("expire and ignore unknown ids", async () => {
    const stores = testStores();
    const session = await createSession(stores, "pat@example.com", { now });
    const late = new Date(now.getTime() + SESSION_TTL + 1);
    const req = (id) => new Request("http://x/api/me", {
      headers: { cookie: `nff_session=${id}` },
    });

    assert.equal(await sessionFrom(stores, req(session.id), { now: late }),
      null);
    assert.equal(await sessionFrom(stores, req("nope"), { now }), null);
    assert.equal(await sessionFrom(stores, new Request("http://x/"), { now }),
      null);
  });
});

describe("the auth endpoints", () => {
  const post = (path, body, headers = {}) => new Request(`https://x${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "sec-fetch-site": "same-origin",
      ...headers,
    },
    body: JSON.stringify(body),
  });

  it("request, verify, me, sign out", async () => {
    const stores = testStores();
    const { sent, mail } = mailbox();
    const asked = await handle(post("/api/auth/request", {
      email: "pat@example.com", next: "/account/",
    }), { stores, env, now, mail });

    assert.equal(asked.status, 200);
    assert.equal(sent.length, 1);

    const token = tokenIn(sent[0].text.match(/https:\S+/)[0]);
    const verified = await handle(
      new Request(`https://x/api/auth/verify?token=${token}`),
      { stores, env, now }
    );

    assert.equal(verified.status, 302);
    assert.equal(verified.headers.get("location"), "/account/");

    const cookie = verified.headers.get("set-cookie");

    assert.match(
      cookie,
      /^nff_session=[A-Za-z0-9_-]+; Path=\/; HttpOnly; Secure; SameSite=Lax/
    );

    const id = cookie.match(/nff_session=([^;]+)/)[1];
    const me = await handle(new Request("https://x/api/me", {
      headers: { cookie: `nff_session=${id}` },
    }), { stores, env, now });
    const who = await me.json();

    assert.equal(who.signedIn, true);
    assert.equal(who.customer.email, "pat@example.com");

    const out = await handle(post("/api/auth/signout", {}, {
      cookie: `nff_session=${id}`,
    }), { stores, env, now });

    assert.equal(out.status, 204);
    assert.match(out.headers.get("set-cookie"), /Max-Age=0/);

    const gone = await (await handle(new Request("https://x/api/me", {
      headers: { cookie: `nff_session=${id}` },
    }), { stores, env, now })).json();

    assert.equal(gone.signedIn, false);
  });

  it("sends a bad or used link back to the login page", async () => {
    const stores = testStores();
    const res = await handle(
      new Request("https://x/api/auth/verify?token=nope"), { stores, env, now }
    );

    assert.equal(res.status, 302);
    assert.equal(res.headers.get("location"), "/login/?error=unknown");
  });

  it("answers 200 to a rate-limited request and 422 to junk", async () => {
    const stores = testStores();
    const { sent, mail } = mailbox();

    for (let i = 0; i < 4; i += 1) {
      const res = await handle(post("/api/auth/request", {
        email: "pat@example.com",
      }), { stores, env, now, mail });

      assert.equal(res.status, 200);
    }
    assert.equal(sent.length, 3);

    const junk = await handle(post("/api/auth/request", { email: "x" }), {
      stores, env, now, mail,
    });

    assert.equal(junk.status, 422);
  });

  it("refuses cross-site posts and the honeypot", async () => {
    const stores = testStores();
    const { sent, mail } = mailbox();
    const cross = await handle(post("/api/auth/request", {
      email: "pat@example.com",
    }, { "sec-fetch-site": "cross-site" }), { stores, env, now, mail });

    assert.equal(cross.status, 403);

    const bot = await handle(post("/api/auth/request", {
      email: "pat@example.com", website: "spam",
    }), { stores, env, now, mail });

    assert.equal(bot.status, 200);
    assert.equal(sent.length, 0);
  });
});
