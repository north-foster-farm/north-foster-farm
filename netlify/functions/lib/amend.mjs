// The farm's change to any order (`bin/nff orders change`), past,
// present or future, in any status. The customer's rules (the cutoff,
// open dates, occurrences closed to customers) do not bind the farm:
// where the change overrides one, the plan carries a warning. What
// does bind it: the occurrence must exist, and the values must be well
// formed.
//
// A change is planned first (`planAmend`, which saves and sends
// nothing), so the CLI can list every side effect before anything
// happens, and `--dry-run` prints the list and stops. Then:
//
//   money     a change whose Square update could move money (a fee
//             that appears or goes, a charge, a refund) is refused
//             unless `force`; even then none moves, and the record's
//             totals stay as they were
//   Square    follows the change unless `noSquare`; when Square won't
//             take it, nothing is applied unless `force`, which
//             applies the record and reports what Square kept
//   email     the customer's "order changed" email, unless the
//             process withholds it (--no-email); the farm is not told
//             of its own change
//   history   `farm.changed` carries the before and after, the
//             warnings, and what happened to Square

import catalog from "../../../data/catalog.json" with { type: "json" };
import discountCodes from "../../../data/discount-codes.json" with {
  type: "json",
};
import { indexCatalog } from "../../../assets/scripts/order/lib/catalog.mjs";
import {
  datesFor, isScheduled, modelled, occurrenceFor, orderOccurrence,
} from "../../../assets/scripts/order/lib/dates.mjs";
import { dollars } from "../../../assets/scripts/order/lib/totals.mjs";
import {
  CONTACT, phoneOk, validateOrder, zipInfo,
} from "../../../assets/scripts/order/lib/validate.mjs";
import { today } from "../../../assets/scripts/order/lib/zoned.mjs";
import { planEdit } from "./edit.mjs";
import { now as clock } from "./clock.mjs";
import { sendMail } from "./mail.mjs";
import { customerEmailWithheld, sendForOrder } from "./payments.mjs";
import { pickupSchedule } from "./pickups.mjs";
import { getCustomer, getOrder, saveOrder } from "./records.mjs";
import { mailLinks, orderUrlFor } from "./site.mjs";
import * as squareApi from "./square.mjs";
import { methodName, placeOf } from "./describe.mjs";
import terms from "./terms.mjs";
import { orderChanged } from "./templates.mjs";

const index = indexCatalog(catalog);
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const METHODS = ["onfarm", "scheduled", "delivery"];

const fail = (errors, extra = {}) => ({ ok: false, errors, ...extra });

// "Foster Farmers Market, Shady Acres Diner, ..., Sun Oct 25 9:00 AM –
// 1:00 PM": what a fulfilment is, for the plan's before and after.
const describe = (order) => {
  const f = order.fulfilment;
  const where = placeOf(order);
  const id = where.occurrence ? ` (${where.occurrence})` : "";

  return [
    `${methodName(f.method)}${id}`,
    f.date,
    where.window,
    where.place,
  ].filter(Boolean).join(", ");
};

// The history event for a move to another occurrence, or none.
const movedEvent = (order, next, now) => {
  const from = (orderOccurrence(terms, order.fulfilment) || {}).id
    || order.fulfilment.occurrence || null;
  const to = next.fulfilment.occurrence || null;

  return from !== to && to
    ? [{ at: now.toISOString(), event: "fulfilment.moved", from, to,
      by: "farm" }]
    : [];
};

// The Square order that carries an order's fulfilment.
const holderOf = (order) => order.square
  && (order.square.fulfilmentOrderId || order.square.squareOrderId);

const delivering = (order) => order.fulfilment.method === "delivery";

