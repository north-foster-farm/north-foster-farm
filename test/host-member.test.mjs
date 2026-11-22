// Criteria tests for #772 (A group's host counts as a member,
// unlisted), the server's side: one per box of its "Done when" marked
// (test), each named for its box. The page's half of the first box is
// e2e/host-member.criteria.mjs. Held out of every run by its name until
// the change lands: renamed to host-member.test.mjs, `npm test` runs
// it.
//
// The host is a customer whose email address is the group record's
// `host` (lib/groups.mjs `setGroupHost`, as `bin/nff groups set
// <key> host=<email>` sets it) and whose record has no `memberGroup`.
// Pat is a member in their own right (lib/groups.mjs `joinGroup`).
//
// The seam, what the tests rely on:
// - a signed-in customer is a session cookie, `nff_session=<id>`, from
//   lib/auth.mjs `createSession`, read by each handler below;
// - POST /api/group with no code (group.mjs `handle`) answers 200 with
//   the signed-in customer's group, its open rounds as `dates` and its
//   member price list as `group.lock`, and 404 to a customer in none;
// - GET /api/me (auth.mjs `handle`) names the group as `member` and
//   flags the Membership tab as `membership`, as it does for a member;
// - POST /api/orders (orders.mjs `handle`) takes an order at the
//   group's round as the page posts it, the way "scheduled" and the
//   round's occurrence id, "36TS-<YYMMDD>", and refuses one from a
//   customer not in the group with 409 and `notMember` (#749 item 9);
//   payments are lib/fake-square.mjs, Square's recorded answers;
// - the host's member list is `hosts[n].members` from GET
//   /api/membership (membership.mjs `handle`), and `bin/nff groups
//   members` prints lib/group-log.mjs `groupMembers` and its length as
//   the count;
// - the farm changes the host with lib/groups.mjs `setGroupHost`.
//
// The round is the group's real one on Sunday 2026-11-22
// (data/series.json), open on Monday the 16th.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { handle as authHandle } from "../netlify/functions/auth.mjs";
import { handle as groupHandle } from "../netlify/functions/group.mjs";
import {
  handle as membershipHandle,
} from "../netlify/functions/membership.mjs";
import { handle as placeOrder } from "../netlify/functions/orders.mjs";
import { createSession } from "../netlify/functions/lib/auth.mjs";
import * as recordedSquare from "../netlify/functions/lib/fake-square.mjs";
import { groupMembers } from "../netlify/functions/lib/group-log.mjs";
import {
  groupOf, joinGroup, memberKeyOf, setGroupCode, setGroupHost,
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

const HOST = "host@example.com";
const PAT = "pat@example.com";
const NEW_HOST = "newhost@example.com";

// The group with its code, its host and Pat; the host has no
// membership on their record.
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

const signedIn = async (stores, email) => ({
  cookie: `nff_session=${(await createSession(stores, email, { now })).id}`,
});

// As the page's own fetch sends it.
const request = (path, { method = "GET", headers = {}, body } = {}) =>
  new Request(`http://x${path}`, {
    method,
    headers: {
      "Content-Type": "application/json", "sec-fetch-site": "same-origin",
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });

// /api/group with no code: the signed-in customer's own group.
const ownGroup = async (stores, email) => {
  const res = await groupHandle(request("/api/group", {
    method: "POST", headers: await signedIn(stores, email), body: {},
  }), { stores, now, env });

  return { status: res.status, body: await res.json() };
};

const me = async (stores, email) => (await authHandle(request("/api/me", {
  headers: await signedIn(stores, email),
}), { stores, env, now })).json();

const membership = async (stores, email) => (await membershipHandle(
  request("/api/membership", { headers: await signedIn(stores, email) }),
  { stores, env, now },
)).json();

let keys = 0;

// An order at the round, as the page posts it for `email`, signed in,
// with no code: the account is what says they are in the group.
const orderAtRound = async (stores, email) => {
  keys += 1;
  const key = `0f7c1e3a-9c9b-4b3a-8e9d-${String(keys).padStart(12, "0")}`;
  const res = await placeOrder(request("/api/orders", {
    method: "POST",
    headers: await signedIn(stores, email),
    body: {
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
    },
  }), {
    stores, square: recordedSquare, now, env, mail: async () => ({}),
    sleep: async () => {},
  });

  return { status: res.status, body: await res.json() };
};

describe("A group's host counts as a member, unlisted (#772)", () => {
  it("A group's host, signed in, sees Group orders with the group's " +
    "open rounds and the member prices on the order page, as a member " +
    "does, with no membership on their own record (server)", async () => {
    const stores = await setup();
    const member = await ownGroup(stores, PAT);
    const host = await ownGroup(stores, HOST);

    assert.equal(memberKeyOf(await getCustomer(stores, HOST)), null,
      "no membership on the host's record");
    assert.equal(host.status, 200, "the host's own group, with no code");
    assert.equal(host.body.group.key, "vff");
    assert.deepEqual(host.body.dates, member.body.dates,
      "the group's open rounds, as a member gets them");
    assert.ok(host.body.dates.some((d) => d.occurrence === OCCURRENCE),
      "the open round among them");
    assert.deepEqual(host.body.group.lock, member.body.group.lock,
      "the member price list");
    assert.deepEqual(host.body.group.lock, { prices: VFF.priceLock.prices });

    const view = await me(stores, HOST);

    assert.equal(view.member && view.member.key, "vff",
      "/api/me names the group, for the member line and its prices");
    assert.equal(view.membership, true);
    assert.equal(memberKeyOf(await getCustomer(stores, HOST)), null,
      "still none on the record: derived, never written");
  });

  it("The host can place and pay for an order at their group's round, " +
    "and `/api/orders` accepts it rather than refusing them as not a " +
    "member", async () => {
    const stores = await setup();
    const placed = await orderAtRound(stores, HOST);

    assert.notEqual(placed.status, 409, JSON.stringify(placed.body));
    assert.equal(placed.body.notMember, undefined);
    assert.equal(placed.status, 200, JSON.stringify(placed.body));

    const order = await getOrder(stores, placed.body.orderId);

    assert.equal(order.status, "paid");
    assert.equal(order.customer.email, HOST);
    assert.equal(order.fulfilment.occurrence, OCCURRENCE);
    assert.equal(order.group && order.group.key, "vff");
    assert.equal(order.group.round, ROUND);
    assert.equal(memberKeyOf(await getCustomer(stores, HOST)), null,
      "paying at the round writes no membership onto the record");
  });

  it("The host is not listed among the group's members: not on the " +
    "host's Membership tab list, not in `bin/nff groups members`, and " +
    "not in any member count", async () => {
    const stores = await setup();

    // The host counts as a member, so the list leaving them out is
    // the rule, not their being in no group.
    assert.equal((await ownGroup(stores, HOST)).status, 200,
      "the host counts as a member");

    const view = await membership(stores, HOST);
    const [hosted] = view.hosts;

    assert.equal(hosted.key, "vff");
    assert.deepEqual(hosted.members.map((m) => m.email), [PAT],
      "the host's Membership tab list");
    assert.equal(hosted.members.length, 1, "the tab's count");

    const listed = await groupMembers(stores, "vff");

    assert.deepEqual(listed.map((m) => m.email), [PAT],
      "bin/nff groups members");
    assert.equal(listed.length, 1, "its count");
  });

  it("When the farm changes the host, the former host keeps member " +
    "access only if they are a member in their own right", async () => {
    // A former host with no membership of their own loses it.
    const stores = await setup();

    assert.equal((await ownGroup(stores, HOST)).status, 200,
      "member access while host");
    await setGroupHost(stores, "vff", NEW_HOST, { now });
    assert.equal((await ownGroup(stores, HOST)).status, 404,
      "none once replaced");
    assert.equal((await me(stores, HOST)).member, undefined,
      "no member line once replaced");

    const refused = await orderAtRound(stores, HOST);

    assert.equal(refused.status, 409, JSON.stringify(refused.body));
    assert.equal(refused.body.notMember, true);
    assert.equal((await ownGroup(stores, NEW_HOST)).status, 200,
      "the new host has it");

    // A former host who joined in their own right keeps it.
    const joined = await setup();

    await joinGroup(joined, HOST, "vff", { now, via: "farm" });
    await setGroupHost(joined, "vff", NEW_HOST, { now });

    const kept = await ownGroup(joined, HOST);

    assert.equal(kept.status, 200, "a member in their own right keeps it");
    assert.equal(kept.body.group.key, "vff");
    assert.equal((await orderAtRound(joined, HOST)).status, 200,
      "and still orders at the round");
    assert.deepEqual((await groupMembers(joined, "vff"))
      .map((m) => m.email).sort(), [HOST, PAT],
    "listed as the member they are");
  });
});
