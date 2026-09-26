// Every email the site sends, and the list emails drafted for Farm
// news, each built from realistic sample data: the catalog the staging
// toolbar's email library reads (through /api/staging/emails, a 404 in
// production) and .ignored/render-all.mjs renders for review. Nothing
// here sends mail. Add an entry when a template is added.
//
// An entry: { id, name, when, audience, tags, approval, note?, build }.
// `build(links)` returns { subject, text, html } from mailLinks(env).
// `approval` is "approved" only where James approved the wording the
// code prints today; `note` says what waits on him otherwise. What he
// approves or rewrites in the library on staging is lib/review.mjs's
// until it is ported here.

import launch from "../../../data/emails/launch-email.json" with {
  type: "json",
};
import * as t from "./templates.mjs";
import { orderPathFor } from "./site.mjs";

// --- Sample records -------------------------------------------------

const ID = "NFF-2610-K3WM";

const card = {
  amount: 9400, via: "square", method: "card", brand: "VISA", last4: "4242",
  at: "2026-10-06T13:00:00.000Z",
};

export const order = (over = {}) => ({
  id: ID,
  status: "paid",
  submittedAt: "2026-10-06T13:00:00.000Z",
  customer: {
    firstName: "Dana", lastName: "Whitcomb", name: "Dana Whitcomb",
    email: "dana@example.com", phone: "401-555-0142", contact: "text",
  },
  lines: [
    { sku: "A", label: "Whole Chicken, 3.5 – 3.9 lbs", qty: 3, lineTotal: 90 },
    { sku: "B", label: "Eggs (per dozen), Large", qty: 2, lineTotal: 14 },
  ],
  totals: {
    subtotal: 10400, discountTier: 100, discountAmount: 1000,
    discountLabel: "Bulk discount ($100+)", deliveryFee: 0, total: 9400,
  },
  notes: "Please leave the eggs on top.",
  fulfilment: {
    method: "delivery",
    date: "2026-10-08",
    onfarm: null,
    delivery: {
      address1: "84 Foster Center Rd", address2: "", town: "Foster",
      state: "RI", zip: "02825", cooler: "Green cooler by the garage",
      gate: "", notes: "Dog is friendly", zipStatus: "approved",
    },
  },
  payments: [card],
  square: { squareOrderId: "SO-1" },
  ...over,
});

const onfarm = (state, extra = {}) => ({
  method: "onfarm", date: "2026-10-08", state,
  onfarm: { window: "morning", phone: "401-555-0142", ...extra },
  delivery: null,
});

// An on-farm pickup the farm has agreed to, 9 to 11.
export const pickup = (over = {}) => order({
  fulfilment: onfarm("agreed", { confirmed: { from: 9, to: 11 } }),
  payments: [{ ...card, method: "applepay", brand: null, last4: null }],
  ...over,
});

// An on-farm window the farm has not agreed to yet.
export const requested = (over = {}) => order({
  fulfilment: onfarm("requested"),
  payments: [{ ...card, method: "applepay", brand: null, last4: null }],
  ...over,
});

export const dropSite = (over = {}) => order({
  fulfilment: { method: "scituate", date: "2026-10-17", onfarm: null,
    delivery: null },
  payments: [{ amount: 9400, via: "venmo", at: "2026-10-06T13:00:00.000Z" }],
  ...over,
});

export const customer = {
  firstName: "Dana", name: "Dana Whitcomb", email: "dana@example.com",
  phone: "401-555-0142",
  address: {
    address1: "12 Plain Meeting House Rd", town: "West Greenwich",
    state: "RI", zip: "02817", status: "pending",
  },
};

// Another customer, for the farm's lists.
const other = (firstName, lastName) => ({
  firstName, lastName, name: `${firstName} ${lastName}`,
  email: `${firstName.toLowerCase()}@example.com`, phone: "401-555-0199",
  contact: "call",
});

