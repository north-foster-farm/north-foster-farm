// The account's two downloads (#165): the whole order history and the
// whole receipt history, each a CSV for a spreadsheet. Both are built
// in the browser from the orders the page already holds, so they
// carry exactly what the Orders and Receipts tabs show. Pure: the
// page names the file and saves it.

export const METHOD = {
  delivery: "Delivery",
  scituate: "Drop site",
  onfarm: "On-farm pickup",
};

const STATUS = {
  paid: "Paid",
  fulfilled: "Delivered",
  cancelled: "Cancelled",
  // From before the checkout moved onto the page.
  submitted: "Awaiting payment",
  abandoned: "Not paid",
};

const WALLETS = {
  applepay: "Apple Pay", googlepay: "Google Pay", cashapp: "Cash App Pay",
  venmo: "Venmo",
};

// Cents as a plain number a spreadsheet sums: 1250 -> "12.50".
const amount = (cents) => ((cents || 0) / 100).toFixed(2);

const day = (iso) => (iso ? String(iso).slice(0, 10) : "");

// A spreadsheet runs a cell that starts with = + - @ as a formula;
// text gets a leading apostrophe so it stays text. A plain number,
// such as a refund's -3.00, is no formula and passes.
const cell = (value) => {
  let s = String(value ?? "");

  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;

  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, "\"\"")}"` : s;
};

const csv = (rows) => `${rows.map((r) => r.map(cell).join(",")).join("\r\n")
}\r\n`;

// A finished order was delivered only if it went by delivery; the
// rest were picked up (copy's #158 review; the wording is a draft).
export const statusOf = (order) => (order.status === "fulfilled"
  && order.fulfilment && order.fulfilment.method !== "delivery"
  ? "Picked up"
  : STATUS[order.status] || order.status);

// "Visa ending 4242", "Apple Pay", "Venmo".
export const paidWith = (payment) => {
  const p = payment || {};

  if (WALLETS[p.method]) return WALLETS[p.method];

  const brand = String(p.brand || "card").toLowerCase()
    .replace(/_/g, " ")
    .replace(/\b\w/g, (ch) => ch.toUpperCase());

  return p.last4 ? `${brand} ending ${p.last4}` : brand;
};

const sum = (items) => (items || []).reduce((s, x) => s + (x.amount || 0), 0);

// One row per order, newest first as the page lists them.
export const ordersCsv = (orders) => csv([
  ["Order", "Placed", "Status", "How", "For", "Items", "Subtotal",
    "Discount", "Delivery fee", "Total", "Paid", "Refunded"],
  ...orders.map((o) => {
    const t = o.totals || {};
    const f = o.fulfilment || {};

    return [
      o.id,
      day(o.submittedAt),
      o.cancelRequested ? "Cancellation requested" : statusOf(o),
      METHOD[f.method] || f.method || "",
      f.date || "",
      (o.lines || []).map((l) => `${l.qty} x ${l.label}`).join("; "),
      amount(t.subtotal),
      amount(t.discountAmount),
      amount(t.deliveryFee),
      amount(t.total),
      amount(sum(o.payments)),
      amount(sum(o.refunds)),
    ];
  }),
]);

// What stands for the receipt: Square's link for a card or wallet
// payment, PayPal's transaction id for Venmo (PayPal gives no link).
const receiptOf = (p) => {
  if (p.receiptUrl) return p.receiptUrl;
  if (p.paypalCaptureId) return `PayPal ${p.paypalCaptureId}`;

  return "";
};

// One row per payment and one per refund, oldest first, so it reads
// as a ledger; a refund is negative and names the payment it left.
export const receiptsCsv = (orders) => {
  const rows = orders.flatMap((o) => [
    ...(o.payments || []).map((p) => ({
      at: p.at || "",
      row: [day(p.at), o.id, "Payment", amount(p.amount), paidWith(p),
        p.payer || "", receiptOf(p)],
    })),
    ...(o.refunds || []).map((r) => {
      const p = (o.payments || [])[r.payment] || {};

      return {
        at: r.at || "",
        row: [day(r.at), o.id, "Refund", amount(-r.amount), paidWith(p),
          "", receiptOf(p)],
      };
    }),
  ]);

  rows.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));

  return csv([
    ["Date", "Order", "Kind", "Amount", "Paid with", "From", "Receipt"],
    ...rows.map((r) => r.row),
  ]);
};

// "north-foster-farm-orders-2026-09-28.csv"
export const fileName = (kind, now = new Date()) =>
  `north-foster-farm-${kind}-${now.toISOString().slice(0, 10)}.csv`;
