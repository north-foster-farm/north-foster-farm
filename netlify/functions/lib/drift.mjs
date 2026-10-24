// A website order changed directly in Square (#293): a line, the
// fulfillment date or place, a cancel. The site's record stays the
// truth. A change made in Square is never copied into it, since the
// record carries the money (payments, refunds, totals) and the packing
// slips print from it; it is flagged instead. The farm gets one email
// per distinct set of differences saying what differs and whether a
// slip for the order has already printed, and puts it right with
// `bin/nff orders ...` (or reverts the change in Square).
//
// Two things notice: Square's `order.updated` and
// `order.fulfillment.updated` webhooks (the fast path) and a daily
// reconcile from the jobs (what a missed event leaves). Both end in
// checkOrder, which asks Square for the order and compares.
//
// What is compared, for a paid order only:
//   cancel   the Square order, or its fulfillment, is CANCELED
//   date     the fulfillment day, and the time within it
//   place    a delivery address, or the pickup place (the note's first
//            part); notes and instructions are not compared
//   lines    quantities per item, but not on an order the customer has
//            changed since (its items are spread over several Square
//            orders, so only the fulfillment is compared there)
//
// Nothing here writes to a record or calls Square for anything but a
// read, so a mistake costs an email, never money.

import terms from "./terms.mjs";
import { label, today } from "../../../assets/scripts/order/lib/zoned.mjs";
import { now as clock } from "./clock.mjs";
import { farmEmails, sendMail } from "./mail.mjs";
import { log } from "./log.mjs";
import { PRINTED } from "./packing.mjs";
import { getOrder, openOrders } from "./records.mjs";
import { mailLinks } from "./site.mjs";
import * as squareApi from "./square.mjs";
import { ORDER_ID, buildOrder } from "./square.mjs";
import { farmSquareChanged } from "./templates.mjs";

const tz = terms.timeZone;
const MINUTE = 60_000;

// A change the site itself just made reaches Square first and the
// record a moment later; the event for it must not be taken for a
// stranger's edit. Inside this window an order that differs is left to
// the next check.
export const SETTLE = 2 * MINUTE;

// The most orders one reconcile asks Square about.
export const RECONCILE_MAX = 60;

export const driftKey = (id) => `square-drift/${id}`;

const sameText = (a, b) => String(a || "").trim() === String(b || "").trim();

const dayOf = (iso) => today(new Date(iso), tz);

const fulfilmentOf = (squareOrder) => (squareOrder.fulfillments || [])[0];

const details = (f) => f && (f.pickup_details || f.delivery_details);

const timeOf = (f) => {
  const d = details(f);

  return d && (d.pickup_at || d.deliver_at) || null;
};

// What the record would send to Square for its fulfillment.
const expectedFulfillment = (order) => {
  try {
    return buildOrder(order, null, { locationId: "-", catalog: false })
      .fulfillments[0];
  } catch {
    return null;
  }
};

const placeOfNote = (f) => String((details(f) || {}).note || "")
  .split(" · ")[0];

const addressOf = (f) => {
  const a = ((f.delivery_details || {}).recipient || {}).address || {};

  return [a.address_line_1, a.postal_code];
};

// Square's words go into an email whose text turns ** into bold, so a
// line name or note cannot carry the mark: its asterisks become the
// look-alike asterisk operator.
const quiet = (text) => String(text).replace(/\*/g, "\u2217");

const lineDifferences = (order, squareOrder) => {
  const have = squareOrder.line_items || [];
  const out = [];
  const matched = new Set();

  for (const line of order.lines) {
    const found = have.filter((s, i) => {
      const hit = (line.squareVariationId
        && s.catalog_object_id === line.squareVariationId)
        || sameText(s.name, line.name);

      if (hit) matched.add(i);

      return hit;
    });
    const qty = found.reduce((n, s) => n + Number(s.quantity || 0), 0);

    if (!found.length) {
      out.push(`${line.label || line.name}: ${line.qty} on the site, ` +
        "not in Square");
    } else if (qty !== line.qty) {
      out.push(`${line.label || line.name}: ${line.qty} on the site, ` +
        `${qty} in Square`);
    }
  }
  have.forEach((s, i) => {
    if (!matched.has(i)) {
      out.push(`${s.quantity} × ${quiet(s.name || "an item")} in ` +
        "Square, not on the site");
    }
  });

  return out;
};

// -> the differences, as lines for the farm; none when they agree.
// `carrier` holds the fulfillment, `original` the lines: one order
// unless the customer changed the order since.
export const differences = (order, { original, carrier }) => {
  const out = [];
  const canceled = [original, carrier]
    .filter((o) => o && (o.state === "CANCELED"
      || (fulfilmentOf(o) || {}).state === "CANCELED"));

  if (canceled.length) {
    out.push("Canceled in Square; still paid and open on the site");
  }

  const want = expectedFulfillment(order);
  const got = carrier && fulfilmentOf(carrier);

  if (!canceled.length && want && got) {
    const wanted = timeOf(want);
    const seen = timeOf(got);

    if (want.type !== got.type) {
      out.push(`Fulfillment type: ${want.type.toLowerCase()} on the ` +
        `site, ${String(got.type).toLowerCase()} in Square`);
    } else {
      if (wanted && seen && dayOf(wanted) !== dayOf(seen)) {
        out.push(`Date: ${label(dayOf(wanted))} on the site, ${
          label(dayOf(seen))} in Square`);
      } else if (wanted && seen
        && new Date(wanted).getTime() !== new Date(seen).getTime()) {
        out.push("Time of day changed in Square");
      }
      if (want.type === "DELIVERY"
        && addressOf(want).join("|") !== addressOf(got).join("|")) {
        out.push("Delivery address changed in Square");
      }
      if (want.type === "PICKUP"
        && !sameText(placeOfNote(want), placeOfNote(got))) {
        out.push(`Pickup place: "${placeOfNote(want)}" on the site, "${
          quiet(placeOfNote(got))}" in Square`);
      }
    }
  }
  if (!canceled.length && original && original.line_items
    && !(order.edits || []).length) {
    out.push(...lineDifferences(order, original));
  }

  return out;
};

