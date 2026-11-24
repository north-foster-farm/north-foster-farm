// What the payment section hands the card SDK, built from plain
// values (docs/refactors/pay.md, phase 1). Pure: order/pay.js makes
// the calls.

import { dollarsOf } from "./words.mjs";

// The iframe cannot see our stylesheet, so the field is told our
// colours by value (_variables.scss).
export const CARD_STYLE = {
  input: { fontSize: "16px", color: "#212529" },
  "input::placeholder": { color: "#8a8a8b" },
  ".input-container": { borderColor: "#e7e7e7", borderRadius: "6px" },
  ".input-container.is-focus": { borderColor: "#1e7b54" },
  ".input-container.is-error": { borderColor: "#dc3545" },
  ".message-text": { color: "#5e5e5f" },
  ".message-icon": { color: "#5e5e5f" },
  ".message-text.is-error": { color: "#dc3545" },
  ".message-icon.is-error": { color: "#dc3545" },
};

// The customer's details for the bank's verification, from the form's
// billing(payload). The address goes only with a street.
export const billingContact = (b) => ({
  givenName: b.firstName,
  familyName: b.lastName,
  email: b.email,
  phone: b.phone,
  countryCode: "US",
  ...(b.address1 ? {
    addressLines: [b.address1, b.address2].filter(Boolean),
    city: b.town,
    state: b.state || undefined,
    postalCode: b.zip,
  } : {}),
});

// What card.tokenize() is given: a charge of `cents`, by the customer.
export const cardRequest = (cents, billing) => ({
  amount: dollarsOf(cents),
  currencyCode: "USD",
  intent: "CHARGE",
  customerInitiated: true,
  sellerKeyedIn: false,
  billingContact: billingContact(billing),
});

// The wallets' payment request, for a total of `cents` under `label`.
export const paymentRequestOf = (cents, label) => ({
  countryCode: "US",
  currencyCode: "USD",
  total: { amount: dollarsOf(cents), label },
});
