// The payment section's words for the customer (docs/refactors/pay.md,
// phase 1). Pure: pay/card.js, pay/wallets.js and pay/venmo.js show
// them.

import { validField } from "../../utils/field-errors.mjs";

const GENERAL = "Check your card details and try again.";

// Cents as dollars with two decimals, as the SDKs take an amount.
export const dollarsOf = (cents) => (cents / 100).toFixed(2);

// What the SDK says when a card will not tokenise, in our words.
export const tokenMessage = (result) => {
  const first = result && result.errors && result.errors[0];

  if (!first) return GENERAL;
  if (/postal|zip/i.test(first.field || "")) {
    return "Check the ZIP code and try again.";
  }
  if (/expir/i.test(first.field || first.message || "")) {
    return "Check the expiration date and try again.";
  }
  if (/cvv|security/i.test(first.field || first.message || "")) {
    return "Check the security code and try again.";
  }
  if (/cardNumber|number/i.test(first.field || "")) {
    return validField("card");
  }

  return first.message || GENERAL;
};

// Why Venmo's order was not made: the form would not prepare, with
// the stock gate shut (`locked`) or with errors of its own.
export const venmoRefusal = (locked) => (locked
  ? "Ordering isn't available right now."
  : "Check the form and try again.");
