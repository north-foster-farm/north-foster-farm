// What the payment section shows and whether it needs anything more,
// decided from plain values (docs/refactors/pay.md, phase 1). Pure:
// order/pay.js reads the SDKs and writes the DOM.

// The card's fields. Proceed to checkout asks whether all are
// complete (#706).
const CARD_FIELDS = ["cardNumber", "expirationDate", "cvv", "postalCode"];

// The section's state once the SDKs have answered: the attached card,
// or else the rendered, unlocked Venmo button, or neither.
export const endState = ({ card, venmo }) => {
  if (card) return "ready";

  return venmo ? "venmo-only" : "unavailable";
};

// Whether the form's own Pay button is hidden: it pays by card, so it
// shows when the card is chosen, or when credit covers the order.
export const submitHidden = ({ cardOpen, covered }) => !cardOpen && !covered;

// A field of the card form says how it stands (CardInputEvent:
// detail.field, detail.currentState). -> { field, valid }, or null
// when the event names no field.
export const cardFieldOf = (e) => {
  const d = (e && e.detail) || e || {};

  if (!d.field || !d.currentState) return null;

  return { field: d.field, valid: !!d.currentState.isCompletelyValid };
};

// Whether every field of the card is complete, from what cardFieldOf
// has said of each.
export const cardDone = (fields) => CARD_FIELDS.every((field) =>
  fields[field]);

// Whether the section needs nothing more (#706): nothing to charge,
// or the card chosen and every field of it complete. A wallet or
// Venmo pays in its own step, so this section still needs it.
export const sectionComplete = ({
  amount, covered, card, cardOpen, done,
}) => {
  if (covered || amount === 0) return true;
  if (!card || !cardOpen) return false;

  return !!done;
};

// Whether the row of ways to pay shows: any one of them is there.
export const walletsShown = ({ card, wallets, venmo }) => !!card
  || Object.keys(wallets).length > 0 || !!venmo;
