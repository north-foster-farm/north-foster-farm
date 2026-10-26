// The host reward and credit (#471): a round closed once, the reward
// on real money only and only from $300, rounded down with the
// leftover kept, never worked out again; the host's choice; the
// shares by spend; credit granted once and gone at the year's end.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  balanceOf, creditBalance, getLedger, grantCredit, restoreCredit,
  spendCredit, yearEnd,
} from "../netlify/functions/lib/credit.mjs";
import {
  groupOf, setGroupHost,
} from "../netlify/functions/lib/groups.mjs";
import { runJobs } from "../netlify/functions/lib/jobs.mjs";
import { saveOrder } from "../netlify/functions/lib/records.mjs";
import {
  chooseReward, closeRound, getRound, rewardFor, settleReward,
  splitReward, workRounds,
} from "../netlify/functions/lib/rounds.mjs";
import { testStores } from "../netlify/functions/lib/store.mjs";
import terms from "../netlify/functions/lib/terms.mjs";
import { instant } from "../assets/scripts/order/lib/zoned.mjs";
import { SCHEDULE } from "./schedule-fixture.mjs";

const ny = (iso, h = 9, m = 0) => instant(iso, h, m, "America/New_York");
const VFF = groupOf("vff");
const SKU = "NFF-CHK-WHL-35-39";
const tz = terms.timeZone;

// A paid order of `dollars` in a round, `credit` of it paid with
// credit.
const order = (id, email, dollars, round, { credit = 0, refunded = 0,
  status = "paid" } = {}) => ({
  id, status, submittedAt: `2026-11-01T12:00:00.000Z`,
  customer: { email, name: email.split("@")[0] },
  lines: [{ sku: SKU, label: "Whole", qty: 1, unitPrice: dollars,
    lineTotal: dollars }],
  totals: { total: dollars * 100 },
  // Credit is a tender among the payments, like Venmo's.
  payments: [
    { amount: dollars * 100 - credit, via: "square" },
    ...(credit ? [{ amount: credit, via: "credit" }] : []),
  ],
  refunds: refunded ? [{ amount: refunded, status: "COMPLETED" }] : [],
  group: { key: "vff", round, viaCode: true },
});

const seed = async (stores, orders) => {
  for (const o of orders) await saveOrder(stores, o, ny("2026-11-01"));
};

describe("the reward on a round", () => {
  const policy = VFF.hostReward;

  it("is 10% of the real money, rounded down, from $300", () => {
    assert.deepEqual(rewardFor(100_000, policy),
      { earned: true, amount: 10_000, leftover: 0 });
    assert.deepEqual(rewardFor(31_050, policy),
      { earned: true, amount: 3_100, leftover: 5 });
    assert.deepEqual(rewardFor(30_000, policy),
      { earned: true, amount: 3_000, leftover: 0 });
    assert.deepEqual(rewardFor(29_999, policy),
      { earned: false, amount: 0, leftover: 0 });
    assert.deepEqual(rewardFor(0, policy),
      { earned: false, amount: 0, leftover: 0 });
  });

  it("closes a round once, on real money, and never again", async () => {
    const stores = testStores();

    // $1,000 net, $900 of it credit: $100 of real money earns nothing
    // (James, 6424212209); $1,000 of real money earns $100.
    await seed(stores, [
      order("NFF-2611-R1AAAA", "a@x.com", 1000, "2026-11-08", {
        credit: 90_000 }),
    ]);

    const first = await closeRound(stores, VFF, "2026-11-08", {
      now: ny("2026-11-08", 0, 1), terms,
    });

    assert.equal(first.closed, true);
    assert.equal(first.round.net, 100_000);
    assert.equal(first.round.credited, 90_000);
    assert.equal(first.round.real, 10_000);
    assert.equal(first.round.reward.earned, false);
    assert.equal(first.round.cutoff,
      ny("2026-11-07", 23, 59).toISOString());
    assert.deepEqual(first.round.members.map((m) => [m.email, m.real]),
      [["a@x.com", 10_000]]);

    // A refund after the close changes nothing of it.
    await seed(stores, [
      order("NFF-2611-R1AAAA", "a@x.com", 1000, "2026-11-08", {
        credit: 90_000, refunded: 5_000 }),
    ]);

    const again = await closeRound(stores, VFF, "2026-11-08", {
      now: ny("2026-11-09"), terms,
    });

    assert.equal(again.closed, false);
    assert.equal(again.round.net, 100_000);
    assert.equal(again.round.closedAt, first.round.closedAt);
  });
});

