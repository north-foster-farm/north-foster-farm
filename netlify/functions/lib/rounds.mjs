// A buying group's rounds and the host reward (#471, James's policy
// of 6405054048 and his answers of 6405215783 and 6405284935).
//
// When a round closes (11:59 PM the day before its pickup) its orders
// are added up once and kept under `round/<key>/<date>` in the
// orders store: the net total (paid less refunded), what of it was
// paid with credit, and the real money, the net less the credit. The
// host earns 10% of the real money, rounded down to the dollar with
// the leftover cents recorded, only when the real money reaches
// $300. The reward is never worked out again: a refund after the
// close leaves it as it was (6406932945).
//
// The host chooses by the close of the next round: keep it, as credit
// on his own account, or share it, in which case it is split among
// that next round's members in proportion to the real money each
// spent, rounded down to the dollar, the leftover recorded. With no
// choice by then it is kept. Credit lands when the next round closes
// (lib/credit.mjs), and spends the round after.

import {
  cutoffOf, seriesDates,
} from "../../../assets/scripts/order/lib/events.mjs";
import {
  addDays, today,
} from "../../../assets/scripts/order/lib/zoned.mjs";
import { grantCredit } from "./credit.mjs";
import {
  GROUPS, getGroupRecord, roundOccurrence, roundOrders, roundSummary,
} from "./groups.mjs";

export const CHOICES = ["keep", "share"];

// How far back a close looks for a round it missed.
const LOOK_BACK = 60;

export const roundKey = (key, round) => `round/${key}/${round}`;

export const getRound = (stores, key, round) =>
  stores.orders.get(roundKey(key, round));

export const listRounds = async (stores, key) => {
  const keys = await stores.orders.list(`round/${key}/`);
  const rounds = await Promise.all(keys.map((k) => stores.orders.get(k.key)));

  return rounds.filter(Boolean).sort((a, b) => a.round.localeCompare(b.round));
};

// What an order paid with credit, in cents: the credit tender among
// its payments (lib/credit.mjs is the ledger; the order's record
// shows the tender like any other), less any of it refunded.
const viaCredit = (list) => (list || [])
  .filter((p) => p && p.via === "credit")
  .reduce((s, p) => s + (Number(p.amount) || 0), 0);

export const creditPaid = (order) =>
  viaCredit(order.payments) - viaCredit(order.refunds);

// The reward on `real` cents: nothing under the threshold; else the
// percent, rounded down to the dollar, the leftover cents kept for
// the books.
export const rewardFor = (real, { percent, threshold }) => {
  if (real < threshold * 100) return { earned: false, amount: 0, leftover: 0 };

  const raw = Math.floor(real * percent / 100);
  const amount = Math.floor(raw / 100) * 100;

  return { earned: true, amount, leftover: raw - amount };
};

// Closes a round once: its orders added up as they stand, the reward
// worked out. A round already closed is answered as it is.
// -> { round, closed } with `closed` true when this call did it.
export const closeRound = async (stores, group, round, {
  now = new Date(), terms,
}) => {
  const found = await getRound(stores, group.key, round);

  if (found) return { round: found, closed: false };

  const orders = await roundOrders(stores, group.key, round);
  const sum = roundSummary(orders);
  const creditOf = (email) => orders
    .filter((o) => o.customer.email === email)
    .reduce((s, o) => s + creditPaid(o), 0);
  const credited = orders.reduce((s, o) => s + creditPaid(o), 0);
  const real = sum.net - credited;
  const record = {
    group: group.key,
    round,
    occurrence: roundOccurrence(group, round),
    cutoff: cutoffOf(round, terms.timeZone).toISOString(),
    closedAt: now.toISOString(),
    count: sum.count,
    net: sum.net,
    credited,
    real,
    percent: group.hostReward.percent,
    threshold: group.hostReward.threshold,
    reward: rewardFor(real, group.hostReward),
    members: sum.members.map((m) => ({
      email: m.email, name: m.name, orders: m.orders, net: m.net,
      real: m.net - creditOf(m.email), walkIn: m.walkIn,
    })),
    pickList: sum.pickList,
    choice: null,
    settled: null,
  };

  await stores.orders.set(roundKey(group.key, round), record);

  return { round: record, closed: true };
};

// The host's choice for a round's reward, until it is settled.
export const chooseReward = async (stores, group, round, kind, {
  now = new Date(), by = "farm",
} = {}) => {
  if (!CHOICES.includes(kind)) {
    throw new Error(`The choice is one of: ${CHOICES.join(", ")}.`);
  }

  const record = await getRound(stores, group.key, round);

  if (!record) throw new Error(`Round ${round} is not closed yet.`);
  if (!record.reward.earned) {
    throw new Error(`Round ${round} earned no reward (real money ${
      record.real} cents, under $${record.threshold}).`);
  }
  if (record.settled) {
    throw new Error(`Round ${round}'s reward is already ${
      record.settled.kind === "share" ? "shared out" : "credited"}.`);
  }

  const next = { ...record, choice: { kind, at: now.toISOString(), by } };

  await stores.orders.set(roundKey(group.key, round), next);

  return next;
};

