import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { renameCustomer } from "../netlify/functions/lib/admin.mjs";
import { moveContact } from "../netlify/functions/lib/news.mjs";
import { renameCustomerEmail } from "../netlify/functions/lib/square.mjs";
import {
  getCustomer, getOrder, ordersFor, saveCheckout, saveCustomer, saveOrder,
} from "../netlify/functions/lib/records.mjs";
import { testStores } from "../netlify/functions/lib/store.mjs";

const now = new Date("2026-10-05T13:00:00Z");
const OLD = "pat@example.com";
const NEW = "pat.new@example.com";

const order = (id) => ({
  id,
  status: "paid",
  submittedAt: now.toISOString(),
  paidAt: now.toISOString(),
  customer: { name: "Pat Example", email: OLD, phone: "" },
  lines: [{ sku: "NFF-CHK-EGG-LG", label: "Eggs (per dozen), Large", qty: 1,
    unitPrice: 700, lineTotal: 700 }],
  totals: { subtotal: 700, discountAmount: 0, deliveryFee: 0, total: 700 },
  fulfilment: { method: "onfarm", date: "2026-10-07",
    onfarm: { window: "morning" } },
  payment: { via: "square", method: "card", at: now.toISOString(),
    squarePaymentId: `PAY-${id}`, receiptUrl: "https://r/x" },
});

// Square and Resend as the rename sees them: what each was asked.
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
  await saveOrder(stores, order("A"), now);
  await saveOrder(stores, order("B"), now);
  await stores.auth.set("session/s1", { email: OLD, expires: 1 });
  await stores.auth.set("session/s2", { email: "other@example.com" });
  await stores.auth.set("token/t1", { email: OLD, expires: 1 });
  await stores.auth.set("unsub/u1", { email: OLD });
  await stores.auth.set("news/n1", { email: OLD });
  await stores.customers.set(`support/${OLD}/m1`, { message: "Hi" });

  return stores;
};

