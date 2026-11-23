// Square's shapes: the error the seam throws, the orders and records
// it builds and reads, and the constants they take, with no call in
// them (#925 phase 1, #964). square.mjs, the seam, re-exports each
// name it exported before, and fake-square.mjs takes them from here,
// so the fake no longer imports the driver that hands it each call.

import terms from "./terms.mjs";
import { company } from "./company.mjs";
import pkg from "../../../package.json" with { type: "json" };
import { placeOf } from "./describe.mjs";
import { ID_TAIL } from "./order-id.mjs";
import {
  pickupTimes, windowLabel,
} from "../../../assets/scripts/order/lib/schedule.mjs";
import {
  isScheduled, orderOccurrence,
} from "../../../assets/scripts/order/lib/dates.mjs";
import { instant } from "../../../assets/scripts/order/lib/zoned.mjs";
import {
  validField,
} from "../../../assets/scripts/utils/field-errors.mjs";

// A payment that Square would not take: the customer can try another
// card. `code` is Square's; `message` is for the customer.
export class SquareError extends Error {
  constructor(message, {
    retryable = false, status = 0, detail = null, declined = false,
    code = null,
  } = {}) {
    super(message);
    this.name = "SquareError";
    this.retryable = retryable;
    this.status = status;
    this.detail = detail;
    this.declined = declined;
    this.code = code;
  }
}

// Square's reasons a card payment fails, and what the customer reads.
// Anything else from CreatePayment is our problem, not theirs.
export const DECLINE_MESSAGES = {
  CARD_DECLINED: "Your card was declined. Try another card.",
  GENERIC_DECLINE: "Your card was declined. Try another card.",
  INSUFFICIENT_FUNDS: "Your card was declined for insufficient funds.",
  CVV_FAILURE: "The security code doesn't match the card.",
  VERIFY_CVV_FAILURE: "The security code doesn't match the card.",
  ADDRESS_VERIFICATION_FAILURE: "The ZIP code doesn't match the card.",
  VERIFY_AVS_FAILURE: "The ZIP code doesn't match the card.",
  INVALID_POSTAL_CODE: "The ZIP code doesn't match the card.",
  INVALID_CARD: validField("card"),
  INVALID_CARD_DATA: validField("card"),
  PAN_FAILURE: validField("card"),
  CARD_EXPIRED: "That card has expired.",
  INVALID_EXPIRATION: validField("expiration"),
  EXPIRATION_FAILURE: validField("expiration"),
  UNSUPPORTED_CARD_BRAND: "We can't take that kind of card.",
  CARD_NOT_SUPPORTED: "We can't take that kind of card.",
  TRANSACTION_LIMIT: "That's over your card's limit for one payment.",
  PAYMENT_LIMIT_EXCEEDED: "That's over the limit for one payment.",
  CARD_TOKEN_EXPIRED: "That card entry timed out. Enter it again.",
  CARD_TOKEN_USED: "That card entry was already used. Enter it again.",
  CARD_PROCESSING_NOT_ENABLED: "Card payments are switched off right now.",
  VOICE_FAILURE: "Your bank declined the payment.",
  CHIP_INSERTION_REQUIRED: "Your bank declined the payment.",
  ALLOWABLE_PIN_TRIES_EXCEEDED: "Your bank declined the payment.",
  RESERVATION_DECLINED: "Your bank declined the payment.",
  CUSTOMER_CANCELED: "The payment was canceled before it completed.",
  BAD_EXPIRATION: validField("expiration"),
  INVALID_ACCOUNT: "Your bank declined the payment.",
  GIFT_CARD_AVAILABLE_AMOUNT: "That card doesn't have enough on it.",
  AMOUNT_TOO_HIGH: "That's over the limit for one payment.",
};

// What Square's refusal is to the rest of the code: the status, and the
// first of its errors for the code. The fake throws the same from a
// recorded body (lib/fake-square.mjs).
export const failure = (status, data, path) => {
  const errors = data && Array.isArray(data.errors) ? data.errors : [];
  const first = errors[0] || {};
  const code = first.code || null;
  const declined = !!(code && DECLINE_MESSAGES[code]);

  return new SquareError(`Square ${status} on ${path}`, {
    retryable: status === 429 || status >= 500
      || code === "TEMPORARY_ERROR",
    status,
    detail: errors.length ? errors : data,
    declined,
    code,
  });
};

