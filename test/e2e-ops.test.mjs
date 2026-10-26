// The back-office ops the end-to-end suite added for #455, #456 and
// #461 (lib/e2e.mjs): each is one farm action or job run, scoped to
// what the suite made, so shared staging data keeps its state.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { runOp } from "../netlify/functions/lib/e2e.mjs";
import {
  getCustomer, saveCustomer,
} from "../netlify/functions/lib/records.mjs";
import { testStores } from "../netlify/functions/lib/store.mjs";

const env = {
  SITE_URL: "https://staging.example.test", MAIL_DRIVER: "outbox",
  SQUARE_ENV: "fake",
};

const subjects = async (stores) => (await runOp(stores, {
  op: "outboxList",
}, env)).body.messages.map((m) => `${m.to} ${m.subject}`);

describe("the quiet-account ops", () => {
  it("seeds a customer last seen years ago, and refuses a second seed",
    async () => {
      const stores = testStores();
      const made = await runOp(stores, {
        op: "customerSeedQuiet", email: "Old@Example.com", years: 3,
      }, env);

      assert.equal(made.status, 200);
      assert.equal(made.body.customer.email, "old@example.com");
      assert.equal(made.body.customer.marketing, true);
      assert.ok(made.body.customer.createdAt < "2024");

      const twice = await runOp(stores, {
        op: "customerSeedQuiet", email: "old@example.com",
      }, env);

      assert.equal(twice.status, 400);
    });

  it("notices only the address it names, and only once", async () => {
    const stores = testStores();

    for (const email of ["a@example.com", "b@example.com"]) {
      await runOp(stores, { op: "customerSeedQuiet", email }, env);
    }

    const first = await runOp(stores, {
      op: "quietRun", email: "a@example.com",
    }, env);

    assert.deepEqual(first.body.report.noticed, ["a@example.com"]);
    assert.deepEqual(await subjects(stores),
      ["a@example.com Your account is still here"]);
    assert.equal((await getCustomer(stores, "a@example.com")).marketing,
      false);
    assert.equal((await getCustomer(stores, "b@example.com")).marketing,
      true, "the other quiet account is left alone");

    const again = await runOp(stores, {
      op: "quietRun", email: "a@example.com",
    }, env);

    assert.deepEqual(again.body.report.noticed, []);
  });
});

describe("the jobs op", () => {
  it("wants a time near now and the orders to work", async () => {
    const stores = testStores();
    const bad = (body) => runOp(stores, { op: "jobsRun", ...body }, env);

    assert.equal((await bad({ orders: ["NFF-1"] })).status, 400);
    assert.equal((await bad({ at: "nonsense", orders: ["NFF-1"] })).status,
      400);
    assert.equal((await bad({
      at: "2001-01-01T00:00:00Z", orders: ["NFF-1"],
    })).status, 400);
    assert.equal((await bad({
      at: new Date().toISOString(),
    })).status, 400);
    assert.equal((await bad({
      at: new Date().toISOString(), orders: [],
    })).status, 400);
  });

  it("runs as of the time given, for the named orders alone", async () => {
    const stores = testStores();
    const res = await runOp(stores, {
      op: "jobsRun", at: new Date().toISOString(), orders: ["NFF-0000-AAAA"],
    }, env);

    assert.equal(res.status, 200);
    assert.deepEqual(Object.keys(res.body.report).sort(),
      ["closed", "deliveryReminded", "errors", "missedTold"]);
    assert.deepEqual(res.body.report.errors, []);
  });
});

describe("the order ops", () => {
  it("answer 404 for an order that does not exist", async () => {
    const stores = testStores();

    for (const op of ["orderFulfil", "squareOrder"]) {
      const res = await runOp(stores, { op, id: "NFF-0000-AAAA" }, env);

      assert.equal(res.status, 404, op);
    }

    const miss = await runOp(stores, {
      op: "orderAttempt", id: "NFF-0000-AAAA", cause: "weather",
    }, env);

    assert.equal(miss.status, 404);
  });

  it("decide an address only for a customer who has one", async () => {
    const stores = testStores();

    await saveCustomer(stores, {
      email: "pat@example.com", firstName: "Pat", address: null,
    });

    const none = await runOp(stores, {
      op: "addressDecide", email: "pat@example.com", decision: "approved",
    }, env);

    assert.equal(none.status, 400);

    await saveCustomer(stores, {
      email: "pat@example.com", firstName: "Pat",
      address: { address1: "1 Main", town: "Foster", zip: "02860",
        status: "pending" },
    });

    const yes = await runOp(stores, {
      op: "addressDecide", email: "pat@example.com", decision: "approved",
    }, env);

    assert.equal(yes.status, 200);
    assert.equal(yes.body.customer.address.status, "approved");
  });

  it("invite an address to the list, which it joins only on confirming",
    async () => {
      const stores = testStores();
      const res = await runOp(stores, {
        op: "newsInvite", email: "lee@example.com",
      }, env);

      assert.equal(res.status, 200);
      assert.deepEqual(res.body.report.invited, ["lee@example.com"]);
      assert.equal(await getCustomer(stores, "lee@example.com"), null,
        "not on the list until the link is followed");
    });
});
