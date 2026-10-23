// Every email template, given hostile text in every field a customer
// (or a stranger writing to the contact form) can type: the HTML that
// comes out must hold the text as text, never as markup, and no header
// may reach a driver with a line break (#267, code analysis). A guard
// fails the suite when a template is added without a case here.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  OUTBOX_PREFIX, sendMail,
} from "../netlify/functions/lib/mail.mjs";
import { testStores } from "../netlify/functions/lib/store.mjs";
import * as templates from "../netlify/functions/lib/templates.mjs";

// A tag, an attribute break-out, a script URL and a header injection,
// each carrying a marker no real email contains.
const TAG = "<zz-hostile onerror=zzfire(1)>";
const HOSTILE = `${TAG}"zzattr=1 javascript:zzfire(1)\r\nBcc: zz@evil.test`;

const links = {
  orders: "https://x/account/",
  contact: null,
  admin: "https://admin.example.com",
  order: "https://x/order/",
};
const url = "https://x/account/orders/NFF-1/";
const at = new Date("2026-10-18T12:00:00Z");

const customer = (extra = {}) => ({
  name: HOSTILE, firstName: HOSTILE, lastName: HOSTILE,
  email: `${HOSTILE}@example.com`, phone: HOSTILE, contact: "text",
  address: {
    address1: HOSTILE, address2: HOSTILE, town: HOSTILE, state: HOSTILE,
    zip: HOSTILE,
  },
  ...extra,
});

const order = (method = "delivery") => ({
  id: "NFF-1",
  status: "paid",
  submittedAt: "2026-10-06T13:00:00Z",
  paidAt: "2026-10-06T13:00:00Z",
  notes: HOSTILE,
  customer: customer(),
  lines: [{ sku: "B", label: "Eggs (per dozen), Large", qty: 1, lineTotal: 7 }],
  totals: {
    subtotal: 700, discountAmount: 0, deliveryFee: 0, total: 700,
  },
  fulfilment: {
    method,
    date: "2026-10-08",
    onfarm: method === "onfarm"
      ? { window: "09:00-12:00", from: "09:00", to: "12:00" } : null,
    delivery: method === "delivery" ? {
      address1: HOSTILE, address2: HOSTILE, town: HOSTILE, state: HOSTILE,
      zip: HOSTILE, cooler: HOSTILE, gate: HOSTILE, notes: HOSTILE,
    } : null,
  },
  square: { squareOrderId: "SQO", customerId: "CUST" },
  payment: {
    via: "square", method: "card", at: "2026-10-06T13:00:00Z",
    squarePaymentId: "PAY-1", receiptUrl: "https://sq/receipt",
    brand: "VISA", last4: "4242",
  },
});

// How each template is called. `shows` is true when the case puts the
// hostile text where the template prints it, so the test can insist the
// text arrived (escaped) rather than pass by never being used.
const stats = {
  placed: 1, paidByCard: 1, paidByVenmo: 0, declined: 0, cancelled: 0,
  refunded: 0, open: 1, mailFailures: 0, runs: 1, jobErrors: 0,
  invariants: 0,
};
const asked = () => ({
  ...order("onfarm"),
  question: { kind: "window", openedAt: "2026-10-05T12:00:00Z",
    answeredAt: null },
});

