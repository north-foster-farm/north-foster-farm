// Maintenance mode (#267): what it blocks, what keeps running, and
// the switch itself.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { handle as accountApi } from "../netlify/functions/account.mjs";
import { handle as authApi } from "../netlify/functions/auth.mjs";
import {
  createSession, requestLink, sessionKey,
} from "../netlify/functions/lib/auth.mjs";
import { readMark } from "../netlify/functions/lib/health.mjs";
import { runJobs } from "../netlify/functions/lib/jobs.mjs";
import {
  MESSAGE, gate, links, readState, rotate, setState,
} from "../netlify/functions/lib/maintenance.mjs";
import {
  getCustomer, getOrder, saveCustomer, saveOrder,
} from "../netlify/functions/lib/records.mjs";
import { testStores } from "../netlify/functions/lib/store.mjs";
import { handle as maintenanceApi } from "../netlify/functions/maintenance.mjs";
import { handle as newsApi } from "../netlify/functions/news.mjs";
import { handle as ordersApi } from "../netlify/functions/orders.mjs";
import {
  handle as squareHook, signature,
} from "../netlify/functions/square-webhook.mjs";
import { instant } from "../assets/scripts/order/lib/zoned.mjs";
import { MORNING, SCHEDULE } from "./schedule-fixture.mjs";

const now = instant("2026-10-06", 9, 0, "America/New_York");
const KEY = "0f7c1e3a-9c9b-4b3a-8e9d-1a2b3c4d5e6f";
const SKU = "NFF-CHK-WHL-0350-0400";
const SECRET = "test-maintenance-secret";
const env = {
  ADMIN_EMAILS: "james@example.com, jim@example.com",
  SITE_URL: "https://staging.example.com",
  SITE_CONTEXT: "branch-deploy",
  MAINTENANCE_SECRET: SECRET,
  PICKUP_SCHEDULE: SCHEDULE,
};

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

const on = async (stores, mail) => setState(stores, true, {
  by: "test", env, now, mail,
});

const orderBody = (overrides = {}) => ({
  idempotencyKey: KEY,
  attempt: 1,
  customer: {
    firstName: "Pat", lastName: "Example", email: "pat@example.com",
    phone: "401-555-0100", contact: "call",
  },
  lines: [{ sku: SKU, qty: 2 }],
  fulfilment: {
    method: "onfarm", date: "2026-10-07", onfarm: { window: MORNING },
  },
  claimedTotal: 5500,
  payment: { method: "card", sourceId: "cnon:tok" },
  ...overrides,
});

const post = (path, payload, headers = {}) => new Request(
  `https://x${path}`,
  {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(payload),
  }
);

const fakes = () => {
  const calls = [];

  return {
    calls,
    square: {
      createOrder: async (order, key) => {
        calls.push(["order", key]);

        return { squareOrderId: "SQO", customerId: "CUST" };
      },
      createPayment: async (args) => {
        calls.push(["payment", args.key]);

        return {
          squarePaymentId: "PAY", status: "COMPLETED",
          receiptUrl: "https://sq/receipt", brand: "VISA", last4: "4242",
          wallet: null,
        };
      },
      cancelOrder: async (id) => ({ id, cancelled: true }),
    },
    paypal: {
      createOrder: async (order, key) => {
        calls.push(["pp-create", key]);

        return { paypalOrderId: "PPO" };
      },
      captureOrder: async (id, key) => {
        calls.push(["pp-capture", key]);

        return {
          paypalOrderId: id, paypalCaptureId: "CAP", status: "COMPLETED",
          amount: 5500, payer: { email: "pat@venmo", name: "Pat" },
        };
      },
    },
  };
};

const order = (stores, payload, fake, extra = {}) => ordersApi(
  post("/api/orders", payload), {
    stores, env, now, square: fake.square, paypal: fake.paypal,
    sleep: async () => {}, ...extra,
  }
);

