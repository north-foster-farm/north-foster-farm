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
import { dollars } from "../../../assets/scripts/order/lib/totals.mjs";
import {
  addDays, instant, today,
} from "../../../assets/scripts/order/lib/zoned.mjs";
import { applyChange, planChange } from "./account.mjs";
import { grantCredit } from "./credit.mjs";
import {
  GROUPS, getGroupRecord, memberKeyOf, roundOccurrence, roundOrders,
  roundSummary,
} from "./groups.mjs";
import { sendMail } from "./mail.mjs";
import { OPEN, getCustomer } from "./records.mjs";
import * as squareApi from "./square.mjs";

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
// A round under the group's minimum, once James sets one (James,
// 6405681338; none in November, the pilot), rolls over: its open
// orders move to the next round through the farm's own change, which
// keeps Square in step and tells each member, and they count there.
// A member who would rather not wait cancels on the account page for
// a full refund. The rolled round earns no reward of its own.
export const belowMinimum = (group, sum) =>
  Number.isFinite(group.roundMinimum) && group.roundMinimum > 0
  && sum.net < group.roundMinimum * 100;

// When a round's books close: the end of its pickup day, so the
// walk-in sales of the morning count (security review, 6425904452).
// Ordering still closes at 11:59 PM the day before (lib/dates.mjs).
export const closeAt = (round, timeZone) =>
  instant(round, 23, 59, timeZone);

// How many times a change to a round reads it again after losing a
// swap to another writer before giving up.
const SWAPS = 5;

// Reads the round, lets `change` decide from what is stored, and
// writes only if no one wrote in between (the scheduled job and the
// farm's `groups close` can meet). `change` -> the next record, or
// null to write nothing. -> what is stored after.
const swapRound = async (stores, key, round, change) => {
  const k = roundKey(key, round);

  for (let i = 0; i < SWAPS; i++) {
    const found = await stores.orders.getTagged(k);

    if (!found) throw new Error(`Round ${round} is not closed yet.`);

    const next = change(found.value);

    if (!next) return found.value;
    if (await stores.orders.swap(k, next, found.etag)) return next;
  }

  throw new Error(`Round ${round} kept changing; try again.`);
};

// Closes a round once: its orders added up as they stand, the reward
// worked out. The record is written only if absent, before any order
// is moved, so two closers at once move nothing twice; a round
// already closed is answered as it is.
// -> { round, closed } with `closed` true when this call did it.
export const closeRound = async (stores, group, round, {
  now = new Date(), terms, env = process.env, mail = sendMail,
  square = squareApi,
}) => {
  const found = await getRound(stores, group.key, round);

  if (found) return { round: found, closed: false };

  const orders = await roundOrders(stores, group.key, round);
  const sum = roundSummary(orders);
  const open = orders.filter((o) => OPEN.includes(o.status));
  const s = terms.model.seriesOf(group.series);
  const rollsTo = belowMinimum(group, sum) && open.length && s
    ? seriesDates(s, addDays(round, 1), addDays(round, LOOK_BACK))[0] || null
    : null;
  const creditOf = (email) => orders
    .filter((o) => o.customer.email === email)
    .reduce((t, o) => t + creditPaid(o), 0);
  const credited = orders.reduce((t, o) => t + creditPaid(o), 0);
  const real = sum.net - credited;
  const record = {
    group: group.key,
    round,
    occurrence: roundOccurrence(group, round),
    cutoff: cutoffOf(round, terms.timeZone).toISOString(),
    closesAt: closeAt(round, terms.timeZone).toISOString(),
    closedAt: now.toISOString(),
    count: sum.count,
    net: sum.net,
    credited,
    real,
    percent: group.hostReward.percent,
    threshold: group.hostReward.threshold,
    minimum: group.roundMinimum || null,
    // Rolled over: its orders count in the next round, and this one
    // earns nothing of its own.
    ...(rollsTo ? { rolledTo: rollsTo, moved: [], stuck: [] } : {}),
    reward: rollsTo
      ? { earned: false, amount: 0, leftover: 0, rolled: true }
      : rewardFor(real, group.hostReward),
    members: sum.members.map((m) => ({
      email: m.email, name: m.name, orders: m.orders, net: m.net,
      real: m.net - creditOf(m.email), walkIn: m.walkIn,
    })),
    pickList: sum.pickList,
    choice: null,
    settled: null,
  };

  if (!(await stores.orders.create(roundKey(group.key, round), record))) {
    return { round: await getRound(stores, group.key, round), closed: false };
  }
  if (!rollsTo) return { round: record, closed: true };

  const moved = [];
  const stuck = [];

  for (const o of open) {
    const plan = planChange(o, {
      method: "scheduled", occurrence: roundOccurrence(group, rollsTo),
    }, { now, env, by: "farm", member: group });

    if (plan.errors) {
      stuck.push({ id: o.id, errors: plan.errors });
      continue;
    }
    await applyChange(stores, o, plan, { now, env, mail, square, by: "farm" });
    moved.push(o.id);
  }

  const rolled = await swapRound(stores, group.key, round,
    (stored) => ({ ...stored, moved, stuck }));

  return { round: rolled, closed: true };
};

