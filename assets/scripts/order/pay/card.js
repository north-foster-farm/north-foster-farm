// The card (docs/refactors/pay.md, phase 3): Square's card form,
// attached to [data-card], the word each of its fields sends, whether
// the section needs nothing more, and the card's token. It holds the
// card and its fields' states; the section's DOM is pay/section.js's,
// and what it asks of the form comes through the `checkout` port that
// order/pay.js builds.

import { CARD_STYLE, cardRequest } from "./requests.mjs";
import { cardDone, cardFieldOf, sectionComplete } from "./states.mjs";
import { tokenMessage } from "./words.mjs";
import { crumb, reportError } from "../report.js";

const qs = (root, selector) => root.querySelector(selector);

// The events in which Square's card form says how each of the card's
// fields stands (pay/states.mjs, cardFieldOf).
const CARD_EVENTS = [
  "focusClassRemoved", "errorClassAdded", "errorClassRemoved",
  "cardBrandChanged", "postalCodeChanged",
];

// Square's frame sends a field's state a moment after the focus leaves
// it, so a press that took the focus from the last field waits this
// long for its word.
const CARD_SETTLE_MS = 200;

export class Card {
  constructor({ root, section, checkout }) {
    this.root = root;
    this.section = section;
    this.checkout = checkout;
    this.card = null;
    // Which of the card's fields Square calls complete (cardDone).
    this.fields = {};
  }

  // Square's card from `payments` (what Square.payments() gave),
  // attached and wired. A card that fails is reported and set aside,
  // and the section goes on without it.
  async attach(payments) {
    try {
      this.card = await payments.card({ style: CARD_STYLE });
      await this.card.attach(qs(this.root, "[data-card]"));
      // A stand-in with no events (a spec's) leaves every field unknown.
      for (const type of CARD_EVENTS) {
        this.card.addEventListener?.(type, (e) => this.input(e));
      }
      crumb("card.ready");
      this.section.setCardAvailable(true);
      qs(this.root, "[data-card-choose]").addEventListener("click", () => {
        this.section.setCardOpen(true);
        this.card.focus("cardNumber").catch(() => {});
      });
    } catch (error) {
      console.error(error);
      crumb("card.attach_failed");
      reportError("card.attach", error);
      this.card = null;
      this.section.setCardAvailable(false);
    }
  }

  // A field of the card form says how it stands.
  input(e) {
    const said = cardFieldOf(e);

    if (said) this.fields[said.field] = said.valid;
  }

  done() {
    return cardDone(this.fields);
  }

  // Whether the section needs nothing more (pay/states.mjs,
  // sectionComplete). A card whose fields have not all reported waits
  // CARD_SETTLE_MS for the last one's word.
  async complete() {
    const amount = this.checkout.amount();
    const now = (done) => sectionComplete({
      amount, covered: this.section.covered, card: this.card,
      cardOpen: this.section.state.dataset.cardOpen === "true", done,
    });

    if (now(this.done())) return true;
    if (!now(true)) return false;
    await new Promise((resolve) => { setTimeout(resolve, CARD_SETTLE_MS); });

    return this.done();
  }

  // The card form's token, with the customer's details for the
  // bank's verification. -> { method, sourceId }; throws with a
  // message for the customer.
  async tokenize(payload) {
    if (!this.card) {
      throw new Error("Card payments aren't available right now.");
    }

    const b = this.checkout.billing(payload);
    const result = await this.card.tokenize(
      cardRequest(this.checkout.amount(), b)
    );

    if (result.status !== "OK") throw new Error(tokenMessage(result));

    return { method: "card", sourceId: result.token };
  }
}