// Exported for square.mjs alone, whose calls send money too; square.mjs
// does not re-export it.
export const money = (amount) => ({ amount, currency: "USD" });

// Every order the site makes, and every change order, says which
// release made it (#331). The version is package.json's, the one place
// it is spelled: metadata carries it whole and the Source column its
// major.minor. The order id stays the reference, unprefixed. Nothing
// reads the Source column back: the metadata is what a sweep trusts.
export const SITE_VERSION = pkg.version;
export const SOURCE_NAME = `${company.email.split("@")[1]} v${
  SITE_VERSION.split(".").slice(0, 2).join(".")}`;
// The name of Square's own Friends and Fam discounts (#514), which the
// site's line-item discounts carry.
export const FRIENDS_SQUARE_NAME = (terms.money.friendsAndFam
  && terms.money.friendsAndFam.squareName) || "Friends and Fam";
export const ORDER_METADATA = Object.freeze({
  site_version: SITE_VERSION,
  order_flow: "order-page",
});

export const e164 = (phone) => {
  const d = String(phone || "").replace(/\D/g, "");

  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith("1")) return `+${d}`;

  return undefined;
};

const stateFor = (zip) => {
  for (const state of terms.area.states) {
    if (state.towns.some((t) => t.zips.includes(zip))) return state.code;
  }

  return zip.startsWith("0") ? "RI" : undefined;
};

const staffNote = (order) => {
  const bits = [];
  const f = order.fulfilment;

  if (order.customer.contact) bits.push(`prefers ${order.customer.contact}`);
  // The farm sees why an order came in under the minimum or with no
  // fee (QA, #182); the customer's receipt says nothing of it. Ahead
  // of the notes, which can run the note past its 500 characters.
  if (order.pass) {
    bits.push(`code ${order.pass}${order.passWaivesFee
      ? ", fee waived" : ", under the minimum"}`);
  }
  if (f.method === "onfarm") {
    const times = pickupTimes(f.onfarm);

    bits.push(`pickup ${times ? windowLabel(times) : f.onfarm.window}`);
  }
  if (f.method === "delivery") {
    bits.push(`cooler: ${f.delivery.cooler}`);
    if (f.delivery.gate) bits.push(`gate: ${f.delivery.gate}`);
    if (f.delivery.notes) bits.push(f.delivery.notes);
    if (order.flags.zipUnlisted) bits.push("ZIP not on the approved list");
  }
  // A changed order's items are spread over several Square orders, so
  // the fulfillment the farm packs from lists them whole.
  if ((order.edits || []).length) {
    bits.unshift(`changed; pack ${order.lines
      .map((l) => `${l.qty} × ${l.label || l.name}`).join(", ")}`);
  }
  if (order.notes) bits.push(`notes: ${order.notes}`);
  if (order.source) bits.push(`heard via ${order.source}`);
  // A buying group's order (#471) says so first, with its round, so
  // the farm packs the round as one.
  if (order.group && order.group.key) {
    bits.unshift(`group ${order.group.key}${order.group.round
      ? `, round ${order.group.round}` : ""}`);
  }

  return bits.join(" · ").slice(0, 500);
};