describe("the switch", () => {
  it("is off until flipped, and says the farm's words exactly", async () => {
    const stores = testStores();

    assert.equal((await readState(stores)).on, false);
    assert.equal(await gate(stores), null);
    assert.equal(MESSAGE, "Our site is currently under maintenance. " +
      "Online ordering and account access are temporarily unavailable, " +
      "but we'll be up and running again soon. We apologize for the " +
      "inconvenience.");
    assert.doesNotMatch(MESSAGE, /call|text|email|phone/i);
  });

  it("emails the farm on every flip and on none that changes nothing",
    async () => {
      const stores = testStores();
      const { sent, mail } = mailbox();

      assert.equal((await on(stores, mail)).changed, true);
      assert.equal((await on(stores, mail)).changed, false);
      await setState(stores, false, { by: "test", env, now, mail });
      await setState(stores, false, { by: "test", env, now, mail });

      assert.equal(sent.length, 2);
      assert.deepEqual(sent[0].to, ["james@example.com", "jim@example.com"]);
      assert.match(sent[0].subject, /ON/);
      assert.match(sent[0].subject, /branch-deploy/);
      assert.match(sent[1].subject, /OFF/);
    });

  it("keeps the site open when the setting cannot be read", async () => {
    const stores = testStores();

    stores.jobs.get = async () => {
      throw new Error("blobs down");
    };

    assert.equal(await gate(stores), null);
  });

  it("answers a blocked API call with 503 and the message", async () => {
    const stores = testStores();

    await on(stores, mailbox().mail);

    const res = await gate(stores);
    const data = await res.json();

    assert.equal(res.status, 503);
    assert.equal(data.maintenance, true);
    assert.equal(data.message, MESSAGE);
    assert.equal(res.headers.get("retry-after"), "300");
  });
});

describe("ordering under maintenance", () => {
  it("refuses a new order and takes no money", async () => {
    const stores = testStores();
    const fake = fakes();

    await on(stores, mailbox().mail);

    const res = await order(stores, orderBody(), fake);

    assert.equal(res.status, 503);
    assert.equal((await res.json()).message, MESSAGE);
    assert.deepEqual(fake.calls, []);
    assert.equal(await getOrder(stores, "anything"), null);
  });

  it("refuses starting a Venmo order", async () => {
    const stores = testStores();
    const fake = fakes();

    await on(stores, mailbox().mail);

    const res = await order(stores, orderBody({
      payment: { method: "venmo", stage: "create" },
    }), fake);

    assert.equal(res.status, 503);
    assert.deepEqual(fake.calls, []);
  });

  it("does not count a refused order against the rate limit", async () => {
    const stores = testStores();
    const fake = fakes();

    await on(stores, mailbox().mail);

    for (let i = 0; i < 15; i += 1) {
      const res = await order(stores, orderBody(), fake, { ip: "9.9.9.9" });

      assert.equal(res.status, 503, `try ${i + 1}`);
    }
  });

  it("takes an order again once maintenance is off", async () => {
    const stores = testStores();
    const fake = fakes();

    await on(stores, mailbox().mail);
    await setState(stores, false, {
      by: "test", env, now, mail: mailbox().mail,
    });

    assert.equal((await order(stores, orderBody(), fake)).status, 200);
  });

  it("records a payment taken just before the flip", async () => {
    const stores = testStores();
    const fake = fakes();
    const first = await order(stores, orderBody(), fake);
    const paid = await first.json();

    assert.equal(first.status, 200);
    await on(stores, mailbox().mail);

    const saved = await getOrder(stores, paid.orderId);

    assert.equal(saved.status, "paid");
  });

  it("answers a paid submission's retry with its record", async () => {
    const stores = testStores();
    const fake = fakes();
    const paid = await (await order(stores, orderBody(), fake)).json();

    await on(stores, mailbox().mail);

    const again = await order(stores, orderBody(), fake);

    assert.equal(again.status, 200);
    assert.equal((await again.json()).orderId, paid.orderId);
    assert.equal(fake.calls.filter((c) => c[0] === "payment").length, 1);
  });

  it("finishes a Venmo capture the customer already approved", async () => {
    const stores = testStores();
    const fake = fakes();
    const create = await order(stores, orderBody({
      payment: { method: "venmo", stage: "create" },
    }), fake);

    assert.equal(create.status, 200);
    await on(stores, mailbox().mail);

    const capture = await order(stores, orderBody({
      payment: { method: "venmo", stage: "capture", paypalOrderId: "PPO" },
    }), fake);
    const done = await capture.json();

    assert.equal(capture.status, 200);
    assert.equal((await getOrder(stores, done.orderId)).status, "paid");
  });
});