// The record as the change makes it, or the errors. Only the fields
// the farm gave change; a new method drops the old method's block.
const build = (order, body, { now, env }) => {
  const b = body && typeof body === "object" ? body : {};
  const given = b.fulfilment || {};
  const errors = {};
  const was = modelled(terms, order.fulfilment);
  const method = given.method || was.method;
  const same = method === was.method;
  const f = {
    ...was,
    method,
    date: given.date !== undefined ? given.date : was.date,
  };

  if (!METHODS.includes(method)) {
    errors["fulfilment.method"] = `Method is one of ${METHODS.join(", ")}.`;
  }
  if (f.date !== null && f.date !== undefined && !ISO.test(f.date)) {
    errors["fulfilment.date"] = "The date is YYYY-MM-DD.";
  }

  delete f.site;
  if (method === "scheduled") {
    f.occurrence = given.occurrence !== undefined ? given.occurrence
      : (same && was.occurrence);

    const found = f.occurrence ? occurrenceFor(terms, f.occurrence) : null;

    if (!found || (found.archived && f.occurrence !== was.occurrence)) {
      errors["fulfilment.occurrence"] = `No occurrence "${
        f.occurrence || ""}" to book. List them with bin/nff events.`;
    } else if (given.occurrence !== undefined && given.date === undefined) {
      f.date = found.date;
    } else if (given.date !== undefined && given.date !== found.date) {
      errors["fulfilment.date"] = `${found.id} is on ${found.date}, not ${
        given.date}.`;
    }
  } else {
    if (given.occurrence !== undefined) {
      errors["fulfilment.occurrence"] = "An occurrence goes with method " +
        "scheduled.";
    }
    delete f.occurrence;
  }

  if (method === "onfarm") {
    const window = (given.onfarm || {}).window;
    const old = same ? was.onfarm || {} : {};

    f.onfarm = window !== undefined ? { window } : old;

    if (window !== undefined) {
      const day = datesFor("onfarm", now, terms, pickupSchedule(env), true)
        .find((d) => d.date === f.date);
      const w = day && day.windows.find((x) => x.id === window);

      if (w) f.onfarm = { window: w.id, from: w.from, to: w.to };
    }
  } else {
    f.onfarm = null;
  }

  if (method === "delivery") {
    const d = {
      ...(same ? was.delivery || {} : {}), ...(given.delivery || {}),
    };

    for (const k of ["address1", "town", "zip", "cooler"]) {
      if (!String(d[k] || "").trim()) {
        errors[`delivery.${k}`] = `A delivery needs its ${k}.`;
      }
    }

    const { status, state } = zipInfo(d.zip, terms.area);

    f.delivery = { ...d, state: state ? state.code : d.state || null,
      zipStatus: status };
  } else {
    f.delivery = null;
  }

  if (METHODS.includes(method) && method !== "delivery" && !f.date) {
    errors["fulfilment.date"] = "This way of getting an order needs a date.";
  }

  const c = b.customer || {};
  const customer = { ...order.customer };

  if (c.phone !== undefined) {
    customer.phone = String(c.phone).trim();
    if (!phoneOk(customer.phone)) {
      errors["customer.phone"] = "That phone number doesn't look right.";
    }
  }
  if (c.contact !== undefined) {
    customer.contact = String(c.contact).trim();
    if (!CONTACT.includes(customer.contact)) {
      errors["customer.contact"] = "Text or call?";
    }
  }

  const notes = b.notes !== undefined ? String(b.notes) : order.notes;

  return { errors, fulfilment: f, customer, notes };
};

// The customer's rules this change overrides, in words.
const warningsFor = (order, next, { now, env }) => {
  const out = [];
  const f = next.fulfilment;
  const was = modelled(terms, order.fulfilment);

  if (order.status !== "paid") {
    out.push(`The order is ${order.status}, not paid.`);
  }
  if (order.cancelRequested) out.push("The customer has asked to cancel.");
  if (isScheduled(was) && !orderOccurrence(terms, was)) {
    out.push(`The order's pickup "${was.occurrence}" is gone from the ` +
      "data files. Restore it there, archived, so slips and emails can " +
      "name it. Until then Square keeps the order's pickup time.");
  }

  const moved = f.method !== was.method || f.date !== was.date
    || (f.occurrence || null) !== (was.occurrence || null);

  if (!moved || !f.date) return out;
  if (f.date < today(now, terms.timeZone)) {
    out.push(`${f.date} is in the past.`);
  }
  if (f.method === "scheduled") {
    const found = orderOccurrence(terms, f);

    if (found && found.archived) {
      out.push(`${found.name} is archived, so customers can't book it.`);
    }
  }
  if (f.method === "scheduled") {
    const open = datesFor("scheduled", now, terms, pickupSchedule(env));

    if (!open.some((d) => d.occurrence === f.occurrence)) {
      out.push(`${f.occurrence} is not a pickup customers could choose ` +
        "(it has no pickup line in the schedule, or its cutoff has " +
        "passed).");
    }
  } else if (f.method !== "delivery") {
    const open = datesFor(f.method, now, terms, pickupSchedule(env));

    if (!open.some((d) => d.date === f.date)) {
      out.push(`${f.date} is not a date customers could choose for ${
        methodName(f.method).toLowerCase()}.`);
    }
  } else {
    const open = datesFor("delivery", now, terms, null);

    if (!open.some((d) => d.date === f.date)) {
      out.push(`${f.date} is not an open delivery date.`);
    }
  }

  return out;
};

