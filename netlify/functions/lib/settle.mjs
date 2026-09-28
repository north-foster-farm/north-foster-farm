// Every refund we believe went out, checked against the processor that
// made it (#215). The webhooks hear most endings as they happen; this
// catches the rest: a Square event that never came, a Venmo refund
// PayPal failed or cancelled (its webhook hears only completed ones),
// and a refund that sits pending for days. Once a day from the jobs,
// and on demand with `bin/nff refunds check`.
//
//   COMPLETED           noted on the order, and checked no more
//   FAILED, REJECTED,   marked on the order, no longer counted as
//   CANCELLED           refunded, and the farm alerted (refund.failed)
//   still pending       once STALL_AFTER has passed, the farm alerted,
//                       once per refund (refund.stalled)
//   no processor id     nothing to ask: stalled, the same way
//
// A Venmo refund is asked of PayPal, whose word is the customer's
// money; its Square refund only keeps Square's books.

import { alert } from "./health.mjs";
import * as paypalApi from "./paypal.mjs";
import {
  FAILED_REFUND, allOrders, amendOrder, getOrder, moneyPatch, refundsOf,
} from "./records.mjs";
import * as squareApi from "./square.mjs";

const DAY = 24 * 60 * 60 * 1000;

// Every refund email promises "Your refund can take a few days to
// reach you."
export const STALL_AFTER = 5 * DAY;

export const settled = (refund) => refund.status === "COMPLETED"
  || FAILED_REFUND.includes(refund.status);

// The refunds still waiting on the processor's word, each with its
// order.
export const unsettled = (orders) => orders.flatMap((order) =>
  refundsOf(order).filter((r) => !settled(r))
    .map((refund) => ({ order, refund })));

const viaOf = (refund) => {
  if (refund.paypalRefundId) return "paypal";

  return refund.squareRefundId ? "square" : null;
};

// The processor's status for a refund, or null when it has no id.
const ask = async (refund, { square, paypal, env, fetchImpl, now }) => {
  if (refund.paypalRefundId) {
    if (!paypal) throw new Error("PayPal is not configured.");

    return (await paypal.getRefund(refund.paypalRefundId, {
      env, fetchImpl, now,
    })).status;
  }
  if (refund.squareRefundId) {
    return (await square.getRefund(refund.squareRefundId, {
      env, fetchImpl,
    })).status;
  }

  return null;
};

const same = (a, b) => a.at === b.at
  && a.squareRefundId === b.squareRefundId
  && a.paypalRefundId === b.paypalRefundId;

// One refund changed on the order as it is now, so a refund recorded
// meanwhile is kept.
const note = async (stores, id, refund, patch, event, now) => {
  const current = await getOrder(stores, id);
  const refunds = refundsOf(current)
    .map((r) => (same(r, refund) ? { ...r, ...patch } : r));

  return amendOrder(stores, id, moneyPatch(current, { refunds }), event, now);
};

// -> { checked, completed, failed, stalled, pending, errors }, each
// list of { id, via, refund, amount, at, status }. `stalled` holds
// every late refund, alerted this time or before.
export const checkRefunds = async (stores, {
  now = new Date(),
  env = process.env,
  mail,
  square = squareApi,
  paypal = paypalApi.configured(env) ? paypalApi : null,
  fetchImpl = globalThis.fetch,
} = {}) => {
  const report = {
    checked: 0, completed: [], failed: [], stalled: [], pending: [],
    errors: [],
  };
  // The stalled refunds not alerted before.
  const fresh = [];

  for (const { order, refund } of unsettled(await allOrders(stores))) {
    const row = {
      id: order.id,
      via: viaOf(refund),
      refund: refund.paypalRefundId || refund.squareRefundId || null,
      amount: refund.amount || 0,
      at: refund.at,
    };
    let status;

    report.checked += 1;
    try {
      status = await ask(refund, { square, paypal, env, fetchImpl, now });
    } catch (error) {
      report.errors.push({ ...row, error: String(error && error.message) });
      continue;
    }

    if (status === "COMPLETED") {
      await note(stores, order.id, refund, { status }, "refund.completed",
        now);
      report.completed.push({ ...row, status });
    } else if (FAILED_REFUND.includes(status)) {
      await note(stores, order.id, refund, { status }, "refund.failed", now);
      report.failed.push({ ...row, status });
    } else if (now.getTime() - Date.parse(refund.at) < STALL_AFTER) {
      report.pending.push({ ...row, status });
    } else {
      report.stalled.push({ ...row, status });
      if (!refund.stalledAt) {
        fresh.push({ ...row, status });
        await note(stores, order.id, refund, { stalledAt: now.toISOString() },
          "refund.stalled", now);
      }
    }
  }

  // One alert per kind for the lot, since alerts of a kind are held
  // for an hour after the first.
  const opts = { env, mail, now, fetchImpl };

  if (report.failed.length) {
    await alert(stores, "refund.failed", {
      count: report.failed.length, refunds: report.failed,
    }, opts);
  }
  if (fresh.length) {
    await alert(stores, "refund.stalled", {
      count: fresh.length, refunds: fresh,
    }, opts);
  }

  return report;
};
