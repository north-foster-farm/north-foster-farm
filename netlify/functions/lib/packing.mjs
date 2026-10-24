// The daily packing slips (#292): one email to the farm at 6:00 AM
// ET with one PDF holding every sheet to print that morning.
//
//   Sunday       a clean slip for every order fulfilled Sunday to
//                Saturday, plus the daily set for later weeks
//   other days   a slip for each order not printed yet, a revision
//                sheet and a fresh slip for each one changed since it
//                was printed, a CANCELLED sheet for each printed one
//                since cancelled
//   quiet day    the email still goes, saying there is nothing to print
//
// What was printed is kept per order in the jobs store,
// `packing/printed/<id>`: a snapshot of what its slip showed. A
// reprint comes from comparing the order with that snapshot, never
// from timestamps, so a change by any path is caught. Contact
// details, the address and the customer's notes are kept only as a
// hash: the snapshot says that they changed, the fresh slip says what
// they are now. `packing/sent/<day>` marks the day's packet as sent.
//
// After the packet, an order due that day that changes anyway (the
// farm's CLI, a refund from Square or PayPal) is mailed at once as
// "Changed after printing", from the next 15-minute run.
//
// Each run that sends pings HEALTHCHECKS_PACKING_URL (production
// only), or its /fail when the packet could not be built or sent.

import { createHash } from "node:crypto";

import catalog from "../../../data/catalog.json" with { type: "json" };
import terms from "../../../data/delivery.json" with { type: "json" };
import signatures from "../../../data/signatures.json" with { type: "json" };
import skuAliases from "../../../data/skuAliases.json" with { type: "json" };
import {
  current, indexCatalog,
} from "../../../assets/scripts/order/lib/catalog.mjs";
import { pickupTimes } from "../../../assets/scripts/order/lib/schedule.mjs";
import { dollars } from "../../../assets/scripts/order/lib/totals.mjs";
import {
  addDays, label, parts, today, weekday,
} from "../../../assets/scripts/order/lib/zoned.mjs";
import { METHODS } from "./checkout.mjs";
import { company } from "./company.mjs";
import { methodName, packetCounts, placeOf } from "./describe.mjs";
import { isScheduled } from "../../../assets/scripts/order/lib/dates.mjs";
import { ping } from "./health.mjs";
import { now as clock } from "./clock.mjs";
import { log, scrub } from "./log.mjs";
import { MailError, farmEmails, sendMail } from "./mail.mjs";
import {
  configured as paypalConfigured, venmoHidden,
} from "./paypal.mjs";
import { pdf, wrap } from "./pdf.mjs";
import {
  allOrders, getOrder, paidTotal, paymentsOf, settledRefunds,
} from "./records.mjs";
import { resendAllowed } from "./resend-guard.mjs";
import { mailLinks } from "./site.mjs";
import { mark, wordmark } from "./slip-assets.mjs";
import { farmChangedAfterPrint, farmPackingSlips } from "./templates.mjs";

const tz = terms.timeZone;

export const PACKING_HOUR = 6;
// A day's packet starts no later than this hour, so a release or an
// outage late in the day waits for the next morning. Once started,
// it is retried until it goes.
export const PACKING_LAST_HOUR = 10;
export const KEEP_DAYS = 30;
export const PRINTED = "packing/printed/";
export const SENT = "packing/sent/";
export const CHANGED = "packing/changed/";
export const PENDING = "packing/pending/";

const printedKey = (id) => `${PRINTED}${id}`;

// The order the slips stack in, within a day.
const METHOD_ORDER = ["delivery", "scheduled", "scituate", "market",
  "onfarm"];

const hash = (...values) => createHash("sha256")
  .update(JSON.stringify(values)).digest("hex").slice(0, 16);

// --- Money ------------------------------------------------------------

// PAID when the payments cover the total, from the money on the
// record rather than its status: an order from before checkout moved
// onto the page may still be `submitted`, unpaid. A refund never makes
// an order owe: the total is what was ordered, and what went back is
// its own line.
//
// That line counts only refunds off the total as it stands: the farm's
// (`orders refund`) or one noted from Square or PayPal. A customer's
// change that took items out lowered the total already and refunded
// the difference (its refund carries `edit`), so counting it again
// would read as money kept back.
export const paymentState = (order) => {
  const due = order.status === "submitted"
    ? order.totals.total
    : Math.max(0, order.totals.total - paidTotal(order));
  const refunded = settledRefunds(order).filter((r) => !r.edit)
    .reduce((s, r) => s + (r.amount || 0), 0);

  return { paid: due === 0, due, refunded };
};

const paidWord = (state) => (state.paid ? "PAID" : "UNPAID");

// --- Snapshots ----------------------------------------------------------

const instructions = (order) => {
  const d = order.fulfilment.delivery || {};

  return [d.cooler, d.gate, d.notes, order.notes].map((s) => s || "");
};

// What a slip shows, in a form that compares. -> the snapshot.
export const snapshotOf = (order) => {
  const where = placeOf(order);
  const state = paymentState(order);

  return {
    status: order.status,
    lines: order.lines.map((l) => ({
      sku: l.sku, label: l.label, qty: l.qty,
    })),
    method: where.method,
    // Which occurrence, and the farm's name for it, so a move between
    // two shows by name and a cancelled sheet can name it.
    ...where.occurrence && { occurrence: where.occurrence, name: where.name },
    date: order.fulfilment.date,
    window: where.window,
    place: hash(where.place),
    notes: hash(instructions(order)),
    contact: hash(order.customer.name, order.customer.phone,
      order.customer.email),
    total: order.totals.total,
    discount: order.totals.discountAmount || 0,
    paid: state.paid,
    due: state.due,
    refunded: state.refunded,
  };
};

