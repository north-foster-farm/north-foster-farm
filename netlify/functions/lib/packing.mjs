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

import terms from "../../../data/delivery.json" with { type: "json" };
import { pickupTimes } from "../../../assets/scripts/order/lib/schedule.mjs";
import { dollars } from "../../../assets/scripts/order/lib/totals.mjs";
import {
  addDays, label, parts, today, weekday,
} from "../../../assets/scripts/order/lib/zoned.mjs";
import { company } from "./company.mjs";
import { placeOf } from "./describe.mjs";
import { ping } from "./health.mjs";
import { log } from "./log.mjs";
import { farmEmails, sendMail } from "./mail.mjs";
import { pdf, wrap } from "./pdf.mjs";
import {
  getOrder, openOrders, paidTotal, paymentsOf, refundedTotal,
} from "./records.mjs";
import { resendAllowed } from "./resend-guard.mjs";
import { mailLinks } from "./site.mjs";
import { farmChangedAfterPrint, farmPackingSlips } from "./templates.mjs";

const tz = terms.timeZone;

export const PACKING_HOUR = 6;
export const KEEP_DAYS = 30;
export const PRINTED = "packing/printed/";
export const SENT = "packing/sent/";
export const CHANGED = "packing/changed/";

const printedKey = (id) => `${PRINTED}${id}`;

// The order the slips stack in, within a day.
const METHOD_ORDER = ["delivery", "scituate", "onfarm"];

const hash = (...values) => createHash("sha256")
  .update(JSON.stringify(values)).digest("hex").slice(0, 16);

// --- Money ------------------------------------------------------------

// PAID when the money kept covers the total, from the payments and
// refunds on the record rather than its status: an order from before
// checkout moved onto the page may still be `submitted`, unpaid.
export const paymentState = (order) => {
  const kept = paidTotal(order) - refundedTotal(order);
  const due = order.status === "submitted"
    ? order.totals.total
    : Math.max(0, order.totals.total - kept);

  return { paid: due === 0, due };
};

const paidWord = (state) => (state.paid ? "PAID" : "UNPAID");

const VIA = { square: "Card", venmo: "Venmo" };

// "Card", "Venmo", "Apple Pay": how it was paid, first payment first.
const paidVia = (order) => [...new Set(paymentsOf(order).map((p) => ({
  applepay: "Apple Pay", googlepay: "Google Pay", cashapp: "Cash App Pay",
}[p.method] || VIA[p.via] || p.via)).filter(Boolean))].join(", ");

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
  };
};

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

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
  if (before.method !== after.method) {
    out.push(`Type: was ${placeOf({ fulfilment: { method: before.method } })
      .name}, now ${placeOf({ fulfilment: { method: after.method } }).name}`);
  }
  if (before.date !== after.date) {
    out.push(`Date: was ${label(before.date)}, now ${label(after.date)}`);
  }
  if (before.window !== after.window) {
    out.push(`Window: was ${before.window || "none"}, now ${
      after.window || "none"}`);
  }
  if (before.place !== after.place && before.method === after.method) {
    out.push("Place or address changed: see the new slip");
  }
  if (before.notes !== after.notes) {
    out.push("Instructions changed: see the new slip");
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
    const word = (s) => (s.paid ? "PAID" : `UNPAID, ${dollars(s.due)} due`);

    out.push(`Payment: was ${word(before)}, now ${word(after)}`);
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

  return entries.sort(byFulfilment);
};

const startOf = (order) => {
  const times = order.fulfilment && order.fulfilment.method === "onfarm"
    ? pickupTimes(order.fulfilment.onfarm) : null;

  return times ? times.from : "";
};

const rank = (method) => {
  const i = METHOD_ORDER.indexOf(method);

  return i < 0 ? METHOD_ORDER.length : i;
};

// By fulfilment date, then type, then pickup time, then order number.
export const byFulfilment = (a, b) => {
  const fa = a.order.fulfilment;
  const fb = b.order.fulfilment;

  return fa.date.localeCompare(fb.date)
    || rank(fa.method) - rank(fb.method)
    || startOf(a.order).localeCompare(startOf(b.order))
    || a.order.id.localeCompare(b.order.id);
};

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

const M = 54;
const RIGHT = 612 - M;
const BOTTOM = 792 - 54;
const LINE = 15;