const customerOf = (email) => ({
  email, name: "Pat Example", firstName: "Pat", lastName: "Example",
  phone: "", avatar: null, discountGroup: null, address: null,
  createdAt: "2026-09-01T00:00:00.000Z", lastOrderAt: null,
});

const signedIn = async (stores) => {
  await saveCustomer(stores, customerOf("pat@example.com"));
  await saveOrder(stores, {
    id: "NFF-2610-AAAAAA", status: "paid", submittedAt: now.toISOString(),
    paidAt: now.toISOString(),
    customer: { name: "Pat Example", email: "pat@example.com", phone: "" },
    lines: [], totals: { subtotal: 0, total: 0 },
    fulfilment: { method: "delivery", date: "2026-10-08" },
    payment: { via: "square", method: "card" },
  });

  const session = await createSession(stores, "pat@example.com", { now });

  return { cookie: `nff_session=${session.id}`, id: session.id };
};

const account = (stores, method, path, payload, cookie) => accountApi(
  new Request(`https://x${path}`, {
    method,
    headers: {
      "Content-Type": "application/json", cookie, "sec-fetch-site":
        "same-origin",
    },
    ...(payload ? { body: JSON.stringify(payload) } : {}),
  }), { stores, env, now }
);

describe("the account area under maintenance", () => {
  const routes = [
    ["GET", "/api/account/orders", null],
    ["POST", "/api/account/orders/NFF-2610-AAAAAA/cancel", {}],
    ["POST", "/api/account/orders/NFF-2610-AAAAAA/change", {}],
    ["POST", "/api/account/orders/NFF-2610-AAAAAA/edit", {}],
    ["POST", "/api/account/orders/NFF-2610-AAAAAA/return", {}],
    ["PATCH", "/api/account/profile", { firstName: "Sam" }],
    ["PUT", "/api/account/address", {}],
    ["POST", "/api/account/support", { subject: "Hi", message: "Hi" }],
    ["POST", "/api/account/delete", { confirm: true }],
  ];

  for (const [method, path, payload] of routes) {
    it(`refuses ${method} ${path} and changes nothing`, async () => {
      const stores = testStores();
      const { cookie } = await signedIn(stores);

      await on(stores, mailbox().mail);

      const res = await account(stores, method, path, payload, cookie);

      assert.equal(res.status, 503);
      assert.equal((await res.json()).message, MESSAGE);
      assert.equal((await getOrder(stores, "NFF-2610-AAAAAA")).status,
        "paid");
      assert.equal((await getCustomer(stores, "pat@example.com")).firstName,
        "Pat");
    });
  }

  it("does not end a session, and carries on when maintenance ends",
    async () => {
      const stores = testStores();
      const { cookie, id } = await signedIn(stores);

      await on(stores, mailbox().mail);
      await account(stores, "GET", "/api/account/orders", null, cookie);

      assert.ok(await stores.auth.get(sessionKey(id)));

      await setState(stores, false, {
        by: "test", env, now, mail: mailbox().mail,
      });

      const res = await account(stores, "GET", "/api/account/orders", null,
        cookie);

      assert.equal(res.status, 200);
    });
});