// The kind of pickup a snapshot shows: a Stage 1 `scituate` or `market`
// and a `scheduled` one are the same kind.
const kindOf = (snap) => (isScheduled(snap) ? "scheduled" : snap.method);

// A snapshot printed before it carried the occurrence has no such key;
// that alone is not a change. Nor is the farm's name for the place (a
// series renamed), or the old and new spelling of a scheduled method.
const same = (a, b) => {
  const strip = (s, drop) => ({
    ...s, method: kindOf(s), name: undefined,
    ...drop && { occurrence: undefined },
  });

  return JSON.stringify(strip(a, a.occurrence === undefined))
    === JSON.stringify(strip(b, a.occurrence === undefined));
};

const linesOf = (snap) => new Map(snap.lines.map((l) => [l.sku, l]));

// Each difference between what was printed and the order now, as a
// line for the revision sheet.
export const changesBetween = (before, after) => {
  const out = [];
  const was = linesOf(before);
  const now = linesOf(after);

  for (const [sku, l] of now) {
    const old = was.get(sku);

    if (!old) out.push(`Added: ${l.qty} × ${l.label}`);
    else if (old.qty !== l.qty) {
      out.push(`${l.label}: was ${old.qty}, now ${l.qty}`);
    }
  }
  for (const [sku, l] of was) {
    if (!now.has(sku)) out.push(`Removed: ${l.qty} × ${l.label}`);
  }
  const kind = (snap) => (isScheduled(snap) ? "scheduled" : snap.method);
  const named = (snap) => snap.name || methodName(kind(snap));

  if (kind(before) !== kind(after)) {
    out.push(`Type: was ${named(before)}, now ${named(after)}`);
  } else if (before.occurrence && after.occurrence
    && before.occurrence !== after.occurrence) {
    out.push(`Pickup: was ${named(before)}, now ${named(after)}`);
  }
  if (before.date !== after.date) {
    out.push(`Date: was ${label(before.date)}, now ${label(after.date)}`);
  }
  if (before.window !== after.window) {
    out.push(`Window: was ${before.window || "none"}, now ${
      after.window || "none"}`);
  }
  if (before.place !== after.place && kind(before) === kind(after)
    && before.occurrence === after.occurrence) {
    out.push("Place or address changed: see the new slip");
  }
  if (before.notes !== after.notes) {
    out.push("Notes or delivery instructions changed: see the new slip");
  }
  if (before.contact !== after.contact) {
    out.push("Contact details changed: see the new slip");
  }
  if (before.discount !== after.discount) {
    out.push(`Discount: was ${dollars(before.discount)}, now ${
      dollars(after.discount)}`);
  }
  if (before.total !== after.total) {
    out.push(`Total: was ${dollars(before.total)}, now ${
      dollars(after.total)}`);
  }
  if (before.paid !== after.paid || before.due !== after.due) {
    const word = (s) => (s.paid ? "PAID" : `UNPAID (${dollars(s.due)} due)`);

    out.push(`Payment: was ${word(before)}, now ${word(after)}`);
  }
  if ((before.refunded || 0) !== (after.refunded || 0)) {
    out.push(`Refunded: was ${dollars(before.refunded || 0)}, now ${
      dollars(after.refunded || 0)}`);
  }

  return out;
};

export const readPrinted = async (stores) => {
  const keys = await stores.jobs.list(PRINTED);
  const records = await Promise.all(
    keys.map(({ key }) => stores.jobs.get(key))
  );

  return new Map(records.filter(Boolean).map((r) => [r.id, r]));
};

// --- Choosing the sheets -----------------------------------------------
//
// An entry is { order, kind, changes }: kind "new" (a slip), "changed"
// (a revision sheet, then a slip), "weekly" (a slip on Sunday for an
// order already printed and unchanged) or "cancelled" (a sheet, no
// slip). `order` for a cancelled entry is the record as it stands, or
// the snapshot when the record is gone.

export const isSunday = (day) => weekday(day) === 0;

export const choose = ({ open, printed, gone, day }) => {
  const sunday = isSunday(day);
  const weekEnd = addDays(day, 6);
  const entries = [];

  for (const order of open) {
    const date = order.fulfilment.date;

    if (date < day) continue;

    const was = printed.get(order.id);
    const now = snapshotOf(order);

    if (!was) {
      entries.push({ order, kind: "new", changes: [] });
    } else if (!same(was.snapshot, now)) {
      entries.push({
        order, kind: "changed", changes: changesBetween(was.snapshot, now),
      });
    } else if (sunday && date <= weekEnd) {
      entries.push({ order, kind: "weekly", changes: [] });
    }
  }
  for (const { record, order } of gone) {
    entries.push({ order: order || record, kind: "cancelled", changes: [] });
  }

  return entries.sort(byFulfillment);
};

const startOf = (order) => {
  const times = order.fulfilment && order.fulfilment.method === "onfarm"
    ? pickupTimes(order.fulfilment.onfarm) : null;

  return times ? times.from : "";
};

// A scheduled pickup's occurrence, so each one's orders sit together.
const occurrenceOf = (order) => placeOf(order).occurrence || "";

