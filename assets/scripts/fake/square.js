// A stand-in for Square's Web Payments SDK, for SQUARE_ENV=fake in local
// development (netlify/functions/lib/fake.mjs). It offers what the
// order page uses (assets/scripts/order/pay.js): the card form, which
// draws plain fields instead of Square's iframe, and a payment request.
// The wallets say they are unavailable, so their buttons stay hidden.
// Published at /scripts/fake-square.js by a local `hugo server` only
// (layouts/partials/fake-sdks.html).
//
// The token is `fake:ok-...`; the card 4000 0000 0000 0002 gives
// `fake:CARD_DECLINED`, which lib/fake-square.mjs declines.

const DECLINED = "4000000000000002";

const field = (name, label, value) => {
  const wrap = document.createElement("label");
  const input = document.createElement("input");

  wrap.textContent = label;
  wrap.style.display = "block";
  wrap.style.marginBottom = "0.5rem";
  input.className = "form-control";
  input.name = name;
  input.value = value;
  input.autocomplete = "off";
  wrap.append(input);

  return wrap;
};

// When the fake calls a field complete, as Square's isCompletelyValid
// does by its own light check.
const COMPLETE = {
  cardNumber: (v) => v.replace(/\D/g, "").length >= 12,
  expirationDate: (v) => /^\d{2}\s*\/\s*\d{2}$/.test(v.trim()),
  cvv: (v) => /^\d{3,4}$/.test(v.trim()),
  postalCode: (v) => /^\d{5}$/.test(v.trim()),
};

class Card {
  constructor() {
    this.root = null;
    this.listeners = {};
  }

  // Square's card form sends CardInputEvents (detail.field and
  // detail.currentState) to its listeners; the fake sends
  // focusClassRemoved as a field is typed in or left.
  addEventListener(type, listener) {
    (this.listeners[type] ||= []).push(listener);
  }

  emit(type, input) {
    const value = input.value;
    const detail = {
      eventType: type,
      field: input.name,
      currentState: {
        isCompletelyValid: COMPLETE[input.name](value),
        isPotentiallyValid: true,
        isEmpty: !value,
        hasErrorClass: false,
        hasFocusClass: false,
      },
    };

    for (const listener of this.listeners[type] || []) listener({ detail });
  }

  async attach(container) {
    const note = document.createElement("p");

    this.root = document.createElement("div");
    this.root.dataset.fakeCard = "";
    note.textContent = "Fake card form (SQUARE_ENV=fake): nothing is " +
      `charged. ${DECLINED.replace(/(\d{4})(?=\d)/g, "$1 ")} declines.`;
    note.style.fontSize = "0.875rem";
    this.root.append(
      note,
      field("cardNumber", "Card number", "4111 1111 1111 1111"),
      field("expirationDate", "Expiration", "12/30"),
      field("cvv", "Security code", "111"),
      field("postalCode", "ZIP", "11111"),
    );
    for (const type of ["input", "focusout"]) {
      this.root.addEventListener(type, (e) => {
        if (e.target.name in COMPLETE) this.emit("focusClassRemoved", e.target);
      });
    }
    container.replaceChildren(this.root);
  }

  async focus(name) {
    const input = this.root && this.root.querySelector(`[name='${name}']`);

    if (input) input.focus();
  }

  async tokenize() {
    const number = this.root.querySelector("[name='cardNumber']").value
      .replace(/\D/g, "");

    if (number.length < 12) {
      return {
        status: "Invalid",
        errors: [{ field: "cardNumber", message: "Enter a card number." }],
      };
    }
    if (number === DECLINED) {
      return { status: "OK", token: "fake:CARD_DECLINED" };
    }

    return {
      status: "OK",
      token: `fake:ok-${Math.random().toString(36).slice(2, 10)}`,
    };
  }

  async destroy() {
    if (this.root) this.root.remove();
  }
}

const unavailable = async () => {
  throw new Error("Not available in the fake SDK.");
};

window.Square = {
  payments: () => ({
    card: async () => new Card(),
    paymentRequest: () => ({ update: () => true }),
    applePay: unavailable,
    googlePay: unavailable,
    cashAppPay: unavailable,
  }),
};