describe("the host's choice and the settlement", () => {
  // James's worked example (6405054048): round 1 $1,000 -> $100; the
  // host passes it on; round 2 $1,000 from two members, $100 and
  // $900: $10 and $90 of credit each.
  const rounds = async (stores) => {
    await seed(stores, [
      order("NFF-2611-R1AAAA", "a@x.com", 1000, "2026-11-08"),
      order("NFF-2611-R2AAAA", "b@x.com", 100, "2026-11-22"),
      order("NFF-2611-R2BBBB", "c@x.com", 900, "2026-11-22"),
    ]);
    const one = (await closeRound(stores, VFF, "2026-11-08",
      { now: ny("2026-11-08", 0, 1), terms })).round;
    const two = (await closeRound(stores, VFF, "2026-11-22",
      { now: ny("2026-11-22", 0, 1), terms })).round;

    return { one, two };
  };

  it("shares by real spend, rounded down, the leftover kept", async () => {
    const stores = testStores();
    const { one } = await rounds(stores);

    assert.equal(one.reward.amount, 10_000);

    const chosen = await chooseReward(stores, VFF, "2026-11-08", "share",
      { now: ny("2026-11-10") });

    assert.equal(chosen.choice.kind, "share");

    const two = await getRound(stores, "vff", "2026-11-22");
    const settled = await settleReward(stores, VFF, chosen, two, {
      now: ny("2026-11-22", 0, 2), terms,
    });

    assert.equal(settled.settled.kind, "share");
    // In the round's order: the bigger spender first.
    assert.deepEqual(settled.settled.shares.map((s) => [s.email, s.amount]),
      [["c@x.com", 9_000], ["b@x.com", 1_000]]);
    assert.equal(settled.settled.leftover, 0);
    assert.equal(await creditBalance(stores, "b@x.com", ny("2026-11-23")),
      1_000);
    assert.equal(await creditBalance(stores, "c@x.com", ny("2026-11-23")),
      9_000);
    // Settled once: a second pass grants nothing more.
    await settleReward(stores, VFF, settled, two, {
      now: ny("2026-11-22", 0, 3), terms,
    });
    assert.equal(await creditBalance(stores, "c@x.com", ny("2026-11-23")),
      9_000);
  });

  it("rounds each share down and keeps what is left", () => {
    const split = splitReward(10_000, [
      { email: "a", real: 33_300 }, { email: "b", real: 33_300 },
      { email: "c", real: 33_400 },
    ]);

    assert.deepEqual(split.shares.map((s) => s.amount),
      [3_300, 3_300, 3_300]);
    assert.equal(split.leftover, 100);
    assert.deepEqual(splitReward(10_000, []), { shares: [], leftover: 10_000 });
    assert.deepEqual(splitReward(10_000, [{ email: "a", real: 0 }]),
      { shares: [], leftover: 10_000 });
  });

  it("keeps it for the host with no choice, once he is on record",
    async () => {
      const stores = testStores();
      const { one, two } = await rounds(stores);

      await assert.rejects(settleReward(stores, VFF, one, two, {
        now: ny("2026-11-22", 0, 2), terms,
      }), /host of vff has no email address/);

      await setGroupHost(stores, "vff", "host@x.com",
        { now: ny("2026-11-22") });

      const settled = await settleReward(stores, VFF, one, two, {
        now: ny("2026-11-22", 0, 2), terms,
      });

      assert.equal(settled.settled.kind, "keep");
      assert.equal(settled.settled.chosen, false);
      assert.deepEqual(settled.settled.shares,
        [{ email: "host@x.com", real: null, amount: 10_000 }]);
      assert.equal(await creditBalance(stores, "host@x.com", ny("2026-11-23")),
        10_000);
      await assert.rejects(chooseReward(stores, VFF, "2026-11-08", "share"),
        /already credited/);
    });

  it("refuses a choice on a round with no reward, or an unknown one",
    async () => {
      const stores = testStores();

      await seed(stores, [order("NFF-2611-R1AAAA", "a@x.com", 100,
        "2026-11-08")]);
      await closeRound(stores, VFF, "2026-11-08",
        { now: ny("2026-11-08", 0, 1), terms });
      await assert.rejects(chooseReward(stores, VFF, "2026-11-08", "keep"),
        /earned no reward/);
      await assert.rejects(chooseReward(stores, VFF, "2026-11-22", "keep"),
        /not closed yet/);
      await assert.rejects(chooseReward(stores, VFF, "2026-11-08", "burn"),
        /one of: keep, share/);
    });
});

