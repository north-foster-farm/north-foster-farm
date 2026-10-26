// A buying group's code (#471): what /api/group answers, and what an
// order placed with it, or by a member signed in, is allowed and
// records.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { RATE, handle as lookup } from "../netlify/functions/group.mjs";
import { handle as placeOrder } from "../netlify/functions/orders.mjs";
import { setCustomer } from "../netlify/functions/lib/admin.mjs";
import {
  createSession, publicCustomer,
} from "../netlify/functions/lib/auth.mjs";
import {
  INVALID_CODE, findGroupByCode, getGroupRecord, groupCodeOf, groupOf,
  joinGroup, leaveGroup, memberKeyOf, namedGroup, roundFor, setGroupCode,
  setGroupHost, setGroupName,
} from "../netlify/functions/lib/groups.mjs";
import {
  getCustomer, getOrder, saveCustomer,
} from "../netlify/functions/lib/records.mjs";
import { testStores } from "../netlify/functions/lib/store.mjs";
import terms from "../netlify/functions/lib/terms.mjs";
import { instant } from "../assets/scripts/order/lib/zoned.mjs";
import { SCHEDULE } from "./schedule-fixture.mjs";

const now = instant("2026-11-02", 9, 0, "America/New_York");
const env = {
  FARM_NOTIFICATIONS_EMAIL: "farm@example.com",
  DEV_NOTIFICATIONS_EMAIL: "dev@example.com",
  URL: "https://x",
  PICKUP_SCHEDULE: SCHEDULE,
};
const CODE = "GYM-2026";
const ROUND = "36TS-261108";
const SKU = "NFF-CHK-WHL-35-39";
const quiet = { sleep: async () => {} };

const withCode = async (stores = testStores()) => {
  await setGroupCode(stores, "vff", { code: CODE, now });

  return stores;
};

const ask = (body, { stores, headers = {}, ip = "1.2.3.4", method = "POST" }) =>
  lookup(new Request("http://x/api/group", {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body: method === "POST" ? JSON.stringify(body) : undefined,
  }), { stores, now, ip, env });

describe("the group's code", () => {
  it("compares upper case, letters and digits, six or more", () => {
    assert.equal(groupCodeOf(" gym-2026 "), "GYM2026");
    assert.equal(groupCodeOf("abc"), "");
    assert.equal(groupCodeOf(null), "");
    assert.equal(groupCodeOf("x".repeat(41)), "");
  });

  it("is minted in the pass alphabet, or set by hand, and rotates",
    async () => {
      const stores = testStores();
      const minted = await setGroupCode(stores, "vff", {
        now, pick: () => 0,
      });

      assert.equal(minted.code, "AAAA-AAAA");
      assert.equal((await findGroupByCode(stores, "aaaaaaaa")).key, "vff");

      const set = await setGroupCode(stores, "vff", { code: "gym-2026", now });

      assert.equal(set.code, "GYM-2026");
      assert.deepEqual(set.previous.map((p) => p.code), ["AAAA-AAAA"]);
      // The old code is as wrong as any other.
      assert.equal(await findGroupByCode(stores, "AAAA-AAAA"), null);
      assert.equal((await findGroupByCode(stores, "GYM2026")).key, "vff");

      await assert.rejects(setGroupCode(stores, "vff", { code: "ab" }),
        /6 to 24/);
      await assert.rejects(setGroupCode(stores, "nope", { code: CODE }),
        /Unknown group/);
    });

  it("keeps the host's email on the record, off the public answer",
    async () => {
      const stores = await withCode();

      await setGroupHost(stores, "vff", "Host@Example.com", { now });
      assert.equal((await getGroupRecord(stores, "vff")).host,
        "host@example.com");

      const res = await ask({ code: CODE }, { stores });
      const text = JSON.stringify(await res.json());

      assert.equal(text.includes("host@example.com"), false);
      assert.equal((await getGroupRecord(stores, "vff")).code, CODE);
    });
});