describe("customers rename (#238)", () => {
  it("a dry run reports and changes nothing", async () => {
    const stores = await seed();
    const { calls, square, news } = outside();
    const report = await renameCustomer(stores, OLD, NEW, {
      square, news, now,
    });

    assert.equal(report.apply, false);
    assert.deepEqual(report.orders.sort(), ["A", "B"]);
    assert.equal(report.sessionsEnded, 1);
    assert.equal(report.signInLinksVoided, 1);
    assert.equal(report.linksRepointed, 2);
    assert.equal(report.supportMessages, 1);
    assert.equal(report.resend, "moved");
    assert.deepEqual(report.square, ["CUST-1"]);
    assert.ok(calls.every(([, , , apply]) => apply === false));
    assert.ok(await getCustomer(stores, OLD));
    assert.equal(await getCustomer(stores, NEW), null);
    assert.ok(await stores.auth.get("session/s1"));
  });

  it("with --apply, everything moves to the new address", async () => {
    const stores = await seed();
    const { calls, square, news } = outside();

    await renameCustomer(stores, OLD, NEW, {
      apply: true, square, news, now,
    });

    assert.equal(await getCustomer(stores, OLD), null);
    assert.equal((await getCustomer(stores, NEW)).avatar, "chick");
    assert.deepEqual((await ordersFor(stores, NEW)).map((o) => o.id).sort(),
      ["A", "B"]);
    assert.equal((await ordersFor(stores, OLD)).length, 0);
    assert.equal((await getOrder(stores, "A")).customer.email, NEW);
    assert.equal((await getOrder(stores, "A")).history.at(-1).event,
      "email changed");
    assert.equal(await stores.auth.get("session/s1"), null);
    assert.ok(await stores.auth.get("session/s2"));
    assert.equal(await stores.auth.get("token/t1"), null);
    assert.equal((await stores.auth.get("unsub/u1")).email, NEW);
    assert.equal((await stores.auth.get("news/n1")).email, NEW);
    assert.equal(await stores.customers.get(`support/${OLD}/m1`), null);
    assert.deepEqual(await stores.customers.get(`support/${NEW}/m1`),
      { message: "Hi" });
    assert.deepEqual(calls.filter(([, , , apply]) => apply).map(([s]) => s),
      ["resend", "square"]);
  });

  it("refuses a taken, invalid or unchanged address", async () => {
    const stores = await seed();
    const { square, news } = outside();
    const opts = { apply: true, square, news, now };

    await saveCustomer(stores, { email: NEW, name: "Someone" });
    await assert.rejects(renameCustomer(stores, OLD, NEW, opts),
      /already has an account/);
    await assert.rejects(renameCustomer(stores, OLD, "not-an-email", opts),
      /isn't an email address/);
    await assert.rejects(renameCustomer(stores, OLD, " PAT@example.com ",
      opts), /the same/);
    await assert.rejects(renameCustomer(stores, "nobody@example.com",
      "x@example.com", opts), /No such customer/);
    assert.ok(await getCustomer(stores, OLD));
  });

  it("waits while a Venmo payment is under way", async () => {
    const stores = await seed();
    const { square, news } = outside();

    await saveCheckout(stores, {
      key: "k1", attempt: 1, at: now.toISOString(), order: order("C"),
      paypalOrderId: "PPO-1",
    });
    await assert.rejects(renameCustomer(stores, OLD, NEW, {
      apply: true, square, news, now,
    }), /Venmo payment/);
    assert.ok(await getCustomer(stores, OLD));
  });

  it("reports a service it couldn't reach and still moves the rest",
    async () => {
      const stores = await seed();
      const { news } = outside();
      const square = {
        renameCustomerEmail: async () => {
          throw new Error("Square 401");
        },
      };
      const report = await renameCustomer(stores, OLD, NEW, {
        apply: true, square, news, now,
      });

      assert.equal(report.square, "not reached: Square 401");
      assert.ok(await getCustomer(stores, NEW));
    });
});

// Resend and Square name their fields in snake case.
/* eslint-disable camelcase */

// A fetch that answers from a table and remembers what it was asked;
// an answer of null is a 404.
const fakeFetch = (answer) => {
  const asked = [];
  const fetchImpl = async (url, { method, body } = {}) => {
    const found = answer(method, url);

    asked.push([method, new URL(url).pathname, body && JSON.parse(body)]);

    return new Response(JSON.stringify(found || { message: "Not found" }),
      { status: found ? 200 : 404 });
  };

  return { asked, fetchImpl };
};

describe("the rename's outside moves", () => {
  const resendEnv = { RESEND_SEGMENT_ID: "seg", RESEND_API_KEY: "k" };
  // The segment holds `segment`; the account also has `account`.
  const resendFake = (segment, account = []) => fakeFetch((method, url) => {
    const { pathname } = new URL(url);

    if (method !== "GET") return {};
    if (pathname.startsWith("/segments/")) return { data: segment };

    return account.find((c) =>
      pathname === `/contacts/${encodeURIComponent(c.email)}`) || null;
  });
  const leave = ["DELETE", `/contacts/${encodeURIComponent(OLD)}/segments/seg`];

  it("Resend: the new contact keeps the old one's choice", async () => {
    const { asked, fetchImpl } = resendFake([
      { email: OLD, first_name: "Pat", unsubscribed: true },
    ]);

    assert.equal(await moveContact(OLD, NEW, {
      env: resendEnv, fetchImpl, pace: 0,
    }), "moved");
    assert.equal(asked.length, 1);
    await moveContact(OLD, NEW, {
      env: resendEnv, fetchImpl, apply: true, pace: 0,
    });
    assert.deepEqual(asked.slice(2).map(([m, p]) => [m, p]), [
      ["GET", `/contacts/${encodeURIComponent(NEW)}`],
      ["POST", "/contacts"],
      leave,
    ]);
    assert.equal(asked[3][2].email, NEW);
    assert.equal(asked[3][2].unsubscribed, true);
    assert.deepEqual(asked[3][2].segments, [{ id: "seg" }]);
  });

  it("Resend: an existing new contact stays; none, or no segment",
    async () => {
      const both = resendFake([{ email: OLD }, { email: NEW }]);

      await moveContact(OLD, NEW, {
        env: resendEnv, fetchImpl: both.fetchImpl, apply: true, pace: 0,
      });
      assert.deepEqual(both.asked.map(([m, p]) => [m, p]), [
        ["GET", "/segments/seg/contacts"], leave,
      ]);

      const elsewhere = resendFake([{ email: OLD }], [{ email: NEW }]);

      await moveContact(OLD, NEW, {
        env: resendEnv, fetchImpl: elsewhere.fetchImpl, apply: true,
        pace: 0,
      });
      assert.deepEqual(elsewhere.asked.slice(1).map(([m, p]) => [m, p]), [
        ["GET", `/contacts/${encodeURIComponent(NEW)}`],
        ["POST", `/contacts/${encodeURIComponent(NEW)}/segments/seg`],
        leave,
      ], "in the account already: joins the segment as it is");

      const none = resendFake([]);

      assert.equal(await moveContact(OLD, NEW, {
        env: resendEnv, fetchImpl: none.fetchImpl, apply: true, pace: 0,
      }), "none");
      assert.equal(await moveContact(OLD, NEW, { env: {} }), "unconfigured");
    });

  it("Square: every customer under the old email gets the new one",
    async () => {
      const { asked, fetchImpl } = fakeFetch((method) => (method === "POST"
        ? { customers: [{ id: "C1" }, { id: "C2" }] } : {}));
      const env = { SQUARE_ACCESS_TOKEN: "t", SQUARE_ENVIRONMENT: "sandbox",
        SQUARE_LOCATION_ID: "L" };

      assert.deepEqual(await renameCustomerEmail(OLD, NEW, {
        env, fetchImpl,
      }), ["C1", "C2"]);
      assert.equal(asked.length, 1);
      await renameCustomerEmail(OLD, NEW, { env, fetchImpl, apply: true });
      assert.deepEqual(asked.slice(2), [
        ["PUT", "/v2/customers/C1", { email_address: NEW }],
        ["PUT", "/v2/customers/C2", { email_address: NEW }],
      ]);
    });
});