describe("the jobs close rounds and settle rewards", () => {
  const env = {
    FARM_NOTIFICATIONS_EMAIL: "farm@x.com",
    DEV_NOTIFICATIONS_EMAIL: "dev@x.com",
    PICKUP_SCHEDULE: SCHEDULE,
  };

  it("closes a round when its pickup day is over, not before, once",
    async () => {
      const stores = testStores();

      await seed(stores, [order("NFF-2611-R1AAAA", "a@x.com", 400,
        "2026-11-08")]);

      // Ordering closed Saturday night; the books stay open through
      // the pickup day, for the walk-in sales of the morning
      // (security review, 6425904452).
      for (const early of [ny("2026-11-07", 23, 58), ny("2026-11-08", 0, 1),
        ny("2026-11-08", 12, 0)]) {
        assert.deepEqual((await workRounds(stores, { now: early, terms }))
          .closed, []);
      }
      assert.equal(await getRound(stores, "vff", "2026-11-08"), null);

      // A walk-in recorded on the day counts.
      await seed(stores, [order("NFF-2611-R1WALK", "w@x.com", 50,
        "2026-11-08")]);

      const due = await workRounds(stores, { now: ny("2026-11-09", 0, 0),
        terms });

      assert.deepEqual(due.closed.map((c) => [c.round, c.real, c.reward]),
        [["2026-11-08", 45_000, 4_500]]);
      assert.deepEqual((await workRounds(stores, { now: ny("2026-11-10"),
        terms })).closed, []);
    });

  it("closes once when two closers meet", async () => {
    const stores = testStores();

    await seed(stores, [order("NFF-2611-R1AAAA", "a@x.com", 400,
      "2026-11-08")]);

    const both = await Promise.all([
      closeRound(stores, VFF, "2026-11-08", { now: ny("2026-11-09"), terms }),
      closeRound(stores, VFF, "2026-11-08", { now: ny("2026-11-09", 0, 1),
        terms }),
    ]);

    assert.deepEqual(both.map((r) => r.closed).sort(), [false, true]);
    assert.equal(both[0].round.closedAt, both[1].round.closedAt);
  });

  it("settles at the next close and reports a host missing", async () => {
    const stores = testStores();

    await seed(stores, [
      order("NFF-2611-R1AAAA", "a@x.com", 400, "2026-11-08"),
      order("NFF-2611-R2AAAA", "b@x.com", 50, "2026-11-22"),
    ]);

    const first = await runJobs(stores, {
      now: ny("2026-11-09", 1), env, mail: async () => ({}),
    });

    assert.equal(first.rounds.closed.length, 1);
    assert.deepEqual(first.rounds.settled, []);

    const second = await runJobs(stores, {
      now: ny("2026-11-23", 1), env, mail: async () => ({}),
    });

    assert.equal(second.rounds.closed.length, 1);
    assert.deepEqual(second.rounds.settled, []);
    assert.ok(second.errors.some((e) => e.step === "rounds"
      && /host of vff/.test(e.error)));

    await setGroupHost(stores, "vff", "host@x.com");

    const third = await runJobs(stores, {
      now: ny("2026-11-23", 2), env, mail: async () => ({}),
    });

    assert.deepEqual(third.rounds.settled.map((s) => [s.round, s.kind]),
      [["2026-11-08", "keep"]]);
    assert.equal(await creditBalance(stores, "host@x.com", ny("2026-11-23")),
      4_000);
  });
});

