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
  cancelOrder, listOrders, refundOrder, removeCustomer, removeOrder,
  showCustomer, showOrder,
} from "./admin.mjs";
import { requestLink } from "./auth.mjs";
import { links, readState, setState } from "./maintenance.mjs";
import { OUTBOX_PREFIX } from "./mail.mjs";

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
  orderCancel: async (stores, { id, reasonText }, env) => ({
    order: await cancelOrder(stores, need(id, "id"), {
      env, refund: true, reasonText: reasonText || "QA e2e",
    }),
  }),
  orderRefund: async (stores, { id, reason }, env) => ({
    order: await refundOrder(stores, need(id, "id"), {
      env, reason: reason || "QA e2e",
    }),
  }),
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