// The order after Dana added a dozen eggs (paid more) or dropped one
// chicken (refunded).
const added = order({
  lines: [
    { sku: "A", label: "Whole Chicken, 3.5 – 3.9 lbs", qty: 3, lineTotal: 90 },
    { sku: "B", label: "Eggs (per dozen), Large", qty: 3, lineTotal: 21 },
  ],
  totals: {
    subtotal: 11100, discountTier: 100, discountAmount: 1000,
    discountLabel: "Bulk discount ($100+)", deliveryFee: 0, total: 10100,
  },
  payments: [card, { ...card, amount: 700, at: "2026-10-07T01:10:00Z" }],
});
const dropped = order({
  lines: [
    { sku: "A", label: "Whole Chicken, 3.5 – 3.9 lbs", qty: 2, lineTotal: 60 },
    { sku: "B", label: "Eggs (per dozen), Large", qty: 2, lineTotal: 14 },
  ],
  totals: {
    subtotal: 7400, discountTier: 50, discountAmount: 500,
    discountLabel: "Bulk discount ($50+)", deliveryFee: 0, total: 6900,
  },
});
// The edit's record of the order as it was, before either change.
const before = () => ({
  lines: order().lines, totals: order().totals, method: "delivery",
});

// The sample values above that no pattern in lib/review.mjs catches
// (names, items, notes, messages), so a rewrite keeps them as tokens.
export const SAMPLE_TEXT = [
  "Dana Whitcomb", "Dana", "Sam Okafor", "Lee Marchetti",
  "Whole Chicken, 3.5 – 3.9 lbs", "Eggs (per dozen), Large",
  "Green cooler by the garage", "Dog is friendly",
  "Please leave the eggs on top.", "On the front porch",
  "morning", "afternoon", "Village Green",
  "Could I switch Thursday's delivery to the following week? " +
    "We'll be away.",
  "Two of the eggs were cracked.", "The rest were fine.",
  "Eggs", "r7Kq2m", "Square 400", "Item not available at location",
  "order.create_failed", "Apple Pay",
];

const orderUrl = (links) => `${links.site}${orderPathFor(ID)}`;
const settingsUrl = (links) => `${links.site}/account/#settings`;
const signIn = (links) => `${links.site}/api/auth/verify?token=abc123`;
const squareUrl = "https://app.squareup.com/dashboard/orders/overview/SO-1";

// --- Farm news drafts -----------------------------------------------
//
// List emails go out by hand from Fastmail, as plain text. The drafts
// are the email lane's (north-foster-farm/.ignored/email-updates/);
// a body comes here, into data/emails/, once James agrees to publish
// it in the repository.

const plain = (subject, text) => {
  const escape = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");

  return {
    subject,
    text,
    html: `<!doctype html><html><head><meta charset="utf-8">` +
      `<meta name="viewport" content="width=device-width">` +
      `<title>${escape(subject)}</title></head><body style="margin:0">` +
      `<pre style="margin:0 auto;max-width:640px;padding:24px 16px;` +
      `font:15px/1.6 system-ui,sans-serif;white-space:pre-wrap">` +
      `${escape(text)}</pre></body></html>`,
  };
};


// --- The catalog ----------------------------------------------------

const C = "customer";
const F = "farm";