// Exported for square.mjs alone, whose updateFulfillment sends it;
// square.mjs does not re-export it.
export const fulfillment = (order) => {
  const f = order.fulfilment;
  const { name, email, phone } = order.customer;
  const note = staffNote(order);
  const tz = terms.timeZone;

  if (f.method === "delivery") {
    const d = f.delivery;

    return {
      type: "DELIVERY",
      state: "PROPOSED",
      delivery_details: {
        recipient: {
          display_name: name,
          email_address: email,
          phone_number: e164(phone),
          address: {
            address_line_1: d.address1,
            address_line_2: d.address2 || undefined,
            locality: d.town,
            administrative_district_level_1: d.state || stateFor(d.zip),
            postal_code: d.zip,
            country: "US",
          },
        },
        schedule_type: "SCHEDULED",
        deliver_at: instant(f.date, 10, 0, tz).toISOString(),
        note,
      },
    };
  }

  // A pickup's time is its window's start, with minutes (W11d-D). A
  // scheduled pickup's is its occurrence's. An occurrence gone from
  // the data is not the farm, and has no hour: say which it was, and
  // the update keeps the time Square already holds.
  const here = placeOf(order);
  const site = orderOccurrence(terms, f);
  const gone = isScheduled(f) && !site;
  const start = f.method === "onfarm"
    && (pickupTimes(f.onfarm) || { from: "09:00" }).from;
  const [hour, minute] = start
    ? start.split(":").map(Number)
    : [site ? site.opensHour : 9, site ? site.opensMinute || 0 : 0];
  const where = gone ? here.address || f.occurrence || f.site
    : isScheduled(f) ? `Pickup at ${here.name}, ${here.address}`
      : "On-farm pickup";

  return {
    type: "PICKUP",
    state: "PROPOSED",
    pickup_details: {
      recipient: {
        display_name: name,
        email_address: email,
        phone_number: e164(phone),
      },
      schedule_type: "SCHEDULED",
      pickup_at: gone ? undefined
        : instant(f.date, hour, minute, tz).toISOString(),
      note: `${where} · ${note}`.slice(0, 500),
    },
  };
};

// The release's metadata, and, on a buying group's order (#471), its
// group and round, so a Square report can add a round up; on a perk's
// discount, which perk.
export const orderMetadata = (order) => ({
  ...ORDER_METADATA,
  ...(order.group && order.group.key ? {
    group: order.group.key,
    ...(order.group.round ? { round: order.group.round } : {}),
  } : {}),
  // The perk whose discount the order took (#514): friends or family.
  ...(order.totals && order.totals.discountPerk
    ? { perk: order.totals.discountPerk } : {}),
});

export const buildOrder = (order, customerId, cfg) => {
  const t = order.totals;
  const out = {
    location_id: cfg.locationId,
    reference_id: order.id,
    source: { name: SOURCE_NAME },
    metadata: orderMetadata(order),
    customer_id: customerId,
    line_items: order.lines.map((line) => (
      cfg.catalog && line.squareVariationId
        ? {
          catalog_object_id: line.squareVariationId,
          quantity: String(line.qty),
        }
        : {
          name: line.name,
          quantity: String(line.qty),
          base_price_money: money(line.unitPrice * 100),
        })),
    fulfillments: [fulfillment(order)],
  };

  // A buying group's member price (#471) is per item, whole dollars, so
  // the receipt shows each item at retail with its own discount, as
  // #132 wants member pricing recorded. So is Friends and Fam (#514),
  // under the name of Square's own discount, so the register's and
  // the site's read alike in Square's reports. Every other discount is
  // one order-scope amount: a family order's (#514) is the whole of
  // its items, a real discount, so nothing is charged.
  const perItem = t.discountLock && (t.lockLines || []).length
    ? { prefix: "lock", lines: t.lockLines,
      name: t.discountLabel || "Member price" }
    : t.discountPerk === "friends" && (t.perkLines || []).length
      ? { prefix: "friends", lines: t.perkLines,
        name: FRIENDS_SQUARE_NAME }
      : null;

  if (perItem) {
    const uid = (sku) => `${perItem.prefix}-${sku}`;

    out.discounts = perItem.lines.map((l) => ({
      uid: uid(l.sku),
      name: perItem.name,
      amount_money: money(l.amount),
      scope: "LINE_ITEM",
    }));
    out.line_items = out.line_items.map((item, i) => {
      const held = perItem.lines.find((l) => l.sku === order.lines[i].sku);

      return held
        ? { ...item, applied_discounts: [{ discount_uid: uid(held.sku) }] }
        : item;
    });
  } else if (t.discountAmount > 0) {
    out.discounts = [{
      name: t.discountLabel || "Discount",
      amount_money: money(t.discountAmount),
      scope: "ORDER",
    }];
  }
  // A member's credit (#471) is stored value the farm granted, not
  // money received, so Square's books carry it as a discount of its
  // own, named, beside any other: the order's total in Square is then
  // the money charged. Draft name.
  if (t.credit > 0) {
    out.discounts = [...(out.discounts || []), {
      name: "Group credit",
      amount_money: money(t.credit),
      scope: "ORDER",
    }];
  }
  // Two lines when the address is outside the published towns, so
  // the receipt explains the extra $3 on its own. A fee a pass waived
  // (#182) still goes as the delivery, at $0, with no discount line.
  const charges = [
    ["Delivery fee", t.deliveryFee - (t.areaFee || 0)],
    ["Outside-area fee", t.areaFee || 0],
  ].filter(([name, cents]) => cents > 0
    || (t.feeWaived && name === "Delivery fee"));

  if (charges.length) {
    out.service_charges = charges.map(([name, cents]) => ({
      name,
      amount_money: money(cents),
      calculation_phase: "SUBTOTAL_PHASE",
      taxable: false,
    }));
  }

  return out;
};