const rank = (method) => {
  const i = METHOD_ORDER.indexOf(method);

  return i < 0 ? METHOD_ORDER.length : i;
};

// By fulfillment date, then type, then pickup time, then order number.
export const byFulfillment = (a, b) => {
  const fa = a.order.fulfilment;
  const fb = b.order.fulfilment;

  return fa.date.localeCompare(fb.date)
    || rank(fa.method) - rank(fb.method)
    || occurrenceOf(a.order).localeCompare(occurrenceOf(b.order))
    || startOf(a.order).localeCompare(startOf(b.order))
    || a.order.id.localeCompare(b.order.id);
};

// -> { slips, revised, cancelled } for a packet's counts.
export const countsOf = (entries) => ({
  slips: entries.filter((e) => e.kind !== "cancelled").length,
  revised: entries.filter((e) => e.kind === "changed").length,
  cancelled: entries.filter((e) => e.kind === "cancelled").length,
});

export const slipsOf = (entries) =>
  entries.filter((e) => e.kind !== "cancelled");

// Every product and tier across the slips with its total quantity,
// by name. -> [{ label, qty }].
export const pickList = (entries) => {
  const totals = new Map();

  for (const { order } of slipsOf(entries)) {
    for (const l of order.lines) {
      const key = l.sku || l.label;
      const seen = totals.get(key) || { label: l.label, qty: 0 };

      totals.set(key, { label: seen.label, qty: seen.qty + l.qty });
    }
  }

  return [...totals.values()].sort((a, b) => a.label.localeCompare(b.label));
};

// --- The PDF ------------------------------------------------------------
//
// Two kinds of page (James, #292). The customer's slip goes in the bag
// with the order, so it carries the brand: the site's hen and wordmark,
// Aller, the brand green, and words a customer would use. Every other
// sheet is the farm's alone: plain Helvetica in black and white, under
// a black FARM COPY band, so none can go in a bag by mistake.

const M = 54;
const RIGHT = 612 - M;
const CENTER = 306;
const BOTTOM = 792 - 54;
const LINE = 15;
// The most lines one field or item name takes; past that it ends
// in an ellipsis, so a long note can't run on for pages.
export const FIELD_ROWS = 12;
const LABEL_ROWS = 4;

export const FARM_COPY = "FARM COPY · DON'T PACK";

// The slip's colours: the site's $primary, which the logo, the emails
// and the gate use; its body text; $gray-600; the green, faint, for
// rules. The green prints as a dark gray in black and white.
const GREEN = "#186243";
const INK = "#212529";
const MUTED = "#5e5e5f";
const RULE = "#c5d6cc";
const ALLER = { font: "aller" };

// The slip's body ends here; its footer sits below, clear of the half
// inch a printer may crop.
const SLIP_BOTTOM = 664;
// The Price column's right edge; Amount ends at the table's.
const PRICE_X = RIGHT - 90;

const stamp = (now) => new Intl.DateTimeFormat("en-US", {
  timeZone: tz, weekday: "short", month: "short", day: "numeric",
  hour: "numeric", minute: "2-digit",
}).format(now);

// A sheet's place on its pages: `y` moves down, and `room(h)` starts a
// new page, through `start`, when `h` more points would not fit.
const flow = (start, bottom) => {
  let y = start();

  return {
    get y() {
      return y;
    },
    set y(v) {
      y = v;
    },
    room(h) {
      if (y + h > bottom) y = start();
    },
  };
};

// One page or more for one of the farm's sheets, each under the band
// and with the band's words again at the foot.
const sheet = (doc, { title, id, now }) => {
  let n = 0;

  return flow(() => {
    doc.page();
    n += 1;
    doc.rect(M, 40, RIGHT - M, 28, { fill: 0, stroke: 0 });
    doc.text(FARM_COPY, CENTER, 59, {
      size: 14, bold: true, color: 1, align: "center",
    });
    doc.text(company.name, M, 88, { size: 9, shade: 0.35 });
    doc.text(`${title}${n > 1 ? " (continued)" : ""}`, M, 110, {
      size: 18, bold: true,
    });
    if (id) doc.text(id, RIGHT, 110, { size: 18, bold: true, align: "right" });
    doc.text(`Printed ${stamp(now)}`, M, BOTTOM + 24, { size: 8, shade: 0.4 });
    doc.text(FARM_COPY, RIGHT, BOTTOM + 24, {
      size: 8, bold: true, align: "right",
    });

    return 138;
  }, BOTTOM);
};

const field = (doc, at, name, value, { width = RIGHT - M - 90 } = {}) => {
  const rows = wrap(value || "", width, { size: 11, rows: FIELD_ROWS });

  at.room(rows.length * LINE);
  doc.text(name, M, at.y, { size: 9, shade: 0.4 });
  rows.forEach((row, i) => doc.text(row, M + 90, at.y + i * LINE, {
    size: 11,
  }));
  at.y += rows.length * LINE + 3;
};

const banner = (doc, at, word, { x = RIGHT - 170, w = 170 } = {}) => {
  doc.rect(x, at.y - 2, w, 40, { fill: 0.88, stroke: 2 });
  doc.text(word, x + w / 2, at.y + 27, { size: 24, bold: true,
    align: "center" });
};

// --- The customer's slip ------------------------------------------------

const catalogIndex = indexCatalog(catalog);
const byLineName = new Map([...catalogIndex.values()]
  .map((item) => [item.lineName, item]));