// The host's choice for a round's reward, until it is settled.
export const chooseReward = async (stores, group, round, kind, {
  now = new Date(), by = "farm",
} = {}) => {
  if (!CHOICES.includes(kind)) {
    throw new Error(`The choice is one of: ${CHOICES.join(", ")}.`);
  }

  return swapRound(stores, group.key, round, (record) => {
    if (!record.reward.earned) {
      throw new Error(`Round ${round} earned no reward (real money ${
        record.real} cents, under $${record.threshold}).`);
    }
    if (record.settled && record.settled.failed) {
      throw new Error(`Round ${round}'s reward is being ${
        record.settled.kind === "share" ? "shared out" : "credited"} after ` +
        "a failure; the next jobs run finishes it, and the choice can't " +
        "change now.");
    }
    if (record.settled) {
      throw new Error(`Round ${round}'s reward is already ${
        record.settled.kind === "share" ? "shared out" : "credited"}.`);
    }

    return { ...record, choice: { kind, at: now.toISOString(), by } };
  });
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
// real spend. Once: the settlement is claimed on the record with a
// conditional write before any credit is granted, so two settlers at
// once grant nothing twice. Throws when the host's email is not on
// record and the reward is to be kept, so the farm hears and sets
// it; the claim is let go and the next run settles it then.
// -> the prior round as settled.
export const settleReward = async (stores, group, prior, next, {
  now = new Date(), terms,
}) => {
  if (!prior.reward.earned) return prior;
  if (prior.settled && !prior.settled.failed) return prior;

  // A settlement that failed partway is taken up again as the kind
  // it failed as (security re-re-review, 6427102482): its grants
  // stand, and only the missing ones are made.
  const claimed = await swapRound(stores, group.key, prior.round,
    (stored) => (stored.settled && !stored.settled.failed ? null : {
      ...stored,
      settled: {
        pending: true, at: now.toISOString(),
        ...(stored.settled && stored.settled.failed
          ? { kind: stored.settled.kind, retry: true } : {}),
      },
    }));

  // Someone else holds or finished the settlement.
  if (!claimed.settled || !claimed.settled.pending
    || claimed.settled.at !== now.toISOString()) {
    return claimed;
  }

  // Lets the claim go: with nothing granted yet (no host on record),
  // wholly, so the host can still choose; after a grant failed, as a
  // failed settlement of the kind begun, which the next run finishes
  // and no new choice can change.
  const letGo = (failedAs = null) => swapRound(stores, group.key, prior.round,
    (stored) => (stored.settled && stored.settled.pending
      ? {
        ...stored,
        settled: failedAs
          ? { failed: true, kind: failedAs, at: now.toISOString() }
          : null,
      }
      : null));
  const kind = claimed.settled.retry
    ? claimed.settled.kind
    : (claimed.choice ? claimed.choice.kind : "keep");
  const from = (what) => ({ group: group.key, round: prior.round, kind: what });
  const grant = (email, amount, what) => grantCredit(stores, email, {
    amount, from: from(what), now, timeZone: terms.timeZone,
  });
  let shares = [];
  let leftover = 0;
  let settledAs = kind;

  if (kind === "share") {
    // Only those still in the group share it (#495): a member removed,
    // or who left, before this close gets nothing of it.
    const still = [];

    for (const m of next.members) {
      if (memberKeyOf(await getCustomer(stores, m.email)) === group.key) {
        still.push(m);
      }
    }

    const split = splitReward(claimed.reward.amount, still);

    shares = split.shares.filter((s) => s.amount > 0);
    leftover = split.leftover;
    // Nobody to share with: the host keeps it after all.
    if (!shares.length) settledAs = "keep";
  }

  if (settledAs === "keep") {
    const record = await getGroupRecord(stores, group.key);

    if (!record || !record.host) {
      await letGo();
      throw new Error(`The host of ${group.key} has no email address on ` +
        "record: bin/nff groups set " + `${group.key} host=<email>`);
    }
    shares = [{ email: record.host, real: null,
      amount: claimed.reward.amount }];
    leftover = 0;
  }

  // Grants are keyed on the round and kind, so a retry after a
  // failure here finds the ones made and grants the rest; the claim
  // is let go so the next run is that retry (security re-review,
  // 6426747224), and the failure goes on the jobs' report.
  try {
    for (const s of shares) {
      await grant(s.email, s.amount, settledAs === "share" ? "share" : "host");
    }
  } catch (error) {
    await letGo(settledAs);
    throw error;
  }

  return swapRound(stores, group.key, prior.round, (stored) => ({
    ...stored,
    settled: {
      at: now.toISOString(), kind: settledAs, by: next.round,
      chosen: !!claimed.choice, shares, leftover,
    },
  }));
};

// The rounds of every group whose close has passed and that have no
// record yet are closed, and every reward whose next round is closed
// is settled. Idempotent, so the jobs run it every time.
// -> { closed: [...], settled: [...], errors: [{ group, round, error }] }
export const workRounds = async (stores, {
  now = new Date(), terms, env = process.env, mail = sendMail,
  square = squareApi,
}) => {
  const report = { closed: [], settled: [], errors: [] };
  const day = today(now, terms.timeZone);

  for (const group of GROUPS) {
    const s = terms.model.seriesOf(group.series);

    if (!s) continue;

    const dates = seriesDates(s, addDays(day, -LOOK_BACK), day)
      .filter((d) => now.getTime() > closeAt(d, terms.timeZone).getTime());

    for (const round of dates) {
      try {
        const r = await closeRound(stores, group, round, {
          now, terms, env, mail, square,
        });

        if (r.closed) {
          report.closed.push({
            group: group.key, round, net: r.round.net, real: r.round.real,
            reward: r.round.reward.amount, earned: r.round.reward.earned,
            ...(r.round.rolledTo ? { rolledTo: r.round.rolledTo,
              moved: r.round.moved.length } : {}),
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

      // A settlement that failed partway is taken up again.
      if (!prior.reward.earned
        || (prior.settled && !prior.settled.failed)) continue;

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

// What a round's reward came to, for the farm: rolled, earned (with
// the cents rounding kept back) or none.
export const rewardWords = (r) => {
  if (r.rolledTo) {
    const moved = (r.moved || []).length;
    const stuck = (r.stuck || []).length;

    return `rolled to ${r.rolledTo} (${moved} order${moved === 1 ? "" : "s"
    } moved${stuck ? `, ${stuck} stuck` : ""})`;
  }
  if (!r.reward.earned) return `no reward (under $${r.threshold})`;

  return `reward ${dollars(r.reward.amount)}${r.reward.leftover
    ? ` (+${r.reward.leftover}¢ kept back)` : ""}`;
};

// Where a round's reward stands: settled (to whom, with what rounding
// kept back), being settled, failed partway (the next run finishes
// it), chosen but not yet settled, or awaiting the host's choice. ""
// for a round with nothing to settle.
export const settlementWords = (r) => {
  const s = r.settled;
  const as = (kind) => (kind === "share" ? "shared out" : "credited");

  if (s && s.failed) {
    return `${as(s.kind)} partway, failed at ${s.at.slice(0, 16).replace(
      "T", " ")} UTC; the next jobs run finishes it`;
  }
  if (s && s.pending) {
    return `being ${as(s.kind || (r.choice ? r.choice.kind : "keep"))} now`;
  }
  if (s) {
    const n = (s.shares || []).length;

    return `${s.kind === "share" ? "shared among" : "credited to"} ${n}${
      s.leftover ? `, ${dollars(s.leftover)} kept back` : ""}`;
  }
  if (r.choice) return `${r.choice.kind}, not yet settled`;

  return r.reward.earned ? "awaiting the host's choice" : "";
};

// One line of `bin/nff groups rounds`.
export const roundLine = (r) => {
  const state = settlementWords(r);

  return `${r.round}  ${r.count} orders  net ${dollars(r.net)}  real ${
    dollars(r.real)}  ${rewardWords(r)}${state ? `  ${state}` : ""}`;
};
