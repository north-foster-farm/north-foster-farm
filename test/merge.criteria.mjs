// Criteria tests for #776 (Add a customers merge command), one per
// tested box of its "Done when", written before the code. Held out of
// `npm test` (*.criteria.mjs) until the implementer renames it.
//
// The seam these tests assume:
//
// - CLI: `bin/nff customers merge <from> <into> [--apply]`, a case
//   "customers merge" in bin/nff's switch that calls
//   admin.mergeCustomer, guarded in bin/confirm.mjs as
//   "customers merge" with `apply: true` (asks only with --apply), the
//   phrase to type being <from>, the account that goes.
// - Admin: `mergeCustomer(stores, from, into, { apply = false, by,
//   env, fetchImpl, now })` in netlify/functions/lib/admin.mjs. It
//   reaches Square and Resend through `env` and `fetchImpl`, as
//   renameCustomer and forgetCustomer can, so the tests answer with
//   the recorded fixtures (test/fixtures/square, the Resend fake of
//   test/resend-fixture.mjs) and never a hand-written response.
// - Its report, dry run or not: { apply, from, into, orders (the ids),
//   perks, credit (grants moved), supportMessages, sessionsEnded,
//   signInLinksVoided, linksRepointed }, the counts named as
//   renameCustomer's report names them.
// - A refusal throws, as renameCustomer's do, and changes nothing.
// - The log line, on --apply only: event "customer.merged", `by`, the
//   two addresses masked (mask.mjs) in fields not named for personal
//   data (log.mjs scrubs `from`, `to`, `email`, `customer`), and the
//   counts as the report names them, `orders` as a number.
//
// A plus address works as either side: the first box runs both ways.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { confirmation, confirmed } from "../bin/confirm.mjs";
import { perksOf } from "../assets/scripts/order/lib/perks.mjs";
import * as admin from "../netlify/functions/lib/admin.mjs";
import { addressHash } from "../netlify/functions/lib/address-key.mjs";
import {
  authRecordsFor, putAuth,
} from "../netlify/functions/lib/auth-records.mjs";
import {
  creditBalance, getLedger, grantCredit,
} from "../netlify/functions/lib/credit.mjs";
import { maskEmail } from "../netlify/functions/lib/mask.mjs";
import { addPerk } from "../netlify/functions/lib/perks.mjs";
import {
  byEmailKey, cartKey, getCustomer, getOrder, ordersFor, saveCheckout,
  saveCustomer, saveOrder,
} from "../netlify/functions/lib/records.mjs";
import { testStores } from "../netlify/functions/lib/store.mjs";
import { recorded } from "./recorded.mjs";
import { resendFake } from "./resend-fixture.mjs";

/* eslint-disable camelcase -- Square and Resend name fields their way */

const now = new Date("2026-11-21T15:00:00Z");
const ZONE = "America/New_York";
const PLUS = "pat+dog@example.com";
const PLAIN = "pat@example.com";
const BY = "tester";
const SQUARE_ID = { [PLUS]: "SQ_PLUS_1", [PLAIN]: "SQ_PLAIN_1" };

const ENV = {
  SQUARE_ENV: "sandbox", SQUARE_ACCESS_TOKEN: "tok",
  SQUARE_LOCATION_ID: "LOC", RESEND_AUDIENCE_ID: "aud",
  RESEND_API_KEY: "k",
};

const order = (id, email) => ({
  id,
  status: id === "B" ? "fulfilled" : "paid",
  submittedAt: now.toISOString(),
  paidAt: now.toISOString(),
  customer: { name: "Pat Example", email, phone: "" },
  lines: [{ sku: "NFF-CHK-EGG-LG", label: "Eggs (per dozen), Large",
    qty: 1, unitPrice: 700, lineTotal: 700 }],
  totals: { subtotal: 700, discountAmount: 0, deliveryFee: 0, total: 700 },
  fulfilment: { method: "onfarm", date: "2026-11-25",
    onfarm: { window: "morning" } },
  payment: { via: "square", method: "card", at: now.toISOString(),
    squarePaymentId: `PAY-${id}`, receiptUrl: "https://r/x" },
  square: { customerId: SQUARE_ID[email], orderId: `SQO-${id}` },
});