export const library = [
  // To the customer
  {
    id: "order-confirmed-delivery", name: "Order confirmed, delivery",
    when: "The moment a delivery order is paid", audience: C,
    tags: ["paid", "placed", "delivery", "card"],
    build: (links) => t.orderConfirmed(order(),
      { orderUrl: orderUrl(links), links }),
  },
  {
    id: "order-confirmed-dropsite", name: "Order confirmed, drop site",
    when: "The moment a drop-site order is paid", audience: C,
    tags: ["paid", "placed", "drop site", "venmo"],
    build: (links) => t.orderConfirmed(dropSite(),
      { orderUrl: orderUrl(links), links }),
  },
  {
    id: "order-confirmed-onfarm", name: "Order confirmed, on-farm pickup",
    when: "Once an on-farm order is both paid and agreed", audience: C,
    tags: ["paid", "pickup confirmed", "pickup", "wallet"],
    build: (links) => t.orderConfirmed(pickup(),
      { orderUrl: orderUrl(links), links }),
  },
  {
    id: "payment-received", name: "Payment received, pickup to confirm",
    when: "An on-farm order paid before the farm agreed to the window",
    audience: C, tags: ["paid", "placed", "pickup", "wallet"],
    build: (links) => t.paymentReceived(requested(),
      { orderUrl: orderUrl(links), links }),
  },
  {
    id: "pick-new-time", name: "Pick a new pickup time",
    when: "The farm denied the window", audience: C,
    tags: ["pickup denied", "pickup"],
    build: (links) => t.pickNewTime(requested(), {
      pickUrl: signIn(links), links,
    }),
  },
  {
    id: "delivery-reminder", name: "Delivery tomorrow",
    when: "Wednesday evening, for each paid delivery", audience: C,
    tags: ["reminder", "delivery"],
    build: (links) => t.deliveryReminder(order(), {
      orderUrl: orderUrl(links), settingsUrl: settingsUrl(links), links,
    }),
  },
  {
    id: "order-changed", name: "Order updated, details",
    when: "The customer changed the date or the instructions",
    audience: C, tags: ["updated", "delivery"],
    build: (links) => t.orderChanged(order(),
      { orderUrl: orderUrl(links), links }),
  },
  {
    id: "order-changed-paid-more", name: "Order updated, paid more",
    when: "The customer added items and paid the difference",
    audience: C, tags: ["updated", "paid", "delivery", "card"],
    build: (links) => t.orderChanged(added, {
      orderUrl: orderUrl(links), links, difference: 700, before: before(),
    }),
  },
  {
    id: "order-changed-refunded", name: "Order updated, refunded",
    when: "The customer removed items and was refunded the difference",
    audience: C, tags: ["updated", "refunded", "delivery"],
    build: (links) => t.orderChanged(dropped, {
      orderUrl: orderUrl(links), links, difference: -2500, before: before(),
    }),
  },
  {
    id: "order-cancelled", name: "Order cancelled, nothing charged",
    when: "The farm cancelled an order without a refund", audience: C,
    tags: ["cancelled"],
    build: (links) => t.orderCancelled(order({ status: "cancelled" }),
      { links }),
  },
  {
    id: "order-cancelled-refund", name: "Order cancelled and refunded",
    when: "A paid order cancelled by the customer or the farm",
    audience: C, tags: ["cancelled", "refunded"],
    build: (links) => t.orderCancelled(order({ status: "cancelled" }),
      { refund: true, links }),
  },
  {
    id: "address-approved", name: "We can deliver to your address",
    when: "The farm approved an address outside the area", audience: C,
    tags: ["address", "delivery"],
    build: (links) => t.addressDecision(customer, "approved", { links }),
  },
  {
    id: "address-denied", name: "We can't deliver to your address",
    when: "The farm denied an address outside the area", audience: C,
    tags: ["address", "delivery"],
    build: (links) => t.addressDecision(customer, "denied", { links }),
  },
  {
    id: "sign-in-link", name: "Sign-in link",
    when: "A customer asks to sign in", audience: C,
    tags: ["sign-in", "account"],
    build: (links) => t.magicLink(customer.email,
      `${links.site}/account/?token=abc123`, { links }),
  },
  {
    id: "news-confirm", name: "Confirm Farm news",
    when: "Someone signs up for Farm news on the site",
    audience: C, tags: ["list", "sign-up"],
    build: (links) => t.newsConfirm(customer.email,
      `${links.site}/api/news/confirm?token=abc123`, { links }),
  },
  {
    id: "news-invite", name: "Farm news invitation",
    when: "The old list is invited to opt in again",
    audience: C, tags: ["list", "sign-up", "launch"],
    build: (links) => t.newsConfirm(customer.email,
      `${links.site}/api/news/confirm?token=abc123`,
      { invited: true, links }),
  },

  // To the farm
  {
    id: "farm-order-placed-delivery", name: "New order, delivery",
    when: "The moment a delivery order is placed and paid", audience: F,
    tags: ["placed", "paid", "delivery", "card"],
    build: (links) => t.farmOrderPlaced(order(), { squareUrl, links }),
  },
  {
    id: "farm-order-placed-onfarm", name: "New order, on-farm pickup",
    when: "An on-farm order is placed, with the confirm and deny commands",
    audience: F, tags: ["placed", "paid", "pickup", "wallet"],
    build: (links) => t.farmOrderPlaced(requested(), { squareUrl, links }),
  },
  {
    id: "farm-order-placed-dropsite", name: "New order, drop site",
    when: "A drop-site order is placed and paid by Venmo", audience: F,
    tags: ["placed", "paid", "drop site", "venmo"],
    build: (links) => t.farmOrderPlaced(dropSite(), { links }),
  },
  {
    id: "farm-order-changed", name: "Order changed",
    when: "A customer changed a paid order's items", audience: F,
    tags: ["updated", "paid", "delivery", "card"],
    build: (links) => t.farmOrderChanged(added, {
      before: before(), difference: 700, links,
    }),
  },
  {
    id: "farm-pickup-changed", name: "Pickup time to confirm",
    when: "A customer moved an on-farm pickup", audience: F,
    tags: ["updated", "pickup"],
    build: (links) => t.farmPickupChanged(requested(), { links }),
  },
  {
    id: "farm-contact-message", name: "Message from the website",
    when: "Someone writes on the contact page", audience: F,
    tags: ["contact"],
    build: (links) => t.farmContactMessage({
      name: "Dana Whitcomb", email: customer.email, orderId: ID,
      message: "Could I switch Thursday's delivery to the following " +
        "week? We'll be away.\n\nThanks, Dana",
    }, { order: true, links }),
  },
  {
    id: "farm-support", name: "Support message from an account",
    when: "A signed-in customer writes from the account page",
    audience: F, tags: ["support", "account"],
    build: (links) => t.farmSupport(customer, {
      subject: "Eggs", orderId: ID,
      message: "Two of the eggs were cracked.\nThe rest were fine.",
    }, { links }),
  },
  {
    id: "farm-address-review", name: "Address to review",
    when: "A customer saves an address outside the area", audience: F,
    tags: ["address", "delivery"],
    build: (links) => t.addressReview(customer, { links }),
  },
  {
    id: "farm-refund-needed", name: "Refund needed",
    when: "A customer cancels a paid order", audience: F,
    tags: ["cancelled", "refunded", "account"],
    build: (links) => t.farmRefundNeeded(order(), customer, { links }),
  },
  {
    id: "farm-return-request", name: "Return request",
    when: "A customer asks about a return", audience: F,
    tags: ["support", "account", "refunded"],
    build: (links) => t.farmReturnRequest(order(), customer, {
      id: "r7Kq2m", reason: "Two of the eggs were cracked.", skus: ["B"],
    }, { links }),
  },
  {
    id: "farm-square-out-of-sync", name: "Square out of sync",
    when: "A customer's change could not be written to Square",
    audience: F, tags: ["alert", "updated"],
    build: (links) => t.farmSquareOutOfSync(order(), customer, { links }),
  },
  {
    id: "farm-alert", name: "Site alert",
    when: "A failure on the order path, once an hour per kind",
    audience: F, tags: ["alert"],
    build: (links) => t.farmAlert("order.create_failed", {
      id: ID, retryable: false, error: "Square 400",
      detail: "Item not available at location",
    }, { at: new Date("2026-10-06T13:05:00Z"), links }),
  },
  {
    id: "farm-morning-report", name: "Morning report",
    when: "Every day at 8:00", audience: F, tags: ["report", "pickup"],
    build: (links) => t.farmMorningReport({
      placed: 4, paidByCard: 3, paidByVenmo: 1, declined: 0, cancelled: 0,
      refunded: 0, open: 6, mailFailures: 0, runs: 96, jobErrors: 0,
      invariants: 0,
    }, [requested()], {
      date: "2026-10-07", links, now: new Date("2026-10-07T12:00:00Z"),
    }),
  },
  {
    id: "farm-tomorrow", name: "Tomorrow's orders",
    when: "Every day at 18:00", audience: F,
    tags: ["report", "delivery", "pickup", "drop site"],
    build: (links) => t.farmTomorrow([
      order(),
      pickup({ id: "NFF-2610-PQ7R", customer: other("Sam", "Okafor") }),
      order({
        id: "NFF-2610-ZX4T", customer: other("Lee", "Marchetti"),
        fulfilment: {
          ...order().fulfilment,
          delivery: {
            address1: "310 Danielson Pike", town: "Scituate", state: "RI",
            zip: "02857", cooler: "On the front porch", gate: "4471",
            notes: "",
          },
        },
        notes: "",
      }),
    ], { date: "2026-10-08", links }),
  },

  // Farm news
  {
    id: "news-launch-email", name: "Farm news: we're online",
    when: "Sent by James from Fastmail at launch, to the old list",
    audience: "list", tags: ["list", "farm news", "launch", "draft"],
    build: () => plain(launch.subject,
      `Preview text: ${launch.preview}\n\n---\n\n${launch.body}`),
  },
];