// A line as the slip names it: an item graded in the catalog shows its
// grade, "Eggs, Grade A · Large", as Rhode Island wants on the invoice
// (250-RICR-40-20-7). Found by SKU, or for an older record by the
// name it was sold under (with or without its grade); anything else
// keeps its own name.
export const slipLabel = (line) => {
  const item = catalogIndex.get(current(line.sku, skuAliases))
    || byLineName.get(line.label.replace(/ · Grade .*$/, ""));

  return item && /^Grade /.test(item.note || "")
    ? `${item.groupName}, ${item.note} · ${item.label}`
    : line.label;
};

// "a, b and c", as the site writes a list.
const list = (words) => (words.length > 1
  ? `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`
  : words.join(""));

// Each way to pay as the slip says it, by checkout's method keys.
export const PAY_WORDS = {
  card: "card", applepay: "Apple Pay", googlepay: "Google Pay",
  cashapp: "Cash App Pay", venmo: "Venmo",
};

// Every way checkout takes payment now: its methods, less Venmo while
// PayPal is unset or the button is held back.
export const acceptedWays = (env) => Object.keys(METHODS)
  .filter((m) => m !== "venmo" || (paypalConfigured(env)
    && !venmoHidden(env)))
  .map((m) => PAY_WORDS[m] || m);

// "Paid by card. Thank you!", "Paid with Apple Pay. Thank you!"
export const paidLine = (order) => {
  const ways = [...new Set(paymentsOf(order).map((p) => PAY_WORDS[p.method]
    || (p.via === "venmo" ? PAY_WORDS.venmo : PAY_WORDS.card)))]
    .sort((a, b) => (b === "card") - (a === "card"));

  if (!ways.length) return "Paid. Thank you!";

  return `Paid ${ways[0] === "card" ? "by" : "with"} ${list(ways)}. ` +
    "Thank you!";
};

// A card's brand as Square names it, as a customer would write it.
const BRANDS = {
  VISA: "Visa", MASTERCARD: "Mastercard", AMERICAN_EXPRESS: "American Express",
  DISCOVER: "Discover", DISCOVER_DINERS: "Diners Club", JCB: "JCB",
  UNIONPAY: "UnionPay",
};

const brandName = (brand) => BRANDS[brand] || String(brand).toLowerCase()
  .split("_").map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");

// "Visa *4242" for a card, else the method's name: "Venmo", "Apple
// Pay". A card the record has no brand or digits for is "Card".
export const paymentName = (p) => {
  if (p.via === "venmo") return PAY_WORDS.venmo;
  if (p.method && p.method !== "card" && PAY_WORDS[p.method]) {
    return PAY_WORDS[p.method];
  }
  if (!p.last4) return p.brand ? brandName(p.brand) : "Card";

  return `${p.brand ? brandName(p.brand) : "Card"} *${p.last4}`;
};

// "Amount due at pickup: $94", and the ways to pay it. Cash leads: the
// farm takes it in person, though the site never offers it (James,
// 2026-10-22, #181).
export const dueLines = (order, state, env) => [
  `Amount due at ${order.fulfilment.method === "delivery" ? "delivery"
    : "pickup"}: ${dollars(state.due)}`,
  `We accept ${list(["cash", ...acceptedWays(env).map((w) => (w === "card"
    ? "cards" : w))])}.`,
];

export const SLIP_THANKS = "Thank you for supporting local farms.";

// The farm's address as it goes on an envelope, one line each.
export const slipAddress = () => [
  company.name, company.address.street,
  `${company.address.city}, ${company.address.state} ${
    company.address.zip}`,
];

// A payment's date, "Nov 1, 2026", by the farm's clock.
export const paymentDate = (at) => (at ? new Intl.DateTimeFormat("en-US", {
  timeZone: tz, month: "short", day: "numeric", year: "numeric",
}).format(new Date(at)) : "");

// The phone, the sales address, the website and the Instagram handle,
// from the site's data. The website is the sales address's domain.
export const slipContacts = () => [
  company.phone.display,
  company.email,
  company.email.split("@")[1],
  `@${new URL(signatures.shared.instagram.url).pathname.replace(/\//g, "")}`,
].join("  ·  ");

const slipFooter = (doc) => {
  doc.line(M, 680, RIGHT, 680, { width: 0.75, color: GREEN });
  doc.text(SLIP_THANKS, CENTER, 698, {
    ...ALLER, size: 11, bold: true, color: GREEN, align: "center",
  });
  doc.text(slipContacts(), CENTER, 714, {
    ...ALLER, size: 9, color: INK, align: "center",
  });
  slipAddress().forEach((row, i) => doc.text(row, CENTER, 729 + i * 10.5, {
    ...ALLER, size: 8, color: MUTED, align: "center",
  }));
};

// The header on each page of a slip: the hen and wordmark, the order
// number, the green stripe the site's header has.
const slipSheet = (doc, { id }) => {
  let n = 0;

  return flow(() => {
    doc.page();
    n += 1;

    const w = doc.art(mark, M, 44, { height: 44, color: GREEN });

    doc.art(wordmark, M + w + 11, 58, { height: 16, color: GREEN });
    doc.text("Order", RIGHT, 60, {
      ...ALLER, size: 9, color: MUTED, align: "right",
    });
    doc.text(id, RIGHT, 79, {
      ...ALLER, size: 16, bold: true, color: GREEN, align: "right",
    });
    doc.rect(M, 98, RIGHT - M, 1.5, { fill: GREEN, stroke: 0 });
    slipFooter(doc);
    if (n === 1) return 104;

    doc.text("Your order (continued)", M, 130, {
      ...ALLER, size: 14, bold: true, color: GREEN,
    });

    return 150;
  }, SLIP_BOTTOM);
};