describe("credit", () => {
  const from = { group: "vff", round: "2026-11-08", kind: "host" };

  it("is granted once per round and kind", async () => {
    const stores = testStores();
    const now = ny("2026-11-22");

    await grantCredit(stores, "Host@X.com", { amount: 4_000, from, now,
      timeZone: tz });
    await grantCredit(stores, "host@x.com", { amount: 4_000, from, now,
      timeZone: tz });

    const ledger = await getLedger(stores, "host@x.com");

    assert.equal(ledger.entries.length, 1);
    assert.equal(ledger.entries[0].expiresAt,
      ny("2026-12-31", 23, 59).toISOString());
    await assert.rejects(grantCredit(stores, "host@x.com",
      { amount: 0, from, now, timeZone: tz }), /above zero/);
  });

  it("expires at the end of the year it was granted", async () => {
    const stores = testStores();

    await grantCredit(stores, "m@x.com", { amount: 1_000, from,
      now: ny("2026-11-22"), timeZone: tz });
    assert.equal(yearEnd(ny("2026-11-22"), tz),
      ny("2026-12-31", 23, 59).toISOString());
    assert.equal(await creditBalance(stores, "m@x.com", ny("2026-12-31", 23)),
      1_000);
    assert.equal(await creditBalance(stores, "m@x.com", ny("2027-01-01", 0)),
      0);
  });

  it("is spent soonest-expiring first, once per order, and comes back",
    async () => {
      const stores = testStores();

      // Granted in November, so it ends with 2026 (a December grant
      // would run to the end of 2027).
      await grantCredit(stores, "m@x.com", { amount: 1_000, from,
        now: ny("2026-11-20"), timeZone: tz });

      const now = ny("2026-12-10");

      assert.equal(await creditBalance(stores, "m@x.com", now), 1_000);
      await assert.rejects(spendCredit(stores, "m@x.com",
        { orderId: "O1", amount: 1_500, now }), /less credit/);

      // A grant in the new year; the first has expired by then.
      await grantCredit(stores, "m@x.com", { amount: 2_000,
        from: { ...from, round: "2027-01-10" }, now: ny("2027-01-12"),
        timeZone: tz });

      const later = ny("2027-01-20");

      assert.equal(await creditBalance(stores, "m@x.com", later), 2_000);

      const spent = await spendCredit(stores, "m@x.com",
        { orderId: "O1", amount: 1_500, now: later });

      assert.equal(balanceOf(spent, later), 500);
      // Once: the retry leaves it.
      await spendCredit(stores, "m@x.com", { orderId: "O1", amount: 1_500,
        now: later });
      assert.equal(await creditBalance(stores, "m@x.com", later), 500);

      const { restored } = await restoreCredit(stores, "m@x.com",
        { orderId: "O1", amount: 700, now: later });

      assert.equal(restored, 700);
      assert.equal(await creditBalance(stores, "m@x.com", later), 1_200);

      const rest = await restoreCredit(stores, "m@x.com",
        { orderId: "O1", amount: 2_000, now: later });

      assert.equal(rest.restored, 800);
      assert.equal(await creditBalance(stores, "m@x.com", later), 2_000);
    });
});

// The security review's change 3 (6425904452): the round's record,
// the choice and the settlement are written conditionally, so two
// writers at once move or grant nothing twice.
describe("two writers on one round", () => {
  const two = async (stores) => {
    await seed(stores, [
      order("NFF-2611-R1AAAA", "a@x.com", 1000, "2026-11-08"),
      order("NFF-2611-R2AAAA", "b@x.com", 100, "2026-11-22"),
      order("NFF-2611-R2BBBB", "c@x.com", 900, "2026-11-22"),
    ]);
    await setGroupHost(stores, "vff", "host@x.com");

    const one = (await closeRound(stores, VFF, "2026-11-08",
      { now: ny("2026-11-09"), terms })).round;
    const next = (await closeRound(stores, VFF, "2026-11-22",
      { now: ny("2026-11-23"), terms })).round;

    return { one, next };
  };

  it("settle once, whatever each read of the choice", async () => {
    const stores = testStores();
    const { one, next } = await two(stores);
    // One settler read the record before the host chose to share;
    // the other after.
    const chosen = await chooseReward(stores, VFF, "2026-11-08", "share",
      { now: ny("2026-11-10") });
    const both = await Promise.all([
      settleReward(stores, VFF, one, next, { now: ny("2026-11-23", 0, 1),
        terms }),
      settleReward(stores, VFF, chosen, next, { now: ny("2026-11-23", 0, 2),
        terms }),
    ]);
    // Exactly one settlement, and one set of grants: whichever
    // settler won, the record says one kind and the other call
    // answered with the record as it found it.
    const stored = await getRound(stores, "vff", "2026-11-08");

    assert.ok(stored.settled && stored.settled.kind);
    assert.equal(stored.settled.pending, undefined);
    assert.equal(both.length, 2);

    const host = await creditBalance(stores, "host@x.com", ny("2026-11-24"));
    const b = await creditBalance(stores, "b@x.com", ny("2026-11-24"));
    const c = await creditBalance(stores, "c@x.com", ny("2026-11-24"));

    assert.equal(host + b + c, 10_000);
    assert.equal(host === 10_000 || (b === 1_000 && c === 9_000), true);
    await assert.rejects(chooseReward(stores, VFF, "2026-11-08", "keep"),
      /already/);
  });

  it("let a settlement go when the host is missing, and try again",
    async () => {
      const stores = testStores();
      const { one, next } = await two(stores);

      await setGroupHost(stores, "vff", null);
      await assert.rejects(settleReward(stores, VFF, one, next,
        { now: ny("2026-11-23", 0, 1), terms }), /host of vff/);

      const stored = await getRound(stores, "vff", "2026-11-08");

      assert.equal(stored.settled, null);

      await setGroupHost(stores, "vff", "host@x.com");

      const done = await settleReward(stores, VFF, stored, next,
        { now: ny("2026-11-23", 0, 2), terms });

      assert.equal(done.settled.kind, "keep");
      assert.equal(await creditBalance(stores, "host@x.com",
        ny("2026-11-24")), 10_000);
    });
});