describe("POST /api/group", () => {
  it("answers a wrong code, an empty one and a guest the same", async () => {
    const stores = await withCode();

    for (const code of ["WRONG-ONE", "", "GYM-2027"]) {
      const res = await ask({ code }, { stores });

      assert.equal(res.status, 404, code);
      assert.deepEqual(await res.json(), { ok: false, message: INVALID_CODE });
    }
  });

  it("unlocks the group's place, series, rounds and lock", async () => {
    const stores = await withCode();
    const res = await ask({ code: " gym 2026 " }, { stores });
    const data = await res.json();

    assert.equal(res.status, 200);
    assert.equal(data.ok, true);
    assert.equal(data.group.key, "vff");
    assert.equal(data.group.name, "The Village Family Fitness");
    assert.equal(data.group.series, "36TS");
    assert.equal(data.group.location, "NR9D");
    assert.equal(data.group.lockThrough, "2027-12-31");
    assert.equal(data.group.lock.prices[SKU], 30);
    assert.deepEqual(data.group.places.locations.map((l) => l.code),
      ["NR9D"]);
    assert.deepEqual(data.group.places.series.map((s) => s.code), ["36TS"]);
    assert.equal(data.group.places.series[0].every, 2);
    assert.deepEqual(data.dates.map((d) => d.occurrence), [ROUND]);
    assert.equal(data.dates[0].name, "The Village Family Fitness");
    assert.equal(data.dates[0].window, "8:30 – 9:00 AM");
    assert.equal(data.dates[0].cutoff,
      instant("2026-11-07", 23, 59, "America/New_York").toISOString());
    // Nothing of the code comes back.
    assert.equal(JSON.stringify(data).includes(CODE), false);
  });

  it("limits misses by address, never a member's own page", async () => {
    const stores = await withCode();
    const ip = "9.9.9.9";

    for (let i = 0; i < RATE.max - 1; i++) {
      assert.equal((await ask({ code: "WRONG-ONE" }, { stores, ip })).status,
        404);
    }
    // The right code is answered however many times a page asks.
    for (let i = 0; i < RATE.max; i++) {
      assert.equal((await ask({ code: CODE }, { stores, ip })).status, 200);
    }
    assert.equal((await ask({ code: "WRONG-TWO" }, { stores, ip })).status,
      404);

    const res = await ask({ code: CODE }, { stores, ip });

    assert.equal(res.status, 429);
    assert.match((await res.json()).message, /too many tries/);
    // Another address is not held back.
    assert.equal((await ask({ code: CODE }, { stores, ip: "8.8.8.8" }))
      .status, 200);
  });

  it("refuses a cross-site post and any other method", async () => {
    const stores = await withCode();

    assert.equal((await ask({ code: CODE }, {
      stores, headers: { "sec-fetch-site": "cross-site" },
    })).status, 403);
    assert.equal((await ask(null, { stores, method: "GET" })).status, 404);
  });

  it("knows a signed-in member with no code, and no one else", async () => {
    const stores = await withCode();
    const session = await createSession(stores, "pat@example.com", { now });
    const cookie = { cookie: `nff_session=${session.id}` };

    assert.equal((await ask({}, { stores, headers: cookie })).status, 404);

    await joinGroup(stores, "pat@example.com", "vff", { now });

    const res = await ask({}, { stores, headers: cookie });

    assert.equal(res.status, 200);
    assert.equal((await res.json()).group.key, "vff");
    assert.equal(publicCustomer(await getCustomer(stores, "pat@example.com"))
      .memberGroup, "vff");

    await leaveGroup(stores, "pat@example.com");
    assert.equal((await ask({}, { stores, headers: cookie })).status, 404);
  });
});

