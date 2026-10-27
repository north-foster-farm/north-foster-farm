// Taking a member out of a buying group (#495, part 6): the host's
// Remove, a member's Leave group and the CLI's `groups remove` are one
// logged act. Open orders stand as placed and count toward the round;
// a change can't move one into a round; member prices never change;
// credit is the account's and stays spendable (James, decision 6),
// voided only by the farm for abuse.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

import { handle as authHandle } from "../netlify/functions/auth.mjs";
import {
  NOT_IN, SELF, handle,
} from "../netlify/functions/membership.mjs";
import { planChange } from "../netlify/functions/lib/account.mjs";
import { createSession } from "../netlify/functions/lib/auth.mjs";
import {
  creditBalance, getLedger, grantCredit, voidCredit,
} from "../netlify/functions/lib/credit.mjs";
import { auditLog } from "../netlify/functions/lib/group-log.mjs";
import {
  buyingFor, groupOf, joinGroup, lockGroupOf, memberKeyOf, offeredGroup,
  roundOrders, setGroupCode, setGroupHost,
} from "../netlify/functions/lib/groups.mjs";
import { removeMember } from "../netlify/functions/lib/membership.mjs";
import {
  getCustomer, getOrder, saveCustomer, saveOrder,
} from "../netlify/functions/lib/records.mjs";
import { testStores } from "../netlify/functions/lib/store.mjs";
import { instant } from "../assets/scripts/order/lib/zoned.mjs";
import { SCHEDULE } from "./schedule-fixture.mjs";

const now = instant("2026-11-02", 9, 0, "America/New_York");
const env = { URL: "https://x", PICKUP_SCHEDULE: SCHEDULE };
const HOST = "host@example.com";
const PAT = "pat@example.com";
const SAM = "sam@example.com";
const VFF = groupOf("vff");

// A paid order of Pat's in the group's round on the 8th.
const gymOrder = () => ({
  id: "NFF-2611-GYMPAT", status: "paid",
  submittedAt: "2026-11-01T12:00:00.000Z", paidAt: "2026-11-01T12:00:05Z",
  customer: { email: PAT, name: "Pat Example", firstName: "Pat",
    lastName: "Example", phone: "4015550100", contact: "call" },
  lines: [{ sku: "NFF-CHK-WHL-35-39", label: "Whole", name: "Whole", qty: 2,
    unitPrice: 30, lineTotal: 60, squareVariationId: null }],
  totals: { subtotal: 6000, discountTier: 50, discountAmount: 500,
    deliveryFee: 0, total: 5500 },
  fulfilment: { method: "scheduled", occurrence: "36TS-261108",
    date: "2026-11-08", onfarm: null, delivery: null, state: "agreed" },
  payments: [{ at: "2026-11-01T12:00:05Z", amount: 5500, via: "square" }],
  refunds: [], notes: "", code: null,
  group: { key: "vff", round: "2026-11-08", viaCode: true },
});

// The same order's customer at the drop site, untagged, for a move.
const dropOrder = () => ({
  ...gymOrder(), id: "NFF-2611-DROPPAT", group: null,
  fulfilment: { method: "scheduled", occurrence: "VFVQ-261107",
    date: "2026-11-07", onfarm: null, delivery: null, state: "agreed" },
});

const setup = async () => {
  const stores = testStores();

  await setGroupCode(stores, "vff", { code: "GYM-2026", now });
  await setGroupHost(stores, "vff", HOST, { now });
  for (const [email, first] of [[HOST, "Hal"], [PAT, "Pat"], [SAM, "Sam"]]) {
    await saveCustomer(stores, { email, firstName: first,
      lastName: "Example", name: `${first} Example` });
  }
  await joinGroup(stores, HOST, "vff", { now, via: "farm" });
  await joinGroup(stores, PAT, "vff", { now, via: "code" });

  const cookie = async (email) => ({
    cookie: `nff_session=${(await createSession(stores, email, { now })).id}`,
  });

  return {
    stores, host: await cookie(HOST), member: await cookie(PAT),
    stranger: await cookie(SAM),
  };
};

