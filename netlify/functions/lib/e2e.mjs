// The end-to-end suite's back office on a staging deploy. The suite
// used to reach the deploy's records with the developer's own Netlify
// personal access token (the Blobs credentials of `bin/nff --staging`).
// A token that reads every store of the account has no place in a test
// run, so the deploy does the work itself: POST /api/staging/e2e
// { op, ...args }, with E2E_STAGING_TOKEN, a token of its own that
// opens nothing else (staging.mjs). Each op is one thing the suite
// did through the CLI, and the deploy's own stores are the only ones
// it can touch.

import {
  cancelOrder, decideAddress, fulfillOrder, listOrders, markAttempted,
  refundOrder, removeCustomer, removeOrder, showCustomer, showOrder,
} from "./admin.mjs";
import { requestLink } from "./auth.mjs";
import { MAX_OFFSET } from "./clock.mjs";
import { runJobs } from "./jobs.mjs";
import { links, readState, setState } from "./maintenance.mjs";
import { OUTBOX_PREFIX } from "./mail.mjs";
import { requestSubscribe } from "./news.mjs";
import { issuePass, passKey } from "./passes.mjs";
import { getCustomer, saveCustomer } from "./records.mjs";
import { quietAccounts } from "./retention.mjs";
import * as squareApi from "./square.mjs";

const need = (value, what) => {
  if (!value) throw new Error(`${what} is required.`);

  return String(value);
};

const lower = (value) => String(value).toLowerCase();

// The messages the contact page stored from one address.
const messagesFrom = async (stores, email) => {
  const keys = (await stores.customers.list("messages/")).map((k) => k.key);
  const found = await Promise.all(keys.map(async (key) => ({
    key, ...(await stores.customers.get(key)),
  })));

  return found.filter((m) => m.email === lower(email));
};

const toList = (to) => (Array.isArray(to) ? to : [to]).map(lower);