describe("an order at the group's pickup", () => {
  const square = {
    createOrder: async () => ({ squareOrderId: "SQO", customerId: "CUST" }),
    createPayment: async (args) => ({
      squarePaymentId: `PAY-${args.squareOrderId}`, status: "COMPLETED",
      receiptUrl: null, brand: "VISA", last4: "4242", wallet: null,
    }),
  };
  const body = (overrides = {}) => ({
    idempotencyKey: "0f7c1e3a-9c9b-4b3a-8e9d-1a2b3c4d5e6f",
    customer: {
      firstName: "Pat", lastName: "Example", email: "pat@example.com",
      phone: "401-555-0100", contact: "call",
    },
    lines: [{ sku: SKU, qty: 2 }],
    fulfilment: { method: "scheduled", occurrence: ROUND },
    claimedTotal: 5500,
    payment: { method: "card", sourceId: "cnon:tok" },
    ...overrides,
  });
  const send = (stores, payload, headers = {}) => placeOrder(
    new Request("http://x/api/orders", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(payload),
    }),
    { stores, square, now, env, mail: async () => ({}), ...quiet }
  );

  it("is refused without the code, as a pickup that is not offered",
    async () => {
      const stores = await withCode();
      const res = await send(stores, body());

      assert.equal(res.status, 409);
      assert.equal((await res.json()).errors["fulfilment.occurrence"],
        "That pickup is no longer available.");
    });

  it("is refused with a wrong code, first and plainly", async () => {
    const stores = await withCode();
    const res = await send(stores, body({ groupCode: "GYM-2027" }));

    assert.equal(res.status, 422);
    assert.deepEqual((await res.json()).errors, { groupCode: INVALID_CODE });
  });

  it("is placed with the code, tagged, and makes the customer a member",
    async () => {
      const stores = await withCode();
      const res = await send(stores, body({ groupCode: "gym 2026" }));
      const data = await res.json();

      assert.equal(res.status, 200, JSON.stringify(data));
      assert.equal(data.fulfilment.occurrence, ROUND);
      assert.equal(data.fulfilment.date, "2026-11-08");
      // Priced at retail, with the tier as for anyone (the lock holds
      // nothing down today).
      assert.equal(data.totals.total, 5500);
      assert.equal(data.totals.discountTier, 50);

      const order = await getOrder(stores, data.orderId);

      assert.deepEqual(order.group,
        { key: "vff", round: "2026-11-08", viaCode: true });

      const customer = await getCustomer(stores, "pat@example.com");

      assert.equal(memberKeyOf(customer), "vff");
      assert.equal(customer.memberGroup.via, "code");
      assert.equal(customer.memberSince, now.toISOString());
    });

  it("is placed by a member signed in, with no code", async () => {
    const stores = await withCode();
    const session = await createSession(stores, "pat@example.com", { now });

    await joinGroup(stores, "pat@example.com", "vff", { now });

    const res = await send(stores, body(), {
      cookie: `nff_session=${session.id}`,
    });
    const data = await res.json();

    assert.equal(res.status, 200, JSON.stringify(data));
    assert.deepEqual((await getOrder(stores, data.orderId)).group,
      { key: "vff", round: "2026-11-08", viaCode: false });
  });

  it("falls in the next round when picked up elsewhere", async () => {
    const stores = await withCode();
    const res = await send(stores, body({
      groupCode: CODE,
      fulfilment: {
        method: "onfarm", date: "2026-11-03", onfarm: { window: "09:00-12:00" },
      },
    }));
    const data = await res.json();

    assert.equal(res.status, 200, JSON.stringify(data));
    assert.equal((await getOrder(stores, data.orderId)).group.round,
      "2026-11-08");
    assert.equal(roundFor({ series: "36TS" }, terms, "2026-11-09"),
      "2026-11-22");
    assert.equal(roundFor({ series: "36TS" }, terms, "2026-11-08"),
      "2026-11-08");
    assert.equal(roundFor({ series: "36TS" }, terms, null), null);
  });

  it("never takes a group from the payload's other fields", async () => {
    const stores = await withCode();
    const res = await send(stores, body({ group: "vff", member: "vff" }));

    assert.equal(res.status, 409);
  });
});

describe("customers set member=", () => {
  it("joins and leaves the group, and refuses one that is not", async () => {
    const stores = testStores();

    await saveCustomer(stores, {
      email: "pat@example.com", name: "Pat Example", phone: "", avatar: null,
      discountGroup: null, address: null,
    });

    const joined = await setCustomer(stores, "pat@example.com",
      { member: "vff" }, terms.money);

    assert.equal(memberKeyOf(joined), "vff");
    assert.equal(joined.memberGroup.via, "farm");

    const again = await setCustomer(stores, "pat@example.com",
      { member: "vff" }, terms.money);

    assert.equal(again.memberGroup.joinedAt, joined.memberGroup.joinedAt);

    const left = await setCustomer(stores, "pat@example.com",
      { member: "none" }, terms.money);

    assert.equal(left.memberGroup, null);
    await assert.rejects(setCustomer(stores, "pat@example.com",
      { member: "gym" }, terms.money), /Unknown group "gym"/);
  });
});

describe("the name the farm sets", () => {
  it("is the one members see, on the group, its series and its rounds",
    async () => {
      const stores = await withCode();
      const before = await (await ask({ code: CODE }, { stores })).json();

      assert.equal(before.group.name, "The Village Family Fitness");

      const record = await setGroupName(stores, "vff", " VFF Buying Club ",
        { now });

      assert.equal(record.name, "VFF Buying Club");
      // The code stays as it was.
      assert.equal(record.code, CODE);

      const after = await (await ask({ code: CODE }, { stores })).json();

      assert.equal(after.group.name, "VFF Buying Club");
      assert.equal(after.group.places.series[0].name, "VFF Buying Club");
      assert.equal(after.dates[0].name, "VFF Buying Club");
      assert.equal((await namedGroup(stores, groupOf("vff"))).name,
        "VFF Buying Club");
      await assert.rejects(setGroupName(stores, "vff", "  "), /A name/);
      await assert.rejects(setGroupName(stores, "nope", "x"), /Unknown group/);
    });
});