const CASES = {
  orderConfirmed: [() => templates.orderConfirmed(order(), { links }), true],
  deliveryReminder: [() => templates.deliveryReminder(order(),
    { orderUrl: url, settingsUrl: url, links }), true],
  quietNotice: [() => templates.quietNotice(customer(),
    { accountUrl: url, links, wasSubscribed: true }), true],
  orderChanged: [() => templates.orderChanged(order(), {
    links, difference: 700,
    before: {
      lines: order().lines, totals: order().totals, method: "delivery",
    },
  }), true],
  missedDelivery: [() => templates.missedDelivery(order(),
    { pickUrl: url, links }), true],
  movedDelivery: [() => templates.movedDelivery(order(),
    { pickUrl: url, links }), true],
  orderCancelled: [() => templates.orderCancelled(order(), {
    by: "farm", refunded: 700, reasonText: HOSTILE, links,
  }), true],
  addressDecision: [() => templates.addressDecision(customer(), "approved",
    { links }), true],
  magicLink: [() => templates.magicLink(`${HOSTILE}@example.com`, url,
    { links }), false],
  emailChangeLink: [() => templates.emailChangeLink(
    `${HOSTILE}@example.com`, url, { links }), false],
  emailChanged: [() => templates.emailChanged(`${HOSTILE}@example.com`,
    `${HOSTILE}2@example.com`, { links }), true],
  newsConfirm: [() => templates.newsConfirm(`${HOSTILE}@example.com`, url,
    { links }), false],
  newsWelcome: [() => templates.newsWelcome({
    firstName: HOSTILE, marketing: true, marketingAt: at,
    consent: [{ action: "in", type: "market-sheet", detail: HOSTILE, at,
      recordedAt: at }],
  }, url, { links }), true],
  listMail: [() => templates.listMail(HOSTILE, {
    preview: HOSTILE, hero: { src: url, alt: HOSTILE },
    blocks: [
      templates.listBlocks.p(HOSTILE), templates.listBlocks.heading(HOSTILE),
      templates.listBlocks.image(url, HOSTILE, HOSTILE),
      templates.listBlocks.button(HOSTILE, url),
      templates.listBlocks.linked(HOSTILE, HOSTILE, url, HOSTILE),
    ],
    reason: HOSTILE, unsubscribeUrl: url, links,
  }), true],
  addressReview: [() => templates.addressReview(customer(), { links }), true],
  farmOrderPlaced: [() => templates.farmOrderPlaced(order(),
    { squareUrl: url, links }), true],
  farmOrderChanged: [() => templates.farmOrderChanged(order(), {
    links, difference: 700,
    before: {
      lines: order().lines, totals: order().totals, method: "delivery",
    },
  }), false],
  farmSquareChanged: [() => templates.farmSquareChanged(order(), {
    links, changes: [HOSTILE], printed: true, squareUrl: url,
  }), true],
  farmPickupChanged: [() => templates.farmPickupChanged(order("onfarm"),
    { links }), true],
  farmContactMessage: [() => templates.farmContactMessage({
    name: HOSTILE, email: `${HOSTILE}@example.com`, phone: HOSTILE,
    message: HOSTILE, subject: HOSTILE, orderId: HOSTILE,
  }, { order: order(), links }), true],
  farmRefundNeeded: [() => templates.farmRefundNeeded(order(), customer(),
    { links }), true],
  farmOrderCancelled: [() => templates.farmOrderCancelled(order(),
    customer(), { links }), true],
  farmSquareOutOfSync: [() => templates.farmSquareOutOfSync(order(),
    customer(), { links }), true],
  farmReturnRequest: [() => templates.farmReturnRequest(order(), customer(),
    { id: "r1", reason: HOSTILE, skus: [HOSTILE] }, { links }), true],
  farmSupport: [() => templates.farmSupport(customer(), {
    subject: HOSTILE, message: HOSTILE, orderId: HOSTILE,
  }, { links }), true],
  farmAlert: [() => templates.farmAlert("order.create_failed", {
    id: HOSTILE, error: HOSTILE, email: HOSTILE,
  }, { at, links }), true],
  escalation: [() => templates.escalation({
    at, links, maintenanceOn: "https://x/maintenance/on?sig=abc",
  }), false],
  maintenanceFlipped: [() => templates.maintenanceFlipped(true, {
    by: HOSTILE, at, links, context: HOSTILE,
  }), true],
  sessionsEnded: [() => templates.sessionsEnded({
    count: 1, by: HOSTILE, at, context: HOSTILE,
  }), true],
  devMailTest: [() => templates.devMailTest({ at, context: HOSTILE }), true],
  rotationReminder: [() => templates.rotationReminder({
    due: [{ name: HOSTILE, environment: HOSTILE, date: HOSTILE,
      reason: HOSTILE }],
    start: "2026-12-01", links,
  }), true],
  farmMorningReport: [() => templates.farmMorningReport(stats, [asked()], {
    date: "2026-10-06", links, now: at,
    messages: [{
      id: HOSTILE, at: "2026-10-05T12:00:00Z", name: HOSTILE, email: HOSTILE,
      orderId: HOSTILE, order: false,
    }],
  }), true],
  farmArchivedInStock: [() => templates.farmArchivedInStock(
    [{ sku: HOSTILE, name: HOSTILE, count: 3 }], { links }), true],
  farmTomorrow: [() => templates.farmTomorrow(
    [order(), order("onfarm")], { date: "2026-10-08", links }), true],
  farmPackingSlips: [() => templates.farmPackingSlips([
    { order: order(), kind: "new", changes: [] },
    { order: order("onfarm"), kind: "changed", changes: [HOSTILE] },
  ], {
    day: "2026-10-08", slips: 2, revised: 1, filename: "p.pdf", links,
  }), true],
  farmChangedAfterPrint: [() => templates.farmChangedAfterPrint(
    { order: order(), kind: "changed", changes: [HOSTILE] },
    { date: "2026-10-08", links }), true],
};

// Helpers that return a phrase or a table, not a message.
const NOT_MESSAGES = [
  "CANCEL_REASONS", "age", "listBlocks", "optInPhrase", "paymentPhrase",
  "summaryLine",
];

const messagesOf = (result) => (Array.isArray(result) ? result : [result]);

const hrefs = (html) => [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);

describe("every email template", () => {
  it("has a hostile-input case here", () => {
    const exported = Object.keys(templates)
      .filter((name) => !NOT_MESSAGES.includes(name));

    assert.deepEqual(exported.sort(), Object.keys(CASES).sort(),
      "a template was added or removed without updating this suite");
  });

  for (const [name, [make, shows]] of Object.entries(CASES)) {
    describe(name, () => {
      it("holds typed text as text, with no live markup or link", () => {
        for (const message of messagesOf(make())) {
          const { html } = message;

          assert.equal(typeof html, "string");
          assert.ok(!html.includes("<zz-"), "an injected element");
          assert.ok(!html.includes("\"zzattr"), "an attribute break-out");

          for (const href of hrefs(html)) {
            assert.match(href, /^(https?:\/\/|mailto:|tel:|#)/,
              "a link that is not web, mail or phone");
          }

        }
      });

      if (shows) {
        it("prints the text, escaped, where it belongs", () => {
          const all = messagesOf(make()).map((m) => m.html).join("\n");

          assert.ok(all.includes("&lt;zz-hostile"),
            "the case never reached the output");
        });
      }
    });
  }
});

describe("a message sent with a line break in a header field", () => {
  it("reaches the driver on one line, for every template", async () => {
    for (const [name, [make]] of Object.entries(CASES)) {
      for (const message of messagesOf(make())) {
        const stores = testStores();
        const sent = await sendMail({
          ...message,
          to: `a@example.com${HOSTILE}`,
          replyTo: `b@example.com${HOSTILE}`,
        }, { env: { MAIL_DRIVER: "outbox" }, stores });
        const kept = await stores.jobs.get(`${OUTBOX_PREFIX}${sent.id}`);

        for (const field of [kept.subject, kept.replyTo, kept.to]) {
          assert.doesNotMatch(String(field), /[\r\n]/, `${name}: a header`);
        }
      }
    }
  });
});