// The Square orders that matter for a record: the one holding the
// lines and the one holding the fulfillment.
const fetchBoth = async (order, square, opts) => {
  const ids = [order.square.squareOrderId,
    order.square.fulfilmentOrderId || order.square.squareOrderId];
  const original = await square.getOrder(ids[0], opts);

  if (!original) return null;

  const carrier = ids[1] === ids[0] ? original
    : await square.getOrder(ids[1], opts);

  return carrier ? { original, carrier } : null;
};

const lastTouched = (order) => {
  const last = (order.history || []).at(-1);

  return last ? Date.parse(last.at) : 0;
};

// Compares one order with Square and, when it differs in a way the
// farm has not been told about, emails the farm.
// -> { id, status: "match" | "known" | "settling" | "flagged" |
//      "skipped", changes? }
export const checkOrder = async (stores, order, {
  env = process.env,
  mail = sendMail,
  now = clock(),
  square = squareApi,
  fetchImpl = globalThis.fetch,
} = {}) => {
  const id = order.id;

  if (order.status !== "paid" || !order.square
    || !order.square.squareOrderId) {
    return { id, status: "skipped" };
  }

  const fetched = await fetchBoth(order, square, { env, fetchImpl });

  if (!fetched) return { id, status: "skipped" };

  const changes = differences(order, fetched);
  const key = driftKey(id);
  const tagged = await stores.jobs.getTagged(key);
  const known = tagged && tagged.value;

  if (!changes.length) {
    if (known) await stores.jobs.delete(key);

    return { id, status: "match" };
  }

  const signature = JSON.stringify(changes);

  if (known && known.signature === signature) {
    return { id, status: "known", changes };
  }
  if (now.getTime() - lastTouched(order) < SETTLE) {
    return { id, status: "settling", changes };
  }

  const printed = !!(await stores.jobs.get(`${PRINTED}${id}`));
  const to = farmEmails(env);

  log.warn({ event: "square.drift", id, printed, changes });

  const record = { signature, at: now.toISOString(), printed, changes };

  // Square sends two events within milliseconds for one edit. Claim
  // the signature before mailing so only the winner mails.
  const claimed = tagged
    ? await stores.jobs.swap(key, record, tagged.etag)
    : await stores.jobs.create(key, record);

  if (!claimed) return { id, status: "known", changes };

  if (to.length) {
    try {
      await mail({
        to,
        idempotencyKey: `square-drift-${id}-${now.getTime()}`,
        ...farmSquareChanged(order, {
          changes, printed, links: mailLinks(env),
          squareUrl: squareApi.dashboardUrl(order.square, env),
        }),
      }, { env });
    } catch (err) {
      if (known) await stores.jobs.set(key, known);
      else await stores.jobs.delete(key);

      throw err;
    }
  }

  return { id, status: "flagged", changes, printed };
};

// A Square webhook about an order. Square sends ids only; the order is
// found by the reference the site gave it.
// -> { handled, id?, status?, reason? }
export const applyOrderEvent = async (stores, event, options = {}) => {
  const data = (event && event.data && event.data.object) || {};
  const named = data.order_updated || data.order_fulfillment_updated || {};
  const squareId = named.order_id || (event.data && event.data.id);

  if (!squareId) return { handled: false, reason: "no order" };

  const square = options.square || squareApi;
  const found = await square.getOrder(squareId, {
    env: options.env || process.env, fetchImpl: options.fetchImpl,
  });
  const reference = found && found.reference_id;

  if (!reference || !ORDER_ID.test(reference)) {
    return { handled: false, reason: "not a website order" };
  }

  const order = await getOrder(stores, reference);

  if (!order) return { handled: false, reason: "no record" };

  const result = await checkOrder(stores, order, options);

  return { handled: true, ...result };
};

// Every paid order from today on, soonest first, against Square: what
// the webhooks missed, and a change that was settling when its event
// came. -> the results that are not a match.
export const reconcile = async (stores, options = {}) => {
  const day = today(options.now || clock(), tz);
  const orders = (await openOrders(stores))
    .filter((o) => o.status === "paid" && o.fulfilment
      && o.fulfilment.date >= day)
    .sort((a, b) => (a.fulfilment.date < b.fulfilment.date ? -1 : 1))
    .slice(0, RECONCILE_MAX);
  const out = [];
  const errors = [];

  for (const order of orders) {
    try {
      const r = await checkOrder(stores, order, options);

      if (["flagged", "settling"].includes(r.status)) out.push(r);
    } catch (error) {
      errors.push({ id: order.id, error: String(error && error.message) });
    }
  }

  return { checked: orders.length, found: out, errors };
};