// What the change could do to the money, by pricing it as the order
// page would at the order's own prices (`hold`). Only a fee or a
// minimum can change, and only when the way or the ZIP does.
// -> { difference, unknown }
const priceChange = async (stores, order, next, { now, env }) => {
  const zip = (o) => (o.fulfilment.delivery || {}).zip || "";
  const mayMove = delivering(order) !== delivering(next)
    || (delivering(next) && zip(order) !== zip(next));

  if (!mayMove) return { difference: 0, unknown: null };

  const cust = await getCustomer(stores, order.customer.email);
  const body = {
    fulfilment: {
      method: next.fulfilment.method, date: next.fulfilment.date,
      occurrence: next.fulfilment.occurrence,
      onfarm: next.fulfilment.onfarm,
      delivery: next.fulfilment.delivery,
    },
  };
  const attempt = (claimedTotal) => planEdit(stores, order,
    { ...body, claimedTotal }, {
      now, index, terms, codes: discountCodes.codes, hold: true,
      group: (cust && cust.discountGroup) || null, validate: validateOrder,
      schedule: pickupSchedule(env), env, farm: true,
    });
  let planned = await attempt(undefined);

  if (!planned.ok && planned.errors.total && planned.totals) {
    planned = await attempt(planned.totals.total);
  }
  if (planned.ok) return { difference: planned.change.difference,
    unknown: null };

  // Dates and sites are the farm's to override; only a failure that is
  // about the money leaves it unpriced. A failed plan says nothing
  // about money, so it is reported as unpriced.
  return { difference: 0, unknown: Object.values(planned.errors).join(" ") };
};

// Every side effect of a change, before anything happens.
// -> { ok, plan } or { ok: false, errors }
export const planAmend = async (stores, id, body, {
  now = clock(), env = process.env, noSquare = false,
} = {}) => {
  const order = await getOrder(stores, id);

  if (!order) return fail({ order: `We can't find order ${id}.` });

  const built = build(order, body, { now, env });

  if (Object.keys(built.errors).length) return fail(built.errors);

  const next = {
    ...order,
    fulfilment: built.fulfilment,
    customer: built.customer,
    notes: built.notes,
  };

  const same = JSON.stringify([order.fulfilment, order.customer, order.notes])
    === JSON.stringify([next.fulfilment, next.customer, next.notes]);

  if (same) return fail({ order: "Nothing has changed." });

  const warnings = warningsFor(order, next, { now, env });
  const price = await priceChange(stores, order, next, { now, env });
  const holder = holderOf(order);
  const typeChanged = delivering(order) !== delivering(next);
  const fulfilmentMoved = JSON.stringify(order.fulfilment)
    !== JSON.stringify(next.fulfilment);
  const effects = {};

  effects.email = customerEmailWithheld()
    ? "none (--no-email)"
    : order.status === "cancelled"
      ? "none (the order is cancelled)"
      : `the customer (${order.customer.email}) gets the "order changed" ` +
        "email; the farm gets none";

  if (noSquare) {
    effects.square = "none (--no-square): Square keeps its old fulfilment";
  } else if (!holder) {
    effects.square = "none: the order has no Square order";
  } else if (!fulfilmentMoved) {
    effects.square = "none: Square holds nothing of the contact or notes";
  } else if (typeChanged) {
    effects.square = `a new $0 Square order carries the ${
      delivering(next) ? "delivery" : "pickup"} fulfilment (its type ` +
      `changes), paid at $0 and linked to ${holder}; the fulfilment on ` +
      `${holder} is cancelled`;
  } else {
    effects.square = `Square order ${holder}: the fulfilment's ${
      delivering(next) ? "delivery time and address" : "pickup time and note"
    } are updated`;
  }

  effects.stock = "none: the items don't change";
  effects.money = price.unknown
    ? `could not be priced (${price.unknown}), so it could move money`
    : price.difference
      ? `the change would ${price.difference > 0 ? "add" : "take off"} ${
        dollars(Math.abs(price.difference))}`
      : "none: nothing is charged or refunded";
  effects.history = ["farm.changed, with the before and after" +
    `${noSquare ? " and that Square was not changed" : ""}`];

  return {
    ok: true,
    plan: {
      order, next, warnings, price, effects, noSquare, typeChanged,
      holder, fulfilmentMoved,
      before: describe(order), after: describe(next),
    },
  };
};

const moneyRefusal = (price) => price.unknown
  ? `This change could move money, and it can't be priced (${price.unknown}).`
  : `This change would ${price.difference > 0 ? "add" : "take off"} ${
    dollars(Math.abs(price.difference))}, which would move money.`;

