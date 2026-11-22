// The implementer's own tests for #772, after security's review of
// #779: an order the host places is tagged `byHost` then, so paying it
// later joins no one even when the farm has moved the host by then;
// and the group's `host` matches a session by lib/auth.mjs's one
// email rule, `normalizeEmail`. Additions to the criteria tests in
// host-member.test.mjs, never a replacement.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { handle as placeOrder } from "../netlify/functions/orders.mjs";
import { createSession } from "../netlify/functions/lib/auth.mjs";
import { completeOrder } from "../netlify/functions/lib/checkout.mjs";
import * as recordedSquare from "../netlify/functions/lib/fake-square.mjs";
import {
  getGroupRecord, groupKey, groupOf, hostedKeyOf, hostsGroup, joinGroup,
  memberKeyOf,
  setGroupCode, setGroupHost,
} from "../netlify/functions/lib/groups.mjs";
import {
  getCustomer, getOrder, saveCustomer,
} from "../netlify/functions/lib/records.mjs";
import { testStores } from "../netlify/functions/lib/store.mjs";
import { instant } from "../assets/scripts/order/lib/zoned.mjs";
import { SCHEDULE } from "./schedule-fixture.mjs";

const now = instant("2026-11-16", 9, 0, "America/New_York");
const VFF = groupOf("vff");
const ROUND = "2026-11-22";
const OCCURRENCE = `${VFF.series}-261122`;
const SKU = "NFF-CHK-WHL-35-39";
const env = {
  FARM_NOTIFICATIONS_EMAIL: "farm@x.com",
  DEV_NOTIFICATIONS_EMAIL: "dev@x.com",
  URL: "https://x",
  PICKUP_SCHEDULE: SCHEDULE,
};
const mail = async () => ({});

const HOST = "host@example.com";
const PAT = "pat@example.com";
const NEW_HOST = "newhost@example.com";

const setup = async () => {
  const stores = testStores();

  await setGroupCode(stores, "vff", { code: "GYM-2026", now });
  await setGroupHost(stores, "vff", HOST, { now });
  for (const [email, first] of [[HOST, "Hal"], [PAT, "Pat"],
    [NEW_HOST, "Nia"]]) {
    await saveCustomer(stores, { email, firstName: first,
      lastName: "Example", name: `${first} Example`,
      phone: "4015550100" });
  }
  await joinGroup(stores, PAT, "vff", { now, via: "qr" });

  return stores;
};

let keys = 0;

// An order at the round, as the page posts it for `email`, signed in.
const orderAtRound = async (stores, email) => {
  keys += 1;
  const key = `5d2a7b10-3c4e-4f6a-9b8c-${String(keys).padStart(12, "0")}`;
  const session = await createSession(stores, email, { now });
  const res = await placeOrder(new Request("http://x/api/orders", {
    method: "POST",
    headers: {
      "Content-Type": "application/json", "sec-fetch-site": "same-origin",
      cookie: `nff_session=${session.id}`,
    },
    body: JSON.stringify({
      idempotencyKey: key,
      payment: { method: "card", sourceId: `fake:ok-${keys}` },
      customer: {
        firstName: "Hal", lastName: "Example", email,
        phone: "401-555-0100", contact: "text",
      },
      lines: [{ sku: SKU, qty: 2 }],
      fulfilment: { method: "scheduled", occurrence: OCCURRENCE,
        date: ROUND },
      claimedTotal: 5500,
    }),
  }), {
    stores, square: recordedSquare, now, env, mail, sleep: async () => {},
  });
  const body = await res.json();

  assert.equal(res.status, 200, JSON.stringify(body));

  return getOrder(stores, body.orderId);
};

describe("A host's order and the host's address (#772, #779 review)", () => {
  it("tags the host's order `byHost` when it is placed, and a " +
    "member's not", async () => {
    const stores = await setup();

    assert.equal((await orderAtRound(stores, HOST)).group.byHost, true);
    assert.equal((await orderAtRound(stores, PAT)).group.byHost, undefined);
  });

  it("joins no one when a `byHost` order is paid after the farm moves " +
    "the host", async () => {
    const stores = await setup();
    const placed = await orderAtRound(stores, HOST);

    await setGroupHost(stores, "vff", NEW_HOST, { now });
    assert.equal(await hostsGroup(stores, HOST, "vff"), false);
    // As the jobs' rescue completes a Venmo order captured late.
    await completeOrder(stores, { ...placed, id: `${placed.id}-late` },
      { square: placed.square, payment: { via: "venmo" } },
      { env, mail, now });
    assert.equal(memberKeyOf(await getCustomer(stores, HOST)), null,
      "the former host is not written in as a member");
  });

  it("still joins the customer when an order without the tag is " +
    "paid", async () => {
    const stores = await setup();
    const placed = await orderAtRound(stores, HOST);
    const { byHost, ...group } = placed.group;

    assert.equal(byHost, true);
    await setGroupHost(stores, "vff", NEW_HOST, { now });
    await completeOrder(stores, { ...placed, id: `${placed.id}-x`, group },
      { square: placed.square, payment: { via: "venmo" } },
      { env, mail, now });
    assert.equal(memberKeyOf(await getCustomer(stores, HOST)), "vff");
  });

  it("matches the host by the one email rule, trailing dot and all",
    async () => {
      const stores = await setup();

      await setGroupHost(stores, "vff", " Host@Example.com. ", { now });
      assert.equal((await getGroupRecord(stores, "vff")).host, HOST,
        "stored as sessions store it");
      for (const typed of [HOST, "HOST@example.com.", " host@example.com "]) {
        assert.equal(await hostsGroup(stores, typed, "vff"), true, typed);
        assert.equal(await hostedKeyOf(stores, typed), "vff", typed);
      }
      assert.equal(await hostsGroup(stores, "", "vff"), false);
      assert.equal(await hostedKeyOf(stores, "."), null);
    });

  it("matches a host stored before the rule by the rule too", async () => {
    const stores = await setup();
    const record = await getGroupRecord(stores, "vff");

    await stores.orders.set(groupKey("vff"),
      { ...record, host: "host@example.com." });
    assert.equal(await hostsGroup(stores, HOST, "vff"), true);
    assert.equal(await hostedKeyOf(stores, HOST), "vff");
  });
});