// PAID solid green, UNPAID an outline: apart at a glance, in colour
// and in gray.
const payBadge = (doc, state, x, top, w, h) => {
  const color = state.paid ? 1 : GREEN;

  // The outline drawn inside the box, so both line up with the stripe.
  if (state.paid) doc.rect(x, top, w, h, { fill: GREEN, stroke: 0 });
  else {
    doc.rect(x + 1.25, top + 1.25, w - 2.5, h - 2.5, {
      stroke: 2.5, color: GREEN,
    });
  }
  doc.text(paidWord(state), x + w / 2, top + h / 2 + 8, {
    ...ALLER, size: 22, bold: true, color, align: "center",
  });
};

// A column of the slip's details: a small label, then lines of text.
// -> the y below it.
const column = (doc, x, top, width, label, lines) => {
  let y = top;

  doc.text(label.toUpperCase(), x, y, {
    ...ALLER, size: 8, bold: true, color: MUTED,
  });
  y += 16;
  for (const [text, bold] of lines) {
    for (const row of wrap(text, width, {
      ...ALLER, size: bold ? 12 : 10.5, bold, rows: FIELD_ROWS,
    })) {
      doc.text(row, x, y, {
        ...ALLER, size: bold ? 12 : 10.5, bold, color: INK,
      });
      y += bold ? 16 : 14;
    }
  }

  return y;
};

const slipPage = (doc, order, env) => {
  const at = slipSheet(doc, { id: order.id });
  const where = placeOf(order);
  const state = paymentState(order);
  const d = order.fulfilment.delivery || {};
  const c = order.customer;

  doc.text("Your order", M, 146, {
    ...ALLER, size: 26, bold: true, color: GREEN,
  });
  payBadge(doc, state, RIGHT - 150, 118, 150, 40);

  let y = 178;

  if (state.paid) {
    doc.text(paidLine(order), M, y, { ...ALLER, size: 12, color: INK });
  } else {
    const [due, ways] = dueLines(order, state, env);

    doc.text(due, M, y, { ...ALLER, size: 13, bold: true, color: INK });
    for (const row of wrap(ways, RIGHT - M, { ...ALLER, size: 10.5 })) {
      y += 15;
      doc.text(row, M, y, { ...ALLER, size: 10.5, color: INK });
    }
  }

  const top = y + 30;
  const left = column(doc, M, top, 220, "Customer", [
    [c.name || "", true], [c.phone || ""], [c.email || ""],
  ].filter(([text]) => text));
  const right = column(doc, M + 260, top, RIGHT - M - 260, where.name, [
    [label(order.fulfilment.date), true],
    ...(where.window ? [[where.window]] : []),
    [where.place],
    ...(d.gate ? [[`Gate or code: ${d.gate}`]] : []),
  ]);

  at.y = Math.max(left, right) + 14;

  // The items: a slim green header row, then each line's quantity,
  // name, unit price and amount.
  at.room(15 + LINE * 3);
  doc.rect(M, at.y, RIGHT - M, 15, { fill: GREEN, stroke: 0 });
  for (const [text, x, align] of [
    ["Qty", M + 36, "right"], ["Item", M + 50, "left"],
    ["Price", PRICE_X, "right"], ["Amount", RIGHT - 8, "right"],
  ]) {
    doc.text(text, x, at.y + 10.5, {
      ...ALLER, size: 9, bold: true, color: 1, align,
    });
  }
  at.y += 33;

  for (const l of order.lines) {
    const rows = wrap(slipLabel(l), PRICE_X - 70 - M - 50, {
      ...ALLER, size: 11, rows: LABEL_ROWS,
    });
    const each = l.unitPrice ?? l.lineTotal / l.qty;

    at.room(rows.length * LINE + 10);
    doc.text(String(l.qty), M + 36, at.y, {
      ...ALLER, size: 11, bold: true, color: INK, align: "right",
    });
    rows.forEach((row, i) => doc.text(row, M + 50, at.y + i * LINE, {
      ...ALLER, size: 11, color: INK,
    }));
    doc.text(dollars(Math.round(each * 100)), PRICE_X, at.y, {
      ...ALLER, size: 11, color: INK, align: "right",
    });
    doc.text(dollars(Math.round(l.lineTotal * 100)), RIGHT - 8, at.y, {
      ...ALLER, size: 11, color: INK, align: "right",
    });
    at.y += rows.length * LINE - 4;
    doc.line(M, at.y, RIGHT, at.y, { width: 0.5, color: RULE });
    at.y += 18;
  }

  const t = order.totals;
  const sums = [["Subtotal", dollars(t.subtotal)]];

  if (t.discountAmount) {
    sums.push([t.discountLabel || "Discount", `-${dollars(t.discountAmount)}`]);
  }
  if (t.deliveryFee) sums.push(["Delivery fee", dollars(t.deliveryFee)]);
  sums.push(["Total", dollars(t.total)]);

  // What has been paid, below the total: a ledger line for each, its
  // date, method and amount, then a rule and what is still due.
  const paid = paymentsOf(order).filter((p) => p.amount > 0);
  const rows = sums.length + paid.length + (state.refunded ? 1 : 0)
    + (paid.length ? 2 : 0);
  const RULE_X = RIGHT - 270;
  const money = (name, value, bold) => {
    const size = bold ? 12 : 11;

    doc.text(name, RIGHT - 110, at.y, {
      ...ALLER, size, bold, color: INK, align: "right",
    });
    doc.text(value, RIGHT - 8, at.y, {
      ...ALLER, size, bold, color: INK, align: "right",
    });
  };

  at.room(rows * LINE + 24);
  for (const [name, value] of sums) {
    if (name === "Total") {
      doc.line(RIGHT - 220, at.y - 9, RIGHT, at.y - 9, {
        width: 0.75, color: GREEN,
      });
      at.y += 9;
    }
    money(name, value, name === "Total");
    at.y += name === "Total" ? LINE + 3 : LINE;
  }
  for (const p of paid) {
    doc.text(paymentDate(p.at), RULE_X, at.y, {
      ...ALLER, size: 11, color: INK,
    });
    doc.text(paymentName(p), RIGHT - 70, at.y, {
      ...ALLER, size: 11, color: INK, align: "right",
    });
    doc.text(`-${dollars(p.amount)}`, RIGHT - 8, at.y, {
      ...ALLER, size: 11, color: INK, align: "right",
    });
    at.y += LINE;
  }
  if (state.refunded) {
    money("Refunded", dollars(state.refunded));
    at.y += LINE;
  }
  if (paid.length) {
    doc.line(RULE_X, at.y - 9, RIGHT, at.y - 9, {
      width: 0.75, color: GREEN,
    });
    at.y += 6;
    doc.text("Due", RULE_X, at.y, {
      ...ALLER, size: 12, bold: true, color: INK,
    });
    doc.text(dollars(state.due), RIGHT - 8, at.y, {
      ...ALLER, size: 12, bold: true, color: INK, align: "right",
    });
  }
};