describe("sign-in and sign-up under maintenance", () => {
  const auth = (stores, req) => authApi(req, { stores, env, now });

  it("refuses a sign-in request and sends no link", async () => {
    const stores = testStores();
    const { sent, mail } = mailbox();

    await on(stores, mailbox().mail);

    const res = await authApi(post("/api/auth/request", {
      email: "pat@example.com", next: "/account/",
    }), { stores, env, now, mail });

    assert.equal(res.status, 503);
    assert.equal(sent.length, 0);
  });

  it("shows a page for a sign-in link and keeps the link alive",
    async () => {
      const stores = testStores();
      const r = await requestLink(stores, {
        email: "pat@example.com", next: "/account/",
      }, { now, env, send: false });
      const verify = () => auth(stores, new Request(r.url));

      await on(stores, mailbox().mail);

      const blocked = await verify();

      assert.equal(blocked.status, 503);
      assert.match(blocked.headers.get("content-type"), /text\/html/);
      assert.match(await blocked.text(), /under maintenance/);

      await setState(stores, false, {
        by: "test", env, now, mail: mailbox().mail,
      });
      assert.equal((await verify()).status, 302);
    });

  it("still signs out", async () => {
    const stores = testStores();
    const { cookie } = await signedIn(stores);

    await on(stores, mailbox().mail);

    const res = await auth(stores, new Request("https://x/api/auth/signout", {
      method: "POST", headers: { cookie, "sec-fetch-site": "same-origin" },
    }));

    assert.equal(res.status, 204);
  });

  it("tells the pages through /api/me, signed in or not", async () => {
    const stores = testStores();
    const { cookie } = await signedIn(stores);
    const me = async (headers = {}) => (await auth(
      stores, new Request("https://x/api/me", { headers })
    )).json();

    assert.equal((await me({ cookie })).maintenance, undefined);
    await on(stores, mailbox().mail);

    const inside = await me({ cookie });
    const outside = await me();

    assert.equal(inside.signedIn, true);
    assert.equal(inside.maintenance, true);
    assert.equal(inside.message, MESSAGE);
    assert.equal(outside.signedIn, false);
    assert.equal(outside.maintenance, true);
  });
});

describe("farm-news sign-ups under maintenance", () => {
  const news = (stores, req, mail) => newsApi(req, {
    stores, env, now, ...(mail ? { mail } : {}),
  });

  it("refuses a sign-up, sends nothing and saves no one", async () => {
    const stores = testStores();
    const { sent, mail } = mailbox();

    await on(stores, mailbox().mail);

    const res = await news(stores, post("/api/news/subscribe", {
      email: "new@example.com",
    }, { "sec-fetch-site": "same-origin" }), mail);

    assert.equal(res.status, 503);
    assert.equal(sent.length, 0);
    assert.equal(await getCustomer(stores, "new@example.com"), null);
  });

  it("shows a page for a confirm link", async () => {
    const stores = testStores();

    await on(stores, mailbox().mail);

    const res = await news(stores, new Request(
      "https://x/api/news/confirm?token=abc"
    ));

    assert.equal(res.status, 503);
    assert.match(await res.text(), /under maintenance/);
  });

  it("still unsubscribes", async () => {
    const stores = testStores();

    await on(stores, mailbox().mail);

    const res = await news(stores, post("/api/news/unsubscribe?token=bad", {}));

    assert.equal(res.status, 404, "an unknown token, not maintenance");
  });
});

describe("what keeps running under maintenance", () => {
  it("takes a Square webhook", async () => {
    const stores = testStores();
    const body = JSON.stringify({ type: "payment.updated" });
    const hookEnv = {
      ...env, SQUARE_WEBHOOK_SIGNATURE_KEY: "k",
      SQUARE_WEBHOOK_URL: "https://x/api/square/webhook",
    };

    await on(stores, mailbox().mail);

    const res = await squareHook(new Request("https://x/api/square/webhook", {
      method: "POST",
      headers: {
        "x-square-hmacsha256-signature": signature(
          "k", "https://x/api/square/webhook", body
        ),
      },
      body,
    }), { stores, env: hookEnv, now });

    assert.equal(res.status, 200);
    assert.ok(await readMark(stores, "webhook"));
  });

  it("runs the scheduled jobs", async () => {
    const stores = testStores();

    await on(stores, mailbox().mail);

    const report = await runJobs(stores, { env, now, mail: mailbox().mail });

    assert.deepEqual(report.errors || [], []);
  });
});