const post = (stores, path, body, headers = {}) => handle(
  new Request(`http://x${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  }), { stores, env, now });

describe("the host's Remove", () => {
  it("takes a member out, logged, and returns the list", async () => {
    const { stores, host } = await setup();
    const res = await post(stores, "/api/membership/remove",
      { email: PAT }, host);
    const data = await res.json();

    assert.equal(res.status, 200);
    assert.deepEqual(data.members.map((m) => m.email), [HOST]);
    assert.equal(memberKeyOf(await getCustomer(stores, PAT)), null);

    const [act] = await auditLog(stores, "vff");

    assert.deepEqual(act.by, { role: "host", email: HOST });
    assert.equal(act.action, "member.remove");
    assert.equal(act.target, PAT);
    assert.equal(act.before.group, "vff");
    assert.equal(act.before.via, "code");
    assert.deepEqual(act.after, { group: null });
  });

  it("refuses the host's own address and someone not in the group",
    async () => {
      const { stores, host } = await setup();
      const self = await post(stores, "/api/membership/remove",
        { email: HOST }, host);

      assert.equal(self.status, 422);
      assert.equal((await self.json()).message, SELF);

      const out = await post(stores, "/api/membership/remove",
        { email: SAM }, host);

      assert.equal(out.status, 404);
      assert.equal((await out.json()).message, NOT_IN);
      assert.deepEqual(await auditLog(stores, "vff"), []);
    });

  it("gives a member or a stranger nothing, and changes nothing",
    async () => {
      const { stores, member, stranger } = await setup();

      for (const who of [member, stranger]) {
        const res = await post(stores, "/api/membership/remove",
          { email: HOST }, who);

        assert.equal(res.status, 404);
      }
      assert.equal((await post(stores, "/api/membership/remove",
        { email: PAT })).status, 401);
      assert.equal(memberKeyOf(await getCustomer(stores, HOST)), "vff");
      assert.equal(memberKeyOf(await getCustomer(stores, PAT)), "vff");
    });

  it("is refused from another site", async () => {
    const { stores, host } = await setup();
    const res = await post(stores, "/api/membership/remove", { email: PAT },
      { ...host, "sec-fetch-site": "cross-site" });

    assert.equal(res.status, 403);
    assert.equal(memberKeyOf(await getCustomer(stores, PAT)), "vff");
  });
});

describe("Leave group", () => {
  it("takes a member out by their own hand, logged", async () => {
    const { stores, member } = await setup();
    const res = await post(stores, "/api/membership/leave", {}, member);

    assert.equal(res.status, 200);
    assert.equal(memberKeyOf(await getCustomer(stores, PAT)), null);

    const [act] = await auditLog(stores, "vff");

    assert.deepEqual([act.by, act.action, act.target],
      [{ role: "member", email: PAT }, "member.leave", PAT]);

    // Gone, the tab is gone too.
    const me = await (await authHandle(new Request("http://x/api/me",
      { headers: member }), { stores, env, now })).json();

    assert.equal(me.membership, undefined);
  });

  it("gives a stranger nothing", async () => {
    const { stores, stranger } = await setup();

    assert.equal((await post(stores, "/api/membership/leave", {}, stranger))
      .status, 404);
  });

  it("is on the tab, asked first", async () => {
    const page = await readFile(new URL("../layouts/account/single.html",
      import.meta.url), "utf8");

    assert.match(page, /id="mem-leave"[^>]*>Leave group</);
    assert.match(page, /id="mem-leave-confirm" hidden/);
  });
});

describe("what a removal leaves as it was", () => {
  it("keeps open orders as placed, counting toward the round", async () => {
    const { stores } = await setup();

    await saveOrder(stores, gymOrder(), now);
    await removeMember(stores, "vff", PAT, { by: { role: "farm" }, now });

    const kept = await getOrder(stores, "NFF-2611-GYMPAT");

    assert.deepEqual(kept.group, gymOrder().group);
    assert.deepEqual(kept.lines, gymOrder().lines);
    assert.deepEqual(kept.fulfilment, gymOrder().fulfilment);
    assert.deepEqual((await roundOrders(stores, "vff", "2026-11-08"))
      .map((o) => o.id), ["NFF-2611-GYMPAT"]);
  });

  it("keeps the price lock and drops the rounds from a change",
    async () => {
      const { stores } = await setup();

      assert.equal((await buyingFor(stores, gymOrder())).key, "vff");
      await removeMember(stores, "vff", PAT, { by: { role: "farm" }, now });
      assert.equal(await buyingFor(stores, gymOrder()), null);
      assert.equal(lockGroupOf(gymOrder(), null).key, "vff",
        "member prices on a placed order never change");
      assert.equal(offeredGroup(VFF, null), null);
      assert.equal(offeredGroup(VFF, VFF), VFF);
      assert.equal(offeredGroup(null, VFF), VFF);
    });

  it("can't move an order into a round once out", async () => {
    const to = { method: "scheduled", occurrence: "36TS-261108" };
    const tagged = { ...dropOrder(),
      group: { key: "vff", round: "2026-11-08", viaCode: true } };

    // In the group, the customer may move it there.
    assert.equal(planChange(tagged, to, { now, env, member: VFF }).errors,
      undefined);
    // Out of it, not, with the tag or without.
    for (const order of [tagged, dropOrder()]) {
      assert.equal(planChange(order, to, { now, env }).errors.occurrence,
        "That pickup isn't available.");
    }
    // The farm's own change still can.
    assert.equal(planChange(tagged, to, { now, env, by: "farm" }).errors,
      undefined);
  });
});

describe("credit after leaving", () => {
  const from = { group: "vff", round: "2026-11-08", kind: "share" };

  it("stays theirs, the account's", async () => {
    const { stores, member } = await setup();

    await grantCredit(stores, PAT, { amount: 2000, from, now,
      timeZone: "America/New_York" });
    await removeMember(stores, "vff", PAT, { by: { role: "farm" }, now });

    assert.equal(await creditBalance(stores, PAT, now), 2000);

    // The order page learns it from /api/me, as the order handler
    // reads it from the ledger.
    const me = await (await authHandle(new Request("http://x/api/me",
      { headers: member }), { stores, env, now })).json();

    assert.equal(me.member, undefined);
    assert.equal(me.credit, 2000);
  });

  it("is voided for abuse, the books keeping what and when", async () => {
    const { stores } = await setup();

    await grantCredit(stores, PAT, { amount: 2000, from, now,
      timeZone: "America/New_York" });

    const { voided } = await voidCredit(stores, PAT, { now, reason: "farm" });

    assert.equal(voided, 2000);
    assert.equal(await creditBalance(stores, PAT, now), 0);

    const [entry] = (await getLedger(stores, PAT)).entries;

    assert.equal(entry.amount, 2000);
    assert.deepEqual(entry.voided, [{ amount: 2000, at: now.toISOString(),
      reason: "farm" }]);
    assert.equal((await voidCredit(stores, PAT, { now })).voided, 0,
      "nothing left to void");
  });
});
