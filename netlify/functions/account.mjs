// The signed-in customer's API. Every route needs a live session;
// state changes must come from this site.
//
//   GET   /api/account/orders                 the customer's orders
//   POST  /api/account/orders/:id/cancel
//   POST  /api/account/orders/:id/change      { date, onfarm, delivery, notes }
//   POST  /api/account/orders/:id/edit        the order as it should be,
//                                             paying or refunding the
//                                             difference (lib/edit.mjs)
//   POST  /api/account/orders/:id/return      { reason, skus }
//   PATCH /api/account/profile                { firstName, lastName, phone,
//                                               avatar, reminders, marketing }
//   PUT   /api/account/address                { address1, ..., zip, cooler }
//   POST  /api/account/support                { subject, message, orderId }

import {
  cancelOrder, changeOrder, listOrders, requestReturn, saveAddress,
  sendSupport, updateProfile,
} from "./lib/account.mjs";
import { editOrder } from "./lib/edit.mjs";
import { publicCustomer, sameSite, sessionFrom } from "./lib/auth.mjs";
import { json, readJson } from "./lib/http.mjs";
import { withLog } from "./lib/log.mjs";
import { stores as defaultStores } from "./lib/store.mjs";

// Ownership is checked by the logic; the route only shapes the id.
const ORDER = new RegExp("^/api/account/orders/([A-Za-z0-9-]{1,32})/" +
  "(cancel|change|edit|return)$");

// A failure keeps what came with its errors (an edit's fresh totals,
// stock or dates, a decline), for the page to act on.
const answer = (result) => {
  if (result.ok) return json(200, result);

  const { status, ...rest } = result;

  return json(status || 400, { ...rest, ok: undefined });
};

export const handle = async (req, {
  stores = defaultStores(),
  env = process.env,
  now = new Date(),
  mail,
  square,
} = {}) => {
  const session = await sessionFrom(stores, req, { now });

  if (!session) return json(401, { error: "Please sign in." });

  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, "");
  const customer = session.customer;
  const opts = { now, env, mail, square };

  if (req.method === "GET" && path === "/api/account/orders") {
    return answer(await listOrders(stores, customer, { now }));
  }

  if (req.method === "GET") return json(404, { error: "Not found." });
  if (!sameSite(req)) return json(403, { error: "Cross-site request." });

  const body = await readJson(req);

  if (body === null) return json(400, { errors: { body: "Expected JSON." } });

  const m = path.match(ORDER);

  if (m && req.method === "POST") {
    const [, id, action] = m;

    if (action === "cancel") {
      return answer(await cancelOrder(stores, customer, id, opts));
    }
    if (action === "change") {
      return answer(await changeOrder(stores, customer, id, body, opts));
    }
    if (action === "edit") {
      return answer(await editOrder(stores, customer, id, body, {
        ...opts, group: customer.discountGroup || null,
      }));
    }

    return answer(await requestReturn(stores, customer, id, body, opts));
  }

  if (req.method === "PATCH" && path === "/api/account/profile") {
    const result = await updateProfile(stores, customer, body);

    return result.ok
      ? json(200, { ok: true, customer: publicCustomer(result.customer) })
      : answer(result);
  }

  if (req.method === "PUT" && path === "/api/account/address") {
    const result = await saveAddress(stores, customer, body, opts);

    return result.ok
      ? json(200, { ok: true, customer: publicCustomer(result.customer) })
      : answer(result);
  }

  if (req.method === "POST" && path === "/api/account/support") {
    return answer(await sendSupport(stores, customer, body, opts));
  }

  return json(404, { error: "Not found." });
};

export default withLog(async (req) => handle(req));

export const config = {
  path: ["/api/account/orders", "/api/account/orders/*", "/api/account/*"],
};