// Square as recorded (test/fixtures/square, sandbox, 2026-10-29): the
// customer search finds each side's own profile by its email, and a
// delete, read or update answers with its recording. Only the id and
// email in the recorded customer change.
const squareAnswer = (method, path, body) => {
  if (path === "/v2/customers/search") {
    const email = body && body.query && body.query.filter
      && body.query.filter.email_address
      && body.query.filter.email_address.exact;
    const id = SQUARE_ID[String(email || "").toLowerCase()];

    if (!id) return recorded("square", "customers-search-none");

    const found = structuredClone(recorded("square",
      "customers-search-found"));

    found.response.customers = found.response.customers.map((c) => ({
      ...c, id, email_address: email,
    }));

    return found;
  }

  const id = decodeURIComponent(path.split("/v2/customers/")[1] || "");
  const email = Object.keys(SQUARE_ID).find((e) => SQUARE_ID[e] === id);
  const name = { DELETE: "customer-delete", GET: "customer-get",
    PUT: "customer-update" }[method];
  const answer = structuredClone(recorded("square", name));

  if (answer.response.customer) {
    answer.response.customer = { ...answer.response.customer, id,
      email_address: email };
  }

  return answer;
};

// Both services behind one fetch, every request kept.
const services = () => {
  const resend = resendFake([
    { email: PLUS, first_name: "Pat" },
    { email: PLAIN, first_name: "Pat" },
  ]);
  const square = [];
  const fetchImpl = async (url, init = {}) => {
    const { hostname, pathname } = new URL(url);

    if (hostname.includes("resend")) return resend.fetchImpl(url, init);

    const method = init.method || "GET";
    const body = init.body ? JSON.parse(init.body) : null;
    const { status, response } = squareAnswer(method, pathname, body);

    square.push({ method, pathname, body });

    return new Response(JSON.stringify(response), {
      status, headers: { "Content-Type": "application/json" },
    });
  };

  return { resend, square, fetchImpl };
};

// A source with everything that belongs to it, and a target with a
// little of its own, or with no record at all.
const seed = async (from, into, { target = true } = {}) => {
  const stores = testStores();

  await saveCustomer(stores, {
    email: from, name: "Pat From", avatar: "chick",
    memberGroup: { id: "vff", joinedAt: now.toISOString(), via: "order" },
  });
  if (target) {
    await saveCustomer(stores, { email: into, name: "Pat Into",
      avatar: "cow" });
    await saveOrder(stores, order("C", into), now);
  }
  await saveOrder(stores, order("A", from), now);
  await saveOrder(stores, order("B", from), now);
  await addPerk(stores, from, "free-delivery", { by: "cli", now });
  await grantCredit(stores, from, { amount: 500, now, timeZone: ZONE,
    from: { group: "vff", round: "2026-11-01", kind: "host" } });
  await grantCredit(stores, into, { amount: 300, now, timeZone: ZONE,
    from: { group: "vff", round: "2026-10-01", kind: "share" } });
  await stores.customers.set(`support/${from}/m1`, { message: "Hi" });
  await stores.customers.set(`support/${into}/m0`, { message: "Hello" });
  await stores.customers.set(cartKey(from), { payload: null, savedAt: 1 });
  await putAuth(stores, "session/s1", { email: from, expires: 1 });
  await putAuth(stores, "session/s2", { email: into, expires: 1 });
  await putAuth(stores, "token/t1", { email: from, expires: 1 });
  await putAuth(stores, "unsub/u1", { email: from });
  await putAuth(stores, "news/n1", { email: from });

  return stores;
};

// Every record in every store, to show a dry run wrote nothing.
const snapshot = (stores) => JSON.stringify(Object.fromEntries(
  Object.entries(stores).filter(([, s]) => s && s.data)
    .map(([name, s]) => [name, [...s.data.entries()]])
));

// Changes nothing that the farm or Square keeps on an order.
const KEPT = ["id", "status", "lines", "totals", "payment", "square",
  "submittedAt", "paidAt"];
const kept = (o) => Object.fromEntries(KEPT.map((k) => [k, o[k]]));

// The console lines the call writes.
const logged = async (t, fn) => {
  const lines = [];

  for (const level of ["info", "warn", "error"]) {
    t.mock.method(console, level, (...args) => {
      lines.push(args.map(String).join(" "));
    });
  }

  const result = await fn();

  for (const level of ["info", "warn", "error"]) console[level].mock.restore();

  return { lines, result };
};

