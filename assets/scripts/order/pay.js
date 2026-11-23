// The payment section: the card form and the wallet buttons from
// Square's Web Payments SDK, and the Venmo button from PayPal's. The
// SDKs load once the section is near the screen (pay/loader.js), from
// the hosts the content-security policy allows, with the ids
// /api/checkout/config gives for this deploy. Nothing here talks to
// our server about the order: it turns a card or a wallet into a token
// and hands it to the form, or runs the Venmo approval and hands the
// form the PayPal order to capture. The form validates first, every
// time.
//
// What the form gives:
//   prepare()            validate now; -> the payload, or null after
//                        showing the errors (synchronous: Apple Pay
//                        must tokenise inside the click)
//   prepareAsync()       the same plus a stock check, for buttons that
//                        can wait
//   amount()             the total in cents, for the wallets' sheets
//   billing()            the customer's details for card verification
//   pay(payload, source) send { method, sourceId }
//   venmoCreate(payload) -> the PayPal order id from our server, or
//                        null when the order turned out paid already
//   venmoCapture(payload, paypalOrderId)

import { Card } from "./pay/card.js";
import { Loader } from "./pay/loader.js";
import { loadScript } from "./pay/scripts.js";
import { Section } from "./pay/section.js";
import { Venmo } from "./pay/venmo.js";
import { Wallets } from "./pay/wallets.js";
import { crumb, reportUnavailable, sdk } from "./report.js";

// The form, narrowed to what the parts may ask of it (docs/refactors/
// pay.md, section 2), from the eleven members it gives. No part sees
// the form itself.
const checkoutOf = (form) => ({
  amount: () => form.amount(),
  label: () => form.contact.name,
  prepare: () => form.prepare(),
  prepareAsync: () => form.prepareAsync(),
  pay: (payload, source) => form.pay(payload, source),
  billing: (payload) => form.billing(payload),
  referenceId: () => form.referenceId(),
  venmoCreate: (payload) => form.venmoCreate(payload),
  venmoCapture: (...args) => form.venmoCapture(...args),
  stockLocked: () => form.stock.locked,
  ready: () => form.paymentReady(),
});

export class Payment {
  constructor(root, form) {
    this.root = root;
    this.form = form;
    this.checkout = checkoutOf(form);
    this.payments = null;
    // The section's DOM state, its error line and its two flags
    // (pay/section.js). The form reads `state`.
    this.section = new Section(root);
    this.state = this.section.state;
    const parts = { root, section: this.section, checkout: this.checkout };
    // The card form, its fields' states and its token (pay/card.js).
    this.cardPart = new Card(parts);
    // The payment request and the three wallets (pay/wallets.js).
    this.walletsPart = new Wallets(parts);
    // PayPal's Venmo button, its payload and flags (pay/venmo.js).
    this.venmoPart = new Venmo(parts);
    // When the SDKs load, the config and the state the section ends
    // in (pay/loader.js), from what Square's half and PayPal's attach.
    this.loader = new Loader({
      ...parts,
      square: (cfg) => this.initSquare(cfg).then(() => this.card),
      paypal: (cfg) => this.initVenmo(cfg).then(() => this.venmo),
    });
  }

  // The unlocked Venmo button, or null.
  get venmo() {
    return this.venmoPart.button;
  }

  // The attached card, or null.
  get card() {
    return this.cardPart.card;
  }

  // The wallets this browser offers, by method.
  get wallets() {
    return this.walletsPart.wallets;
  }

  get busy() {
    return this.section.busy;
  }

  get covered() {
    return this.section.covered;
  }

  setCardAvailable(on) {
    this.section.setCardAvailable(on);
  }

  setCardOpen(open) {
    this.section.setCardOpen(open);
  }

  setCovered(on) {
    this.section.setCovered(on);
  }

  // Loads once the section is near the screen, or the first time
  // anything inside it is focused (pay/loader.js).
  start() {
    this.loader.start();
  }

  // Whether the section took its end state with a way to pay
  // (pay/loader.js). The form reads it.
  get ready() {
    return this.loader.ready;
  }

  // --- Square -------------------------------------------------------

  async initSquare(cfg) {
    sdk("square", "loading");
    try {
      await loadScript(cfg.sdkUrl);
      this.payments = window.Square.payments(cfg.applicationId, cfg.locationId);
    } catch (error) {
      console.error(error);
      sdk("square", "failed");
      crumb("square.load_failed");
      reportUnavailable("square.load", error);

      return;
    }
    sdk("square", "ready");
    crumb("square.ready");

    await this.cardPart.attach(this.payments);
    await this.walletsPart.attach(this.payments);
    this.showWallets();
  }

  // Whether the section needs nothing more (pay/card.js).
  complete() {
    return this.cardPart.complete();
  }

  showWallets() {
    this.section.showWallets({
      card: this.card, wallets: this.wallets, venmo: this.venmo,
    });
  }

  // The card form's token (pay/card.js). -> { method, sourceId };
  // throws with a message for the customer.
  tokenizeCard(payload) {
    return this.cardPart.tokenize(payload);
  }

  // The total changed: the wallets' sheets must show the new one
  // (pay/wallets.js).
  setAmount(cents) {
    this.walletsPart.setAmount(cents);
  }

  // --- Venmo --------------------------------------------------------

  // PayPal's Venmo button and its six callbacks (pay/venmo.js). A
  // rendered button shows the wallets again.
  async initVenmo(cfg) {
    if (await this.venmoPart.attach(cfg)) this.showWallets();
  }

  // --- Errors and state ---------------------------------------------

  fail(message) {
    this.section.fail(message);
  }

  clearError() {
    this.section.clearError();
  }

  setBusy(busy) {
    this.section.setBusy(busy);
  }
}
