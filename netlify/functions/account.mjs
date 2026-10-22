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
//   POST  /api/account/delete                 { email } deletes the
//                                             customer's details and
//                                             signs out (#189) when it
//                                             is the account's address

import {
  cancelOrder, changeOrder, listOrders, requestReturn, saveAddress,
  sendSupport, updateProfile,
} from "./lib/account.mjs";
import { now as clock } from "./lib/clock.mjs";
import { editOrder } from "./lib/edit.mjs";
import {
  clearCookieHeader, clearStampHeader, publicCustomer, sameSite, sessionFrom,
} from "./lib/auth.mjs";
import { forgetCustomer } from "./lib/forget.mjs";
import { json, readJson } from "./lib/http.mjs";
import { withLog } from "./lib/log.mjs";
import { gate } from "./lib/maintenance.mjs";
import { leaving, leavingChange, noteInteraction } from "./lib/retention.mjs";
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
  now = clock(),
  mail,
  square,
  news,
  fetchImpl,
} = {}) => {
  // Under maintenance the whole area answers with the message, reads
  // included, so a signed-in customer's pages show it (#267).
  const closed = await gate(stores, { req, env, now, area: "account" });

  if (closed) return closed;

  const session = await sessionFrom(stores, req, { now });

  if (!session) return json(401, { error: "Please sign in." });

  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, "");
  const customer = session.customer;
  const opts = { now, env, mail, square };
  // What the customer did while signed in counts as an interaction
  // (#189); only turning things off does not (lib/retention.mjs).
  const took = async (result, { leave = false } = {}) => {
    if (result.ok && leave) {
      await leaving(stores, customer.email, { session: session.id });
    } else if (result.ok) {
      await noteInteraction(stores, customer.email, "account", { now });
    }

    return result;
  };

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
      return answer(await took(await cancelOrder(stores, customer, id, opts)));
    }
    if (action === "change") {
      return answer(await took(
        await changeOrder(stores, customer, id, body, opts)));
    }
    if (action === "edit") {
      return answer(await took(await editOrder(stores, customer, id, body, {
        ...opts, group: customer.discountGroup || null,
      })));
    }

    return answer(await took(
      await requestReturn(stores, customer, id, body, opts)));
  }

  if (req.method === "PATCH" && path === "/api/account/profile") {
    // Against the record as it was, before the save changes it.
    const leave = leavingChange(body, customer);
    const result = await took(await updateProfile(stores, customer, body),
      { leave });

    return result.ok
      ? json(200, { ok: true, customer: publicCustomer(result.customer) })
      : answer(result);
  }

  if (req.method === "PUT" && path === "/api/account/address") {
    const result = await took(await saveAddress(stores, customer, body, opts));

    return result.ok
      ? json(200, { ok: true, customer: publicCustomer(result.customer) })
      : answer(result);
  }

  if (req.method === "POST" && path === "/api/account/support") {
    return answer(await took(await sendSupport(stores, customer, body, opts)));
  }

  if (req.method === "POST" && path === "/api/account/delete") {
    // The typed address is the confirmation: trimmed, any case.
    const fold = (s) => String(s || "").trim().toLowerCase();

    if (!fold(body.email) || fold(body.email) !== fold(customer.email)) {
      const message = "That isn't the email address on this account.";

      return json(422, { message, errors: { email: message } });
    }

    const result = await forgetCustomer(stores, customer.email, {
      apply: true, env, now, ...(news ? { news } : {}),
      ...(fetchImpl ? { fetchImpl } : {}),
    });

    if (!result.ok) {
      return json(result.wait === "square" ? 503 : 409,
        { message: result.message });
    }

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: [
        ["Content-Type", "application/json; charset=utf-8"],
        ["Cache-Control", "no-store"],
        ["Set-Cookie", clearCookieHeader()],
        ["Set-Cookie", clearStampHeader()],
      ],
    });
  }

  return json(404, { error: "Not found." });
};

export default withLog("account", async (req) => handle(req));

export const config = {
  path: ["/api/account/orders", "/api/account/orders/*", "/api/account/*"],
};