// The shares of `amount` among members by their real spend, each
// rounded down to the dollar; the leftover is what rounding kept
// back. -> { shares: [{ email, real, amount }], leftover }
export const splitReward = (amount, members) => {
  const buyers = members.filter((m) => m.real > 0);
  const total = buyers.reduce((s, m) => s + m.real, 0);

  if (!buyers.length || total <= 0) return { shares: [], leftover: amount };

  const shares = buyers.map((m) => ({
    email: m.email, real: m.real,
    amount: Math.floor(amount * m.real / total / 100) * 100,
  }));
  const given = shares.reduce((s, x) => s + x.amount, 0);

  return { shares, leftover: amount - given };
};

// Settles `prior`'s reward at the close of `next`: kept, as credit
// on the host's account, or shared among `next`'s members by their
// real spend. Once. Throws when the host's email is not on record
// and the reward is to be kept, so the farm hears and sets it; the
// next run settles it then. -> the prior round as settled.
export const settleReward = async (stores, group, prior, next, {
  now = new Date(), terms,
}) => {
  if (prior.settled || !prior.reward.earned) return prior;

  const kind = prior.choice ? prior.choice.kind : "keep";
  const from = (what) => ({ group: group.key, round: prior.round, kind: what });
  const grant = (email, amount, what) => grantCredit(stores, email, {
    amount, from: from(what), now, timeZone: terms.timeZone,
  });
  let shares = [];
  let leftover = 0;
  let settledAs = kind;

  if (kind === "share") {
    const split = splitReward(prior.reward.amount, next.members);

    shares = split.shares.filter((s) => s.amount > 0);
    leftover = split.leftover;
    // Nobody to share with: the host keeps it after all.
    if (!shares.length) settledAs = "keep";
  }

  if (settledAs === "keep") {
    const record = await getGroupRecord(stores, group.key);

    if (!record || !record.host) {
      throw new Error(`The host of ${group.key} has no email address on ` +
        "record: bin/nff groups set " + `${group.key} host=<email>`);
    }
    shares = [{ email: record.host, real: null, amount: prior.reward.amount }];
    leftover = 0;
  }

  for (const s of shares) {
    await grant(s.email, s.amount, settledAs === "share" ? "share" : "host");
  }

  const settled = {
    ...prior,
    settled: {
      at: now.toISOString(), kind: settledAs, by: next.round,
      chosen: !!prior.choice, shares, leftover,
    },
  };

  await stores.orders.set(roundKey(group.key, prior.round), settled);

  return settled;
};

// The rounds of every group whose close has passed and that have no
// record yet are closed, and every reward whose next round is closed
// is settled. Idempotent, so the jobs run it every time.
// -> { closed: [...], settled: [...], errors: [{ group, round, error }] }
export const workRounds = async (stores, { now = new Date(), terms }) => {
  const report = { closed: [], settled: [], errors: [] };
  const day = today(now, terms.timeZone);

  for (const group of GROUPS) {
    const s = terms.model.seriesOf(group.series);

    if (!s) continue;

    const dates = seriesDates(s, addDays(day, -LOOK_BACK), day)
      .filter((d) => now.getTime() > cutoffOf(d, terms.timeZone).getTime());

    for (const round of dates) {
      try {
        const r = await closeRound(stores, group, round, { now, terms });

        if (r.closed) {
          report.closed.push({
            group: group.key, round, net: r.round.net, real: r.round.real,
            reward: r.round.reward.amount, earned: r.round.reward.earned,
          });
        }
      } catch (error) {
        report.errors.push({ group: group.key, round, error: String(
          (error && error.message) || error) });
      }
    }

    const rounds = await listRounds(stores, group.key);

    for (let i = 0; i < rounds.length - 1; i++) {
      const prior = rounds[i];
      const next = rounds[i + 1];

      if (!prior.reward.earned || prior.settled) continue;

      try {
        const done = await settleReward(stores, group, prior, next, {
          now, terms,
        });

        report.settled.push({
          group: group.key, round: prior.round, kind: done.settled.kind,
          shares: done.settled.shares.length, leftover: done.settled.leftover,
        });
      } catch (error) {
        report.errors.push({ group: group.key, round: prior.round,
          error: String((error && error.message) || error) });
      }
    }
  }

  return report;
};