// What James has approved, with its evidence; everything else is "to
// approve", with what he has not seen. From an audit of his review
// replies of 2026-09-22, the render notes, the commits since and the
// liaison\x27s queue, on 2026-09-26, then his review in the library on
// staging the same day. Unclear counts as to approve.
const LIBRARY = "James approved in the library on 2026-09-26.";
const APPROVED = {
  "order-confirmed-delivery": "James\x27s rewrite of 2026-09-22, verbatim.",
  "order-confirmed-dropsite": LIBRARY,
  "order-confirmed-onfarm": LIBRARY,
  "payment-received": LIBRARY,
  "delivery-reminder": "James\x27s rewrite of 2026-09-22. Not yet seen: " +
    "the gate or door code line, shown only when one is given.",
  "order-changed": "James\x27s rewrite of 2026-09-22, and his opening " +
    "line of 2026-09-26. Not yet seen: the gate or door code line, " +
    "shown only when one is given.",
  "order-cancelled-refund": "James\x27s rewrite of 2026-09-22, for a " +
    "delivery. Not yet seen: the drop-site and on-farm wording.",
  "address-approved": "James\x27s rewrite of 2026-09-22, verbatim.",
  "sign-in-link": "James\x27s rewrite of 2026-09-22, verbatim.",
  "farm-order-placed-delivery": LIBRARY,
  "farm-order-placed-dropsite": LIBRARY,
  "farm-order-changed": LIBRARY,
  "farm-contact-message": LIBRARY,
  "farm-address-review": LIBRARY,
  "farm-alert": LIBRARY,
  "farm-tomorrow": LIBRARY,
};