export const OPS = {
  ordersList: async (stores, { email, status }) => ({
    orders: (await listOrders(stores, { email, status }))
      .map((o) => ({ id: o.id, status: o.status })),
  }),
  orderShow: async (stores, { id }) => ({
    order: await showOrder(stores, need(id, "id")),
  }),
  // `refund: false` is the CLI's --no-refund (RF-03).
  orderCancel: async (stores, { id, reasonText, refund = true }, env) => ({
    order: await cancelOrder(stores, need(id, "id"), {
      env, refund: refund !== false, reasonText: reasonText || "QA e2e",
    }),
  }),
  // `amount` is cents, as the CLI's --amount is dollars (RF-01).
  orderRefund: async (stores, { id, reason, amount }, env) => ({
    order: await refundOrder(stores, need(id, "id"), {
      env, reason: reason || "QA e2e",
      ...(amount !== undefined && { amount: Number(amount) }),
    }),
  }),
  // The farm hands the order over, as `bin/nff orders fulfill` does.
  orderFulfil: async (stores, { id }, env) => ({
    order: await fulfillOrder(stores, need(id, "id"), { env }),
  }),
  // Square's own copy of the order's Square order, for a check that the
  // site's change reached it, and what it was charged (a pass's $0
  // delivery fee, #182). `fake` is true where there is no Square.
  squareOrder: async (stores, { id }, env) => {
    const order = await showOrder(stores, need(id, "id"));
    const squareOrderId = order.square && order.square.squareOrderId;

    if (!squareOrderId) throw new Error("This order has no Square order.");

    const found = await squareApi.getOrder(squareOrderId, { env });
    const cents = (money) => (money ? money.amount : null);

    return {
      fake: squareApi.isFake(env),
      squareOrder: {
        id: squareOrderId,
        state: found.state,
        fulfillments: (found.fulfillments || []).map((f) => ({
          type: f.type, state: f.state,
        })),
        serviceCharges: (found.service_charges || []).map((c) => ({
          name: c.name, amount: cents(c.amount_money),
        })),
        discounts: (found.discounts || []).map((d) => ({
          name: d.name, amount: cents(d.amount_money),
        })),
        total: cents(found.total_money),
      },
    };
  },
  // The delivery did not happen: `cause` as `bin/nff orders attempt`
  // takes it. A customer's miss asks them what to do; the farm's or
  // the weather's moves the delivery on.
  orderAttempt: async (stores, { id, cause, waive }, env) => ({
    order: await markAttempted(stores, need(id, "id"), {
      cause: need(cause, "cause"), waive: waive || "", env,
    }),
  }),
  addressDecide: async (stores, { email, decision }, env) => ({
    customer: await decideAddress(stores, need(email, "email"),
      need(decision, "decision"), { env }),
  }),
  // The confirmation email the public sign-up form sends (#129: the
  // old list is imported, not invited). Nobody is on the list until
  // its link is followed.
  newsSubscribeRequest: async (stores, { email }, env) => {
    const r = await requestSubscribe(stores, { email: need(email, "email") },
      { env, limit: false });

    if (!r.ok) throw new Error(`Could not ask: ${r.reason}.`);

    return { ok: true, email: r.email };
  },
  // A customer last seen `years` years ago, for the quiet notice. No
  // order or session of theirs is touched.
  customerSeedQuiet: async (stores, { email, years = 2 }) => {
    const address = lower(need(email, "email"));

    if (await getCustomer(stores, address)) {
      throw new Error("That customer already has a record.");
    }

    const then = new Date();

    then.setUTCFullYear(then.getUTCFullYear() - Number(years));

    return {
      customer: await saveCustomer(stores, {
        email: address, firstName: "Quiet", createdAt: then.toISOString(),
        marketing: true, marketingAt: then.toISOString(),
        marketingSource: "signup",
      }),
    };
  },
  // The quiet-account notice, for the one address, as the daily job
  // sends it to every address that is due.
  quietRun: async (stores, { email }, env) => ({
    report: await quietAccounts(stores, {
      env, only: [lower(need(email, "email"))],
    }),
  }),
  // The scheduled jobs as of `at` (an ISO time within the clock's
  // reach), working only the named orders. The sweeps and reports keep
  // the real time, as in the toolbar's run.
  jobsRun: async (stores, { at, orders }, env) => {
    const when = new Date(need(at, "at"));

    if (Number.isNaN(when.getTime())
      || Math.abs(when.getTime() - Date.now()) > MAX_OFFSET) {
      throw new Error("Bad at: within three years of now.");
    }
    if (!Array.isArray(orders) || !orders.length) {
      throw new Error("orders is required: the ids to work.");
    }

    const report = await runJobs(stores, {
      env, now: when, orderIds: orders,
    });

    return {
      report: {
        deliveryReminded: report.deliveryReminded, closed: report.closed,
        missedTold: report.missedTold, errors: report.errors,
      },
    };
  },
  orderDelete: async (stores, { id }) => {
    await removeOrder(stores, need(id, "id"));

    return { ok: true };
  },
  customerShow: async (stores, { email }) =>
    showCustomer(stores, need(email, "email")),
  customerDelete: async (stores, { email }) => {
    await removeCustomer(stores, need(email, "email"));

    return { ok: true };
  },
  // A sign-in link that is not mailed, as `bin/nff login` makes one.
  login: async (stores, { email }, env) => {
    const r = await requestLink(stores, { email, next: "/account/" }, {
      env, send: false,
    });

    if (!r.ok) throw new Error(`Could not make a link: ${r.reason}.`);

    return { url: r.url };
  },
  maintenanceStatus: async (stores) => ({ on: (await readState(stores)).on }),
  maintenanceSet: async (stores, { on }, env) => ({
    changed: (await setState(stores, on === true, {
      by: "e2e", env,
    })).changed,
  }),
  maintenanceLinks: async (stores, args, env) => ({
    links: links(env, (await readState(stores)).epoch),
  }),
  messagesList: async (stores, { email }) => ({
    messages: await messagesFrom(stores, need(email, "email")),
  }),
  messagesDelete: async (stores, { email }) => {
    const found = await messagesFrom(stores, need(email, "email"));

    for (const m of found) await stores.customers.delete(m.key);

    return { removed: found.length };
  },
  // A pass for one order (#182), as `bin/nff passes issue` makes one:
  // single use, for a day, tied to `email` when given, and waiving the
  // fee when asked. -> { code }.
  passIssue: async (stores, { email, waiveFee }) => ({
    code: (await issuePass(stores, {
      email: email || null, days: 1, waiveFee: !!waiveFee, note: "e2e",
    })).code,
  }),
  // The spec's pass, used or not, gone when the run is done.
  passDelete: async (stores, { code }) => {
    await stores.orders.delete(passKey(need(code, "code")));

    return { removed: true };
  },
  // Every message in the outbox with its HTML and text, newest first.
  outboxList: async (stores) => {
    const found = await Promise.all(
      (await stores.jobs.list(OUTBOX_PREFIX)).map(({ key }) =>
        stores.jobs.get(key))
    );

    return { messages: found.filter((m) => m && m.id).reverse() };
  },
  // Every outbox message to `to`, or whose subject contains `subject`,
  // with an id (the send time) at or after `floor`.
  outboxClear: async (stores, { to, subject, floor = "" }) => {
    let removed = 0;

    for (const { key } of await stores.jobs.list(OUTBOX_PREFIX)) {
      const m = await stores.jobs.get(key);
      const named = m && ((to && toList(m.to).includes(lower(to)))
        || (subject && String(m.subject).includes(subject)));
      const hit = named && String(m.id) >= floor;

      if (hit) {
        await stores.jobs.delete(key);
        removed += 1;
      }
    }

    return { removed };
  },
};

// -> a Response body object and status for one op.
export const runOp = async (stores, body, env) => {
  const op = OPS[body && body.op];

  if (!op) return { status: 400, body: { error: "Unknown op." } };

  try {
    return { status: 200, body: await op(stores, body, env) };
  } catch (error) {
    const status = /not found|no such/i.test(error.message) ? 404 : 400;

    return { status, body: { error: error.message } };
  }
};