// --- The farm's sheets --------------------------------------------------

const revisionPage = (doc, entry, now) => {
  const cancelled = entry.kind === "cancelled";
  const order = entry.order;
  const at = sheet(doc, {
    title: cancelled ? "Canceled" : "Revised order", id: order.id, now,
  });

  banner(doc, at, cancelled ? "CANCELED" : "REVISED", { x: M, w: RIGHT - M });
  at.y += 66;

  const f = order.fulfilment || {};

  if (order.customer) field(doc, at, "Customer", order.customer.name || "");
  if (f.method) field(doc, at, "Type", placeOf(order).name);
  if (f.date) field(doc, at, "Date", label(f.date));
  at.y += 10;

  if (cancelled) {
    for (const row of wrap("This order is canceled. Don't pack it, and " +
      "throw away the slip printed for it earlier.", RIGHT - M, {
      size: 13, bold: true,
    })) {
      doc.text(row, M, at.y, { size: 13, bold: true });
      at.y += LINE + 3;
    }

    return;
  }

  doc.text("What changed since its last slip", M, at.y, {
    size: 13, bold: true,
  });
  at.y += LINE + 6;
  for (const change of entry.changes.length ? entry.changes
    : ["Only the details changed: see the new slip"]) {
    const rows = wrap(change, RIGHT - M - 16, {
      size: 11, rows: LABEL_ROWS,
    });

    at.room(rows.length * LINE);
    doc.text("•", M + 2, at.y, { size: 11 });
    rows.forEach((row, i) => doc.text(row, M + 16, at.y + i * LINE, {
      size: 11,
    }));
    at.y += rows.length * LINE + 3;
  }
  at.y += 10;
  for (const row of wrap("The new packing slip follows. Throw away the " +
    "one printed earlier.", RIGHT - M, { size: 11, bold: true })) {
    doc.text(row, M, at.y, { size: 11, bold: true });
    at.y += LINE;
  }
};

const KIND = {
  new: "New", changed: "Revised", weekly: "Reprint", cancelled: "CANCELED",
};

const coverPage = (doc, { entries, now, title }) => {
  const at = sheet(doc, { title, now });
  const picks = pickList(entries);

  doc.text(packetCounts(countsOf(entries)), M, at.y, { size: 11 });
  at.y += LINE + 12;

  doc.text("Pick list", M, at.y, { size: 14, bold: true });
  at.y += LINE + 4;
  if (!picks.length) {
    doc.text("Nothing to pick.", M, at.y, { size: 11 });
    at.y += LINE;
  }
  for (const p of picks) {
    const rows = wrap(p.label, RIGHT - M - 70, {
      size: 11, rows: LABEL_ROWS,
    });

    at.room(rows.length * LINE + 2);
    doc.rect(M, at.y - 9, 9, 9, { stroke: 0.75 });
    doc.text(`${p.qty}`, M + 46, at.y, { size: 11, bold: true,
      align: "right" });
    doc.text("×", M + 52, at.y, { size: 11 });
    rows.forEach((row, i) => doc.text(row, M + 66, at.y + i * LINE, {
      size: 11,
    }));
    at.y += rows.length * LINE + 2;
  }

  at.y += 16;
  at.room(LINE * 3);
  doc.text("In this packet", M, at.y, { size: 14, bold: true });
  at.y += LINE + 4;
  for (const e of entries) {
    const f = e.order.fulfilment || {};
    const name = (e.order.customer && e.order.customer.name) || "";

    at.room(LINE);
    doc.text(e.order.id, M, at.y, { size: 10, bold: true });
    doc.text(wrap(name, 125, { size: 10 })[0], M + 95, at.y, { size: 10 });
    doc.text(f.method ? placeOf(e.order).name : "", M + 225, at.y, {
      size: 10,
    });
    doc.text(f.date ? label(f.date) : "", M + 310, at.y, { size: 10 });
    doc.text(KIND[e.kind], M + 430, at.y, { size: 10, bold: e.kind !== "new"
      && e.kind !== "weekly" });
    at.y += LINE;
  }
};