// Rewrites of 2026-09-26 that have landed come back here to approve,
// showing the landed text.
const LANDED = "His rewrite of 2026-09-26, landed";
const CARD = "Moved onto the farm card on 2026-09-26, after he asked " +
  "\"No template?\"; agent-written.";
const WAITING = {
  "pick-new-time": `${LANDED}, with the pickup window as a token. ` +
    "The farm\x27s reason is no longer sent.",
  "order-changed-paid-more": `${LANDED}: each line says what was added ` +
    "or removed, and the Total line what was paid.",
  "order-changed-refunded": `${LANDED}, as for paid more. Agent-written: ` +
    "\"Your refund can take a few days to reach you.\"",
  "order-cancelled": "His rewrite, \"Nothing was charged\", is held: " +
    "every order is paid when placed, so a customer cancelled without " +
    "a refund was charged.",
  "address-denied": `${LANDED}, verbatim.`,
  "farm-order-placed-onfarm": "He approved it on 2026-09-26; since then " +
    "the second confirm example is the whole window (#159) and deny " +
    "takes no reason.",
  "farm-pickup-changed": "He approved it on 2026-09-26; since then the " +
    "confirm and deny lines changed, as in New order, on-farm pickup.",
  "farm-support": CARD,
  "farm-refund-needed": CARD,
  "farm-return-request": CARD,
  "farm-square-out-of-sync": CARD,
  "farm-morning-report": `${LANDED}: the key under the table, and 🙈 ` +
    "for outside limits.",
  "news-confirm": "His dictation of 2026-09-24, ending on his line " +
    "for site sign-ups (Q20, 2026-09-26). Open: \"farm news\" or \"news " +
    "and updates\" (W14).",
  "news-invite": "The sign-up confirmation, ending on his line for " +
    "the old list (W19, 2026-09-26) in place of \"If you didn\x27t " +
    "request this email, you can safely ignore it.\" Open: \"farm " +
    "news\" or \"news and updates\" (W14).",
  "news-launch-email": "Subject and preview text are his (2026-09-26). " +
    "The whole body is the email lane\x27s draft and waits on him (W18), " +
    "with \"much of Rhode Island\" (Q5). Draft: \"In the next few days " +
    "you\x27ll get one more email from us\", since the invitations go out " +
    "over several mornings (F6).",
};

for (const e of library) {
  e.approval = APPROVED[e.id] ? "approved" : "to approve";
  e.note = APPROVED[e.id] || WAITING[e.id] || null;
}

export const entry = (id) => library.find((e) => e.id === id) || null;