// A reference already there is replaced only when the site wrote it:
// the order id a checkout marks the profile it made with (#236; the
// mark only matters during that checkout's own retries), or an older
// member ID. Anything else someone typed in the Square Dashboard, so it
// is reported as a conflict and left alone. The last part takes either
// order id length (lib/order-id.mjs, #937).
const SITE_REFERENCE = new RegExp(`^NF[FM]-[A-Z0-9]{4}-${ID_TAIL}$`);

export const replaceableReference = (value) =>
  !value || SITE_REFERENCE.test(String(value));

// What the code reads of a profile Square answers with.
export const customerView = (c) => ({
  customerId: c.id, referenceId: c.reference_id || null,
});

// A change to a paid order (lib/edit.mjs) as a Square order of its
// own, under the same reference_id: what was added, at today's price,
// and one discount for whatever the change took off, so its total is
// the difference to pay (never below zero). A charge the added items
// do not cover (a discount lost) is a line of its own. With `carries`
// it takes the order's fulfillment too, for a switch between delivery
// and pickup, which Square cannot make on the first order's.
export const buildChangeOrder = (order, change, customerId, cfg) => {
  const lines = change.added.map((line) => (
    cfg.catalog && line.squareVariationId
      ? {
        catalog_object_id: line.squareVariationId,
        quantity: String(line.qty),
      }
      : {
        name: line.name,
        quantity: String(line.qty),
        base_price_money: money(line.unitPrice * 100),
      }));
  const added = change.added
    .reduce((s, line) => s + line.unitPrice * 100 * line.qty, 0);
  const charge = Math.max(0, change.difference) - added;

  if (charge > 0 || !lines.length) {
    lines.push({
      name: `Changes to order ${order.id}`,
      quantity: "1",
      base_price_money: money(Math.max(0, charge)),
    });
  }

  const out = {
    location_id: cfg.locationId,
    reference_id: order.id,
    source: { name: SOURCE_NAME },
    metadata: orderMetadata(order),
    customer_id: customerId,
    line_items: lines,
  };
  const off = added + Math.max(0, charge) - Math.max(0, change.difference);

  if (off > 0) {
    out.discounts = [{
      name: `Taken off order ${order.id}`,
      amount_money: money(off),
      scope: "ORDER",
    }];
  }
  if (change.carries) out.fulfillments = [fulfillment(order)];

  return out;
};

// The receipt link a page may show, or null. The sandbox gives each
// payment a squareupsandbox.com receipt that opens Page not found
// (#441), so staging shows none; production's squareup.com one passes.
export const receiptLink = (url) => {
  if (!url) return null;

  try {
    const { hostname } = new URL(url);

    return hostname === "squareupsandbox.com"
      || hostname.endsWith(".squareupsandbox.com") ? null : url;
  } catch {
    return null;
  }
};

// What the record keeps of a Square payment.
export const paymentRecord = (payment) => {
  const card = payment.card_details && payment.card_details.card;
  const wallet = payment.wallet_details || null;

  return {
    squarePaymentId: payment.id,
    status: payment.status,
    receiptUrl: payment.receipt_url || null,
    brand: card ? card.card_brand || null : null,
    last4: card ? card.last_4 || null : null,
    wallet: wallet ? wallet.brand || null : null,
  };
};

// What the code keeps of a Square refund. `amount` is what to say when
// the answer names none.
export const refundRecord = (refund, amount) => ({
  squareRefundId: refund.id,
  status: refund.status,
  amount: refund.amount_money ? refund.amount_money.amount : amount,
});

// A payment as the record keeps it, with what has been refunded of it
// so far (cents).
export const paymentView = (payment) => ({
  ...paymentRecord(payment),
  refunded: payment.refunded_money ? payment.refunded_money.amount : 0,
});