// The whole packet: the cover (unless `cover` is false; "only" is the
// cover alone), then for each entry its revision sheet and slip as it
// needs. `env` says which ways
// to pay an unpaid slip lists. -> a Buffer.
export const packetPdf = ({
  entries, now, title, cover = true, env = process.env,
}) => {
  const doc = pdf({ title });

  if (cover) coverPage(doc, { entries, now, title });
  for (const e of cover === "only" ? [] : entries) {
    if (e.kind === "changed" || e.kind === "cancelled") {
      revisionPage(doc, e, now);
    }
    if (e.kind !== "cancelled") slipPage(doc, e.order, env);
  }

  return doc.bytes();
};

export const packetTitle = (day) => (isSunday(day)
  ? `Packing slips for the week of ${label(day)}`
  : `Packing slips, ${label(day)}`);

export const fileName = (day, suffix = "") =>
  `packing-slips-${day}${suffix}.pdf`;

export const attachment = (filename, bytes) => ({
  filename, contentType: "application/pdf",
  content: bytes.toString("base64"),
});

// --- Reading the records ---------------------------------------------

// Every order that gets a slip: paid, or an older record still unpaid.
export const PACKED = ["paid", "submitted"];
const GONE = ["cancelled", "abandoned"];

// The orders to pack, and each printed order since cancelled (or
// deleted) and not yet past its date. A fulfilled one drops out. The
// morning packet reads every order, so an unpaid one is found too;
// the check after it reads only the printed ones.
const gather = async (stores, day, { every = true } = {}) => {
  const printed = await readPrinted(stores);
  const orders = every
    ? await allOrders(stores)
    : (await Promise.all([...printed.keys()]
      .map((id) => getOrder(stores, id)))).filter(Boolean);
  const byId = new Map(orders.map((o) => [o.id, o]));
  const open = orders.filter((o) => PACKED.includes(o.status));
  const gone = [];

  for (const record of printed.values()) {
    if (record.snapshot.status === "cancelled" || record.date < day) continue;

    const order = byId.get(record.id) || null;

    if (order && !GONE.includes(order.status)) continue;
    gone.push({
      record: {
        id: record.id, customer: null,
        fulfilment: {
          method: record.snapshot.method, date: record.snapshot.date,
          ...record.snapshot.occurrence
            && { occurrence: record.snapshot.occurrence },
        },
      },
      order,
    });
  }

  return { open, printed, gone };
};

// What an entry's slip or sheet shows, to keep as printed.
const printedOf = (e) => ({
  id: e.order.id,
  date: e.order.fulfilment.date,
  snapshot: e.kind === "cancelled"
    ? { ...(e.order.lines ? snapshotOf(e.order) : {}), status: "cancelled" }
    : snapshotOf(e.order),
});

const remember = async (stores, records, now) => {
  for (const r of records) {
    await stores.jobs.set(printedKey(r.id), { ...r, at: now.toISOString() });
  }
};

// Snapshots of orders KEEP_DAYS past their date go, and so do the
// pending packets and change notes of past days.
const prune = async (stores, day) => {
  const floor = addDays(day, -KEEP_DAYS);
  let n = 0;

  for (const record of (await readPrinted(stores)).values()) {
    if (record.date < floor) {
      await stores.jobs.delete(printedKey(record.id));
      n += 1;
    }
  }
  for (const prefix of [PENDING, CHANGED]) {
    for (const { key } of await stores.jobs.list(prefix)) {
      if (key.slice(prefix.length, prefix.length + 10) < day) {
        await stores.jobs.delete(key);
      }
    }
  }

  return n;
};

// Resend's answer when a key it has already sent comes back with a
// different body: what that key carried went out, so it counts as
// sent.
export const alreadySent = (error) => error instanceof MailError
  && error.status === 409
  && !!error.detail && error.detail.name === "invalid_idempotent_request";

// --- Healthchecks -------------------------------------------------------

// The packing check is production's alone: a staging or local run
// never pings it, whatever its variables say. A production run that
// sends through Resend without the key is an error, never a skip.
export const PING_KEY = "HEALTHCHECKS_PACKING_URL";

export const sendsForReal = (env) =>
  resendAllowed(env) && env.MAIL_DRIVER === "resend";

const pingUrl = (env) => (resendAllowed(env) ? env[PING_KEY] : null);

export const missingPingKey = (env) => sendsForReal(env) && !env[PING_KEY];

// --- The morning run ----------------------------------------------------