// Square's side of the change. Throws what Square refuses with.
const followInSquare = async (plan, { square, env, fetchImpl, k }) => {
  const { next, holder, typeChanged, order } = plan;

  if (!typeChanged) {
    await square.updateFulfilment(holder, next, { env, fetchImpl });

    return null;
  }

  const created = await square.createChangeOrder(next, {
    carries: true, difference: 0, delta: [], added: [], removed: [],
    switched: true,
  }, k, { env, fetchImpl });

  try {
    await square.payZeroOrder(created.squareOrderId, k, { env, fetchImpl });
    await square.cancelFulfilment(holder, { env, fetchImpl });
  } catch (error) {
    // The new order exists: take it back if Square lets us, and say
    // which one is left if it does not.
    const id = created.squareOrderId;
    const gone = await square.cancelOrder(id, { env, fetchImpl })
      .then((r) => !!(r && r.cancelled), () => false);

    throw Object.assign(new Error(error && error.message), {
      created: id, cancelled: gone,
    });
  }

  return { ...order.square, fulfilmentOrderId: created.squareOrderId };
};

// Makes the change planned. -> { ok, order, report: { square, email } }
// or a refusal { ok: false, refused: "money" | "square", message }.
export const applyAmend = async (stores, plan, {
  now = clock(), env = process.env, mail = sendMail, square = squareApi,
  fetchImpl, force = false,
} = {}) => {
  const { order, next, price, noSquare } = plan;
  const id = order.id;

  if ((price.unknown || price.difference) && !force) {
    return { ok: false, refused: "money", message: moneyRefusal(price) };
  }

  const k = `farm-${id}-${now.getTime()}`;
  // Square's key names the target, not the moment, so a retry after a
  // partial failure finds the $0 order it already made.
  const squareKey = `farm-${id}-${next.fulfilment.method}-${
    next.fulfilment.occurrence || next.fulfilment.date}`;
  const report = { square: plan.effects.square, email: plan.effects.email };
  let squareNow = order.square;
  let kept = null;

  if (!noSquare && plan.holder && plan.fulfilmentMoved) {
    try {
      squareNow = (await followInSquare(plan, {
        square, env, fetchImpl, k: squareKey,
      })) || order.square;
      report.square = "Square was updated.";
    } catch (error) {
      const why = String(error && error.message);
      const left = error && error.created && !error.cancelled
        ? error.created : null;
      const note = !error || !error.created ? ""
        : left
          ? ` A $0 Square order (${left}) was created and could not be ` +
            "cancelled; cancel it in Square."
          : ` The $0 Square order it created (${error.created}) was ` +
            "cancelled.";

      if (!force) {
        return { ok: false, refused: "square", message: `Square would not ` +
          `take the change (${why}).${note} The record was not changed. ` +
          "Use --force to apply the record anyway, or --no-square to " +
          "leave Square alone." };
      }
      kept = why;
      if (left) squareNow = { ...order.square, fulfilmentOrderId: left };
      report.square = `Square refused (${why}) and kept the old ` +
        `fulfilment: ${describe(order)}.${note} The record was changed ` +
        "anyway (--force).";
    }
  } else if (noSquare) {
    report.square = "Square was not changed (--no-square).";
  }

  const squareState = noSquare ? "skipped (--no-square)"
    : kept ? `kept the old fulfilment (--force): ${kept}`
      : plan.holder && plan.fulfilmentMoved ? "updated" : "none";
  const saved = await saveOrder(stores, {
    ...order,
    fulfilment: next.fulfilment,
    customer: next.customer,
    notes: next.notes,
    square: squareNow,
    ...kept && { flags: { ...(order.flags || {}), squareOutOfSync: true } },
    history: [...(order.history || []), ...movedEvent(order, next, now), {
      at: now.toISOString(),
      event: "farm.changed",
      before: plan.before,
      after: plan.after,
      square: squareState,
      flags: {
        noSquare: !!noSquare, force: !!force,
        noEmail: customerEmailWithheld(),
      },
      ...plan.warnings.length && { overrode: plan.warnings },
      ...(price.unknown || price.difference) && { forced: true },
    }],
  }, now);

  const links = mailLinks(env);
  const sent = order.status === "cancelled" ? saved
    : await sendForOrder(stores, saved, `orderChanged-${k}`,
      orderChanged(saved, {
        orderUrl: orderUrlFor(env, id), links, difference: 0,
        before: {
          lines: order.lines, totals: order.totals,
          method: order.fulfilment.method, site: order.fulfilment.site,
          occurrence: order.fulfilment.occurrence,
          date: order.fulfilment.date,
        },
      }), { mail, env, now });

  if (!customerEmailWithheld() && order.status !== "cancelled") {
    report.email = `The customer (${order.customer.email}) was emailed.`;
  }

  return { ok: true, order: sent, report };
};