describe("customers merge (#776)", () => {
  it("customers merge moves a customer's orders, perks, credit, support "
    + "messages and links onto the target and removes the source, a dry "
    + "run unless --apply", async () => {
    for (const [from, into] of [[PLUS, PLAIN], [PLAIN, PLUS]]) {
      const stores = await seed(from, into);
      const { resend, square, fetchImpl } = services();
      const opts = { by: BY, env: ENV, fetchImpl, now };
      const before = snapshot(stores);
      const orders = Object.fromEntries(await Promise.all(["A", "B"]
        .map(async (id) => [id, kept(await getOrder(stores, id))])));
      const perks = perksOf(await getCustomer(stores, from));
      const cart = await stores.customers.get(cartKey(from));

      // The dry run: a report, and nothing written anywhere.
      const dry = await admin.mergeCustomer(stores, from, into, opts);

      assert.equal(dry.apply, false, `${from} into ${into}`);
      assert.deepEqual([...dry.orders].sort(), ["A", "B"]);
      assert.equal(dry.perks, 1);
      assert.equal(dry.credit, 1);
      assert.equal(dry.supportMessages, 1);
      assert.equal(dry.sessionsEnded, 1);
      assert.equal(dry.signInLinksVoided, 1);
      assert.equal(dry.linksRepointed, 2);
      assert.equal(snapshot(stores), before, "a dry run writes nothing");
      assert.deepEqual(square.filter((c) => c.method !== "POST"
        || c.pathname !== "/v2/customers/search"), [],
      "a dry run only searches Square");
      assert.ok(resend.calls.every((c) => c.method === "GET"),
        "a dry run only reads Resend");
      assert.equal(resend.contacts.length, 2);

      // --apply.
      await admin.mergeCustomer(stores, from, into, { ...opts, apply: true });

      // Orders: re-pointed, the index too; ids, statuses, money kept.
      assert.deepEqual((await ordersFor(stores, into)).map((o) => o.id)
        .sort(), ["A", "B", "C"]);
      assert.deepEqual(await ordersFor(stores, from), []);
      for (const id of ["A", "B"]) {
        const moved = await getOrder(stores, id);

        assert.equal(moved.customer.email, into);
        assert.deepEqual(kept(moved), orders[id], `order ${id} is kept`);
        assert.equal(await stores.orders.get(byEmailKey(from, id)), null);
        assert.ok(await stores.orders.get(byEmailKey(into, id)));
      }

      // Perks, credit, group and cart go to the target, its own kept.
      const target = await getCustomer(stores, into);

      assert.equal(target.name, "Pat Into", "the target keeps its own");
      assert.deepEqual(perksOf(target), perks);
      assert.equal(await creditBalance(stores, into, now), 800);
      assert.deepEqual((await getLedger(stores, from)).entries, []);
      assert.equal(target.memberGroup && target.memberGroup.id, "vff",
        "the target had no group, so it takes the source's");
      assert.deepEqual(await stores.customers.get(cartKey(into)), cart,
        "the target's cart was empty, so it takes the source's");
      assert.equal(await stores.customers.get(cartKey(from)), null);

      // Support messages move; the target's stay.
      assert.equal(await stores.customers.get(`support/${from}/m1`), null);
      assert.deepEqual(
        await stores.customers.get(`support/${addressHash(into)}/m1`),
        { message: "Hi" });
      assert.deepEqual(await stores.customers.get(`support/${into}/m0`),
        { message: "Hello" });

      // Sessions end, sign-in links are voided, unsubscribe links
      // re-point; the target's own session stays.
      assert.equal(await stores.auth.get("session/s1"), null);
      assert.ok(await stores.auth.get("session/s2"));
      assert.equal(await stores.auth.get("token/t1"), null);
      assert.equal((await stores.auth.get("unsub/u1")).email, into);
      assert.equal((await stores.auth.get("news/n1")).email, into);
      assert.deepEqual(await authRecordsFor(stores, from), []);

      // Resend and Square: the target's kept, the source's removed.
      assert.deepEqual(resend.contacts.map((c) => c.email), [into]);
      assert.deepEqual(square.filter((c) => c.method === "DELETE")
        .map((c) => c.pathname), [`/v2/customers/${SQUARE_ID[from]}`]);
      assert.ok(!square.some((c) => c.method === "PUT"),
        "no Square customer is rewritten");

      // The source is gone.
      assert.equal(await getCustomer(stores, from), null);
    }
  });

  it("refuses when the target doesn't exist or a Venmo checkout from the "
    + "source is under way, and production asks first", async () => {
    // No target.
    {
      const stores = await seed(PLUS, PLAIN, { target: false });
      const { square, fetchImpl } = services();

      assert.equal(await getCustomer(stores, PLAIN), null);

      const before = snapshot(stores);

      await assert.rejects(admin.mergeCustomer(stores, PLUS, PLAIN, {
        apply: true, by: BY, env: ENV, fetchImpl, now,
      }), /no such customer|doesn't exist|does not exist|no account/i);
      assert.equal(snapshot(stores), before, "nothing changed");
      assert.ok(!square.some((c) => c.method === "DELETE"));
    }

    // A Venmo checkout from the source under way.
    {
      const stores = await seed(PLUS, PLAIN);
      const { square, resend, fetchImpl } = services();

      await saveCheckout(stores, {
        key: "k1", attempt: 1, at: now.toISOString(),
        order: order("D", PLUS), paypalOrderId: "PPO-1",
      });

      const before = snapshot(stores);

      await assert.rejects(admin.mergeCustomer(stores, PLUS, PLAIN, {
        apply: true, by: BY, env: ENV, fetchImpl, now,
      }), /Venmo/);
      assert.equal(snapshot(stores), before, "nothing changed");
      assert.ok(!square.some((c) => c.method === "DELETE"));
      assert.equal(resend.contacts.length, 2);
    }

    // Production asks, with --apply only, for the source's address.
    const command = (flags) => ({
      group: "customers", action: "merge", rest: [PLUS, PLAIN], flags,
    });

    assert.deepEqual(confirmation(command({ apply: true })).phrase, PLUS);
    assert.equal(confirmation(command({})), null,
      "a dry run asks nothing");

    const asked = [];
    const ask = async (q) => {
      asked.push(q);

      return "no";
    };

    assert.equal(await confirmed(command({ apply: true }), {
      context: "production", flags: { apply: true }, ask, say: () => {},
    }), false);
    assert.equal(asked.length, 1);
    assert.ok(asked[0].includes(PLUS));
    assert.equal(await confirmed(command({ apply: true }), {
      context: "staging", flags: { apply: true }, ask, say: () => {},
    }), true);
    assert.equal(asked.length, 1, "staging never asks");

    // The CLI runs it as `customers merge <from> <into> [--apply]`.
    const nff = readFileSync(new URL("../bin/nff", import.meta.url), "utf8");

    assert.match(nff, /customers merge <from> <into> \[--apply\]/);
    assert.match(nff, /case "customers merge":[\s\S]{0,200}mergeCustomer\(/);
  });

  it("every merge writes its log line with masked addresses and the "
    + "counts moved", async (t) => {
    const stores = await seed(PLAIN, PLUS);
    const { fetchImpl } = services();
    const opts = { by: BY, env: ENV, fetchImpl, now };

    const dry = await logged(t, () => admin.mergeCustomer(stores, PLAIN,
      PLUS, opts));

    assert.ok(!dry.lines.some((l) => l.includes("customer.merged")),
      "a dry run logs no merge");

    const { lines, result } = await logged(t, () => admin.mergeCustomer(
      stores, PLAIN, PLUS, { ...opts, apply: true }));
    const merged = lines.filter((l) => l.includes("customer.merged"));

    assert.equal(merged.length, 1, "one line per merge");

    const line = JSON.parse(merged[0]);

    assert.equal(line.event, "customer.merged");
    assert.equal(line.by, BY);
    assert.ok(line._time, "the line carries its time");
    assert.ok(merged[0].includes(maskEmail(PLAIN)), "the source, masked");
    assert.ok(merged[0].includes(maskEmail(PLUS)), "the target, masked");
    for (const l of lines) {
      assert.ok(!l.includes(PLAIN) && !l.includes(PLUS)
        && !l.includes(encodeURIComponent(PLUS)),
      `no full address is logged: ${l}`);
    }
    assert.equal(line.orders, 2);
    for (const count of ["perks", "credit", "supportMessages",
      "sessionsEnded", "signInLinksVoided", "linksRepointed"]) {
      assert.equal(line[count], result[count], `${count} is logged`);
    }
  });
});