// From PACKING_HOUR, once a day: the packet, or the quiet-day email.
//
// The first try fixes the day's packet in `packing/pending/<day>`:
// its time and each order with what its sheet shows. A retry sends
// the same orders with the same time, so a send whose answer was lost
// is not sent twice: Resend answers the same key with the first send.
// If an order changed in between, the body differs and Resend refuses
// the key; the first send went out, so the day counts as sent, as the
// pending record printed it, and the change is caught later.
//
// -> { day, sunday, quiet, slips, revised, cancelled } or null when
// nothing was done this run. Throws when the packet could not go (the
// next run tries again) or went without its check configured.
export const packingDaily = async (stores, {
  env = process.env, mail = sendMail, now = clock(),
  fetchImpl = globalThis.fetch,
} = {}) => {
  const day = today(now, tz);
  const to = farmEmails(env);
  const hour = parts(now, tz).hour;

  if (hour < PACKING_HOUR || !to.length) return null;
  if (await stores.jobs.get(`${SENT}${day}`)) return null;

  const pendingKey = `${PENDING}${day}`;
  let pending = await stores.jobs.get(pendingKey);

  if (!pending && hour >= PACKING_LAST_HOUR) return null;

  let result;

  try {
    let entries = choose({ ...(await gather(stores, day)), day });

    if (pending) {
      const ids = new Set(pending.entries.map((e) => e.id));

      entries = entries.filter((e) => ids.has(e.order.id));
    } else {
      pending = {
        at: now.toISOString(),
        entries: entries.map((e) => ({ ...printedOf(e), kind: e.kind })),
      };
      await stores.jobs.set(pendingKey, pending);
    }

    const stamp = new Date(pending.at);
    const summary = {
      day, sunday: isSunday(day), quiet: !entries.length,
      ...countsOf(entries),
    };
    const filename = fileName(day);
    let records = entries.map(printedOf);

    try {
      await mail({
        to, idempotencyKey: `packing-${day}`,
        ...farmPackingSlips(entries, {
          ...summary, filename, links: mailLinks(env),
        }),
        attachments: summary.quiet ? [] : [attachment(filename, packetPdf({
          entries, now: stamp, title: packetTitle(day), env,
        }))],
      }, { env });
    } catch (error) {
      if (!alreadySent(error)) throw error;
      log.warn({ event: "packing.already_sent", day });
      records = pending.entries.map((r) => ({
        id: r.id, date: r.date, snapshot: r.snapshot,
      }));
    }
    await remember(stores, records, stamp);
    await stores.jobs.set(`${SENT}${day}`, {
      at: now.toISOString(), ...summary, ids: records.map((r) => r.id),
    });
    await stores.jobs.delete(pendingKey);
    await prune(stores, day);
    result = summary;
  } catch (error) {
    const message = String((error && error.message) || error);

    log.error({ event: "packing.failed", error: message });
    await ping(pingUrl(env), {
      ok: false, body: scrub({ failed: "packing", day, error: message }),
      fetchImpl,
    });
    throw error;
  }

  await ping(pingUrl(env), { ok: true, fetchImpl });
  log.info({ event: "packing.sent", ...result });

  if (missingPingKey(env)) {
    throw new Error(`${PING_KEY} is not set: the packing slips went out ` +
      "but nothing told Healthchecks. Set it on production.");
  }

  return result;
};

// A day's packet as the morning job would build it from the orders
// and printed records in `stores`, for the staging toolbar's preview
// (#334). It reads and writes nothing, sends nothing.
// -> { day, entries, bytes } (bytes null when there is nothing to pack).
export const packetPreview = async (stores, day, {
  env = process.env, now = clock(),
} = {}) => {
  const entries = choose({ ...(await gather(stores, day)), day });

  return {
    day, entries,
    bytes: entries.length ? packetPdf({
      entries, now, title: packetTitle(day), env,
    }) : null,
  };
};

// --- After the packet ---------------------------------------------------

// An order due today that changed after it was printed, once today's
// packet is out: the farm hears at once, with its revision sheet and
// a fresh slip, and the snapshot moves on so each change is mailed
// once. The key names the change by its content, so a retry of the
// same change is the same message and a newer change a new one.
//
// Known gap (#292 QA, nit a), left for later: an order that goes from
// A to B, back to A and to B again on its day repeats B's key within
// Resend's 24 hours, so the last mail is deduplicated and never sent,
// and the farm's newest sheet shows A. A count of the order's changes
// that day in the key would close it.
// -> the ids mailed this run.
export const changedAfterPrint = async (stores, {
  env = process.env, mail = sendMail, now = clock(),
} = {}) => {
  const day = today(now, tz);
  const to = farmEmails(env);

  if (!to.length || !(await stores.jobs.get(`${SENT}${day}`))) return [];

  const { open, printed, gone } = await gather(stores, day, { every: false });
  const entries = choose({ open, printed, gone, day })
    .filter((e) => e.order.fulfilment.date === day && e.kind !== "weekly");
  const sent = [];

  for (const e of entries) {
    const record = printedOf(e);
    const change = hash(record.snapshot);
    const filename = fileName(day, `-${e.order.id}-${change.slice(0, 6)}`);

    try {
      await mail({
        to, idempotencyKey: `packing-changed-${day}-${e.order.id}-${change}`,
        ...farmChangedAfterPrint(e, { date: day, links: mailLinks(env) }),
        attachments: [attachment(filename, packetPdf({
          entries: [e], now, cover: false, env,
          title: `Changed after printing, ${label(day)}`,
        }))],
      }, { env });
    } catch (error) {
      if (!alreadySent(error)) throw error;
    }
    await remember(stores, [record], now);
    await stores.jobs.set(`${CHANGED}${day}/${e.order.id}/${change}`, {
      at: now.toISOString(), kind: e.kind,
    });
    sent.push(e.order.id);
  }

  return sent;
};