const stamp = (now) => new Intl.DateTimeFormat("en-US", {
  timeZone: tz, weekday: "short", month: "short", day: "numeric",
  hour: "numeric", minute: "2-digit",
}).format(now);

// One page or more for one sheet, with a footer on each.
const sheet = (doc, { title, id, now }) => {
  let y = 0;
  const pageNo = { n: 0 };
  const start = () => {
    doc.page();
    pageNo.n += 1;
    doc.text(company.name, M, M, {
      size: 9, shade: 0.35,
    });
    doc.text(`${title}${pageNo.n > 1 ? " (continued)" : ""}`, M, M + 22, {
      size: 18, bold: true,
    });
    if (id) {
      doc.text(id, RIGHT, M + 22, { size: 18, bold: true, align: "right" });
    }
    doc.text(`Printed ${stamp(now)}`, M, BOTTOM + 24, { size: 8, shade: 0.4 });
    y = M + 50;
  };

  start();

  return {
    get y() {
      return y;
    },
    set y(v) {
      y = v;
    },
    // Room for `h` more points, or a new page.
    room(h) {
      if (y + h > BOTTOM) start();
    },
  };
};

const field = (doc, at, name, value, { width = RIGHT - M - 90 } = {}) => {
  const rows = wrap(value || "", width, { size: 11 });

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

const slipPage = (doc, order, now) => {
  const at = sheet(doc, { title: "Packing slip", id: order.id, now });
  const where = placeOf(order);
  const state = paymentState(order);
  const d = order.fulfilment.delivery || {};

  banner(doc, at, paidWord(state));
  if (!state.paid) {
    doc.text(`${dollars(state.due)} due`, RIGHT - 85, at.y + 54, {
      size: 11, bold: true, align: "center",
    });
  }

  const c = order.customer;

  field(doc, at, "Customer", c.name || "", { width: 250 });
  field(doc, at, "Phone", c.phone || "", { width: 250 });
  field(doc, at, "Email", c.email || "", { width: 250 });
  at.y = Math.max(at.y, M + 50 + 70) + 18;
  doc.line(M, at.y - 16, RIGHT, at.y - 16, { width: 0.5, shade: 0.6 });

  field(doc, at, "Type", where.name);
  field(doc, at, "Date", label(order.fulfilment.date));
  if (where.window) field(doc, at, "Window", where.window);
  field(doc, at, order.fulfilment.method === "delivery" ? "Address"
    : "Place", where.place);
  if (d.cooler) field(doc, at, "Cooler", d.cooler);
  if (d.gate) field(doc, at, "Gate or code", d.gate);
  if (d.notes) field(doc, at, "Delivery notes", d.notes);
  if (order.notes) field(doc, at, "Order notes", order.notes);

  at.y += 10;
  at.room(LINE * 3);
  doc.rect(M, at.y - 12, RIGHT - M, 18, { fill: 0.9, stroke: 0 });
  doc.text("Qty", M + 6, at.y, { size: 9, bold: true });
  doc.text("Item", M + 50, at.y, { size: 9, bold: true });
  doc.text("Price", RIGHT - 6, at.y, { size: 9, bold: true, align: "right" });
  at.y += LINE + 4;

  for (const l of order.lines) {
    const rows = wrap(l.label, RIGHT - M - 140, { size: 11 });

    at.room(rows.length * LINE + 4);
    doc.rect(M + 6, at.y - 9, 9, 9, { stroke: 0.75 });
    doc.text(String(l.qty), M + 40, at.y, { size: 11, bold: true,
      align: "right" });
    rows.forEach((row, i) => doc.text(row, M + 50, at.y + i * LINE, {
      size: 11,
    }));
    doc.text(dollars(Math.round(l.lineTotal * 100)), RIGHT - 6, at.y, {
      size: 11, align: "right",
    });
    at.y += rows.length * LINE + 4;
  }

  const t = order.totals;
  const sums = [["Subtotal", dollars(t.subtotal)]];

  if (t.discountAmount) {
    sums.push([t.discountLabel || "Discount", `-${dollars(t.discountAmount)}`]);
  }
  if (t.deliveryFee) sums.push(["Delivery fee", dollars(t.deliveryFee)]);
  sums.push(["Total", dollars(t.total)]);

  at.room(sums.length * LINE + 30);
  doc.line(M, at.y - 6, RIGHT, at.y - 6, { width: 0.5, shade: 0.6 });
  at.y += 8;
  for (const [name, value] of sums) {
    const bold = name === "Total";

    doc.text(name, RIGHT - 120, at.y, { size: 11, bold, align: "right" });
    doc.text(value, RIGHT - 6, at.y, { size: 11, bold, align: "right" });
    at.y += LINE;
  }

  const via = paidVia(order);

  at.y += 6;
  doc.text(`${paidWord(state)}${via ? `, ${via}` : ""}${
    state.paid ? "" : `: ${dollars(state.due)} due`}`, RIGHT - 6, at.y, {
    size: 11, bold: true, align: "right",
  });
};

const revisionPage = (doc, entry, now) => {
  const cancelled = entry.kind === "cancelled";
  const order = entry.order;
  const at = sheet(doc, {
    title: cancelled ? "Cancelled" : "Revised order", id: order.id, now,
  });

  banner(doc, at, cancelled ? "CANCELLED" : "REVISED", { x: M, w: RIGHT - M });
  at.y += 66;

  const f = order.fulfilment || {};

  if (order.customer) field(doc, at, "Customer", order.customer.name || "");
  if (f.method) field(doc, at, "Type", placeOf(order).name);
  if (f.date) field(doc, at, "Date", label(f.date));
  at.y += 10;

  if (cancelled) {
    for (const row of wrap("This order is cancelled. Don't pack it, and " +
      "throw away the slip printed for it earlier.", RIGHT - M, {
      size: 13,
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
    : ["Details only: see the new slip"]) {
    const rows = wrap(change, RIGHT - M - 16, { size: 11 });

    at.room(rows.length * LINE);
    doc.text("•", M + 2, at.y, { size: 11 });
    rows.forEach((row, i) => doc.text(row, M + 16, at.y + i * LINE, {
      size: 11,
    }));
    at.y += rows.length * LINE + 3;
  }
  at.y += 10;
  for (const row of wrap("The new packing slip follows. Throw away the " +
    "one printed earlier.", RIGHT - M, { size: 11 })) {
    doc.text(row, M, at.y, { size: 11, bold: true });
    at.y += LINE;
  }
};

const KIND = {
  new: "New", changed: "Revised", weekly: "Week", cancelled: "CANCELLED",
};

const coverPage = (doc, { entries, now, title }) => {
  const at = sheet(doc, { title, now });
  const slips = slipsOf(entries);
  const picks = pickList(entries);

  doc.text(`${slips.length} slip${slips.length === 1 ? "" : "s"}, ${
    entries.filter((e) => e.kind === "changed").length} revised, ${
    entries.filter((e) => e.kind === "cancelled").length} cancelled`, M,
  at.y, { size: 11 });
  at.y += LINE + 12;

  doc.text("Pick list", M, at.y, { size: 14, bold: true });
  at.y += LINE + 4;
  if (!picks.length) {
    doc.text("Nothing to pick.", M, at.y, { size: 11 });
    at.y += LINE;
  }
  for (const p of picks) {
    const rows = wrap(p.label, RIGHT - M - 70, { size: 11 });

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

// The whole packet: the cover (unless `cover` is false), then for each
// entry its revision sheet and slip as it needs. -> a Buffer.
export const packetPdf = ({ entries, now, title, cover = true }) => {
  const doc = pdf({ title });

  if (cover) coverPage(doc, { entries, now, title });
  for (const e of entries) {
    if (e.kind === "changed" || e.kind === "cancelled") {
      revisionPage(doc, e, now);
    }
    if (e.kind !== "cancelled") slipPage(doc, e.order, now);
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

// The open orders, and each printed order no longer open: cancelled
// (or deleted) since it was printed and not yet past its date. A
// fulfilled one drops out.
const gather = async (stores, day) => {
  const open = (await openOrders(stores)).filter((o) => o.status === "paid");
  const printed = await readPrinted(stores);
  const openIds = new Set(open.map((o) => o.id));
  const gone = [];

  for (const record of printed.values()) {
    if (openIds.has(record.id) || record.snapshot.status === "cancelled"
      || record.date < day) {
      continue;
    }

    const order = await getOrder(stores, record.id);

    if (!order || order.status === "cancelled") {
      gone.push({
        record: {
          id: record.id, customer: null,
          fulfilment: {
            method: record.snapshot.method, date: record.snapshot.date,
          },
        },
        order,
      });
    }
  }

  return { open, printed, gone };
};

const remember = async (stores, entries, now) => {
  for (const e of entries) {
    const snapshot = e.kind === "cancelled"
      ? { ...(e.order.lines ? snapshotOf(e.order) : {}), status: "cancelled" }
      : snapshotOf(e.order);

    await stores.jobs.set(printedKey(e.order.id), {
      id: e.order.id, at: now.toISOString(),
      date: e.order.fulfilment.date, snapshot,
    });
  }
};

// Snapshots of orders KEEP_DAYS past their date go.
const prune = async (stores, day) => {
  const floor = addDays(day, -KEEP_DAYS);
  let n = 0;

  for (const record of (await readPrinted(stores)).values()) {
    if (record.date < floor) {
      await stores.jobs.delete(printedKey(record.id));
      n += 1;
    }
  }

  return n;
};

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
// -> { day, kind, slips, revised, cancelled, quiet } or null when
// nothing was done this run. Throws when the packet could not go (the
// next run tries again) or went without its check configured.
export const packingDaily = async (stores, {
  env = process.env, mail = sendMail, now = new Date(),
  fetchImpl = globalThis.fetch,
} = {}) => {
  const day = today(now, tz);
  const to = farmEmails(env);

  if (parts(now, tz).hour < PACKING_HOUR || !to.length) return null;
  if (await stores.jobs.get(`${SENT}${day}`)) return null;

  let result;

  try {
    const entries = choose({ ...(await gather(stores, day)), day });
    const title = packetTitle(day);
    const quiet = !entries.length;
    const summary = {
      day, sunday: isSunday(day), quiet,
      slips: slipsOf(entries).length,
      revised: entries.filter((e) => e.kind === "changed").length,
      cancelled: entries.filter((e) => e.kind === "cancelled").length,
    };
    const filename = fileName(day);
    const message = farmPackingSlips(entries, {
      ...summary, filename, links: mailLinks(env),
    });

    await mail({
      to, idempotencyKey: `packing-${day}`, ...message,
      attachments: quiet ? [] : [
        attachment(filename, packetPdf({ entries, now, title })),
      ],
    }, { env });
    await remember(stores, entries, now);
    await stores.jobs.set(`${SENT}${day}`, {
      at: now.toISOString(), ...summary,
      ids: entries.map((e) => e.order.id),
    });
    await prune(stores, day);
    result = summary;
  } catch (error) {
    const message = String((error && error.message) || error);

    log.error({ event: "packing.failed", error: message });
    await ping(pingUrl(env), {
      ok: false, body: { failed: "packing", day, error: message }, fetchImpl,
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

// --- After the packet ---------------------------------------------------

// An order due today that changed after it was printed, once today's
// packet is out: the farm hears at once, with its revision sheet and
// a fresh slip, and the snapshot moves on so each change is mailed
// once. -> the ids mailed this run.
export const changedAfterPrint = async (stores, {
  env = process.env, mail = sendMail, now = new Date(),
} = {}) => {
  const day = today(now, tz);
  const to = farmEmails(env);

  if (!to.length || !(await stores.jobs.get(`${SENT}${day}`))) return [];

  const { open, printed, gone } = await gather(stores, day);
  const dueToday = (e) => e.order.fulfilment.date === day;
  const entries = choose({
    open: open.filter((o) => printed.has(o.id)), printed, gone, day,
  }).filter((e) => dueToday(e) && e.kind !== "weekly");
  const sent = [];

  for (const e of entries) {
    const n = (await stores.jobs.list(`${CHANGED}${day}/${e.order.id}/`))
      .length + 1;
    const filename = fileName(day, `-${e.order.id}-${n}`);

    await mail({
      to, idempotencyKey: `packing-changed-${day}-${e.order.id}-${n}`,
      ...farmChangedAfterPrint(e, { date: day, links: mailLinks(env) }),
      attachments: [attachment(filename, packetPdf({
        entries: [e], now, cover: false,
        title: `Changed after printing, ${label(day)}`,
      }))],
    }, { env });
    await remember(stores, [e], now);
    await stores.jobs.set(`${CHANGED}${day}/${e.order.id}/${n}`, {
      at: now.toISOString(), kind: e.kind,
    });
    sent.push(e.order.id);
  }

  return sent;
};