describe("the signed links", () => {
  const call = (stores, method, path, extra = {}) => maintenanceApi(
    new Request(`https://x${path}`, {
      method, headers: { "sec-fetch-site": "same-origin" },
    }), { stores, env, now, ...extra }
  );
  const pathOf = (url) => url.replace("https://staging.example.com", "");

  it("show a confirm page and flip nothing on GET", async () => {
    const stores = testStores();
    const { sent, mail } = mailbox();
    const res = await call(stores, "GET", pathOf(links(env, 0).on), { mail });

    assert.equal(res.status, 200);
    assert.match(await res.text(), /Turn maintenance ON/);
    assert.equal((await readState(stores)).on, false);
    assert.equal(sent.length, 0);
  });

  it("flip on a POST and email the farm", async () => {
    const stores = testStores();
    const { sent, mail } = mailbox();
    const res = await call(stores, "POST", pathOf(links(env, 0).on), { mail });

    assert.equal(res.status, 200);
    assert.equal((await readState(stores)).on, true);
    assert.equal((await readState(stores)).by, "signed link");
    assert.equal(sent.length, 1);

    const off = await call(stores, "POST", pathOf(links(env, 0).off), { mail });

    assert.equal(off.status, 200);
    assert.equal((await readState(stores)).on, false);
    assert.equal(sent.length, 2);
  });

  it("refuse a wrong signature, a missing one and a cross-site POST",
    async () => {
      const stores = testStores();

      for (const path of [
        "/api/maintenance/on?sig=nope", "/api/maintenance/on",
        `${pathOf(links(env, 0).off).replace("/off", "/on")}`,
      ]) {
        assert.equal((await call(stores, "POST", path)).status, 404, path);
      }

      const cross = await maintenanceApi(new Request(
        `https://x${pathOf(links(env, 0).on)}`,
        { method: "POST", headers: { "sec-fetch-site": "cross-site" } }
      ), { stores, env, now });

      assert.equal(cross.status, 404);
      assert.equal((await readState(stores)).on, false);
    });

  it("do nothing without MAINTENANCE_SECRET", async () => {
    const stores = testStores();
    const res = await call(stores, "POST", pathOf(links(env, 0).on), {
      env: { ...env, MAINTENANCE_SECRET: "" },
    });

    assert.equal(res.status, 404);
    assert.equal((await readState(stores)).on, false);
  });

  it("die when rotated", async () => {
    const stores = testStores();
    const old = pathOf(links(env, 0).on);

    await rotate(stores, { now });

    assert.equal((await call(stores, "POST", old)).status, 404);
    assert.equal((await call(stores, "POST", pathOf(links(env, 1).on)))
      .status, 200);
  });

  it("lock out an address after ten wrong guesses", async () => {
    const stores = testStores();

    for (let i = 0; i < 10; i += 1) {
      await call(stores, "POST", "/api/maintenance/on?sig=bad", {
        ip: "7.7.7.7",
      });
    }

    const res = await call(stores, "POST", pathOf(links(env, 0).on), {
      ip: "7.7.7.7",
    });

    assert.equal(res.status, 404);
  });

  it("report the state to anyone, without the secret", async () => {
    const stores = testStores();

    assert.deepEqual(
      await (await call(stores, "GET", "/api/maintenance")).json(),
      { maintenance: false, message: null }
    );
    await on(stores, mailbox().mail);
    assert.deepEqual(
      await (await call(stores, "GET", "/api/maintenance")).json(),
      { maintenance: true, message: MESSAGE }
    );
  });
});
