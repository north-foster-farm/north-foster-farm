// Browser-side persistence: the draft being typed, and a submission
// that could not be delivered yet. Every access is guarded because
// storage can be absent, full, or blocked.
//
// One draft carries one submission key, and an attempt number that
// counts up whenever the processor was asked and the answer was no,
// or the form changed after it was asked. The server derives every
// idempotency key from the pair, so a retry of one attempt finds what
// it made and a new attempt never collides with an old one.

import { signedOut } from "./lib/cart-sync.mjs";

const DRAFT = "nff-order-draft";
const PENDING = "nff-order-pending";

// Tells the account's copy of the cart that this one changed (#149;
// session/cart-sync.js). Only the cart draft; a change to a paid order
// stays on this device.
const announce = (draft) => {
  if (draft.name === DRAFT) window.dispatchEvent(new CustomEvent("nff:draft"));
};

const read = (key) => {
  try {
    const raw = window.localStorage.getItem(key);

    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
};

const write = (key, value) => {
  try {
    if (value === null) {
      window.localStorage.removeItem(key);
    } else {
      window.localStorage.setItem(key, JSON.stringify(value));
    }
  } catch {
    // Storage is a convenience; the form still works without it.
  }
};

const uuid = () => {
  if (window.crypto && window.crypto.randomUUID) {
    return window.crypto.randomUUID();
  }

  const bytes = new Uint8Array(16);

  window.crypto.getRandomValues(bytes);

  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
};

export class Draft {
  // `name` keeps a draft of its own under another key, in the same
  // format: a change to a paid order (?edit=) never touches the cart
  // the header reads.
  constructor({ name = DRAFT } = {}) {
    this.name = name;
    this.pendingName = name === DRAFT ? PENDING : `${name}-pending`;
    // Storage may be blocked; then the draft lives here for the page.
    this.memory = null;
  }

  current() {
    return read(this.name) || this.memory || {};
  }

  put(record) {
    this.memory = record;
    write(this.name, record);
  }

  load() {
    const current = this.current();

    return current.payload ? current : null;
  }

  save(payload) {
    this.put({ ...this.current(), payload, savedAt: Date.now() });
    announce(this);
  }

  clear() {
    this.memory = null;
    write(this.name, null);
    announce(this);
  }

  // The account's copy of the cart, from another device: its payload
  // and time, keeping this device's submission key. No payload means
  // that cart was cleared. The next payment attempt is a new one.
  adopt(cart) {
    if (!cart.payload) {
      this.memory = null;
      write(this.name, null);

      return;
    }
    this.put({
      ...this.current(), payload: cart.payload, savedAt: cart.savedAt,
    });
    this.touch();
  }

  // The account this draft belongs to (an opaque tag from the server),
  // or undefined for a guest's. Set when the draft is pulled or saved
  // signed in, so a session that ends without a sign-out still leaves
  // a draft the next page knows to scrub (#149, forgetCustomer).
  owner() {
    return this.current().owner;
  }

  setOwner(owner) {
    const current = this.current();

    if (current.payload && current.owner !== owner) {
      this.put({ ...current, owner });
    }
  }

  // The time the account keeps for this draft, when it differs.
  restamp(savedAt) {
    const current = this.current();

    if (current.payload) this.put({ ...current, savedAt });
  }

  // One key per submission, kept across retries and attempts.
  key() {
    const current = this.current();

    if (!current.key) {
      current.key = uuid();
      this.put(current);
    }

    return current.key;
  }

  attempt() {
    return this.current().attempt || 1;
  }

  // The processor was asked under this attempt's keys.
  markAttempted() {
    const current = this.current();

    if (!current.attempted) this.put({ ...current, attempted: true });
  }

  nextAttempt() {
    const current = this.current();

    this.put({
      ...current, attempt: (current.attempt || 1) + 1, attempted: false,
    });
  }

  // The form changed: if an attempt was already made, the next one is
  // a new attempt.
  touch() {
    if (this.current().attempted) this.nextAttempt();
  }

  // Small remembered facts, such as a note the customer dismissed.
  flag(key) {
    return read(key) === true;
  }

  setFlag(key) {
    write(key, true);
  }

  pending() {
    return read(this.pendingName);
  }

  savePending(payload, attempts) {
    write(this.pendingName, { payload, attempts, savedAt: Date.now() });
  }

  clearPending() {
    write(this.pendingName, null);
  }
}

// Signing out takes the customer's details and address out of the
// draft and leaves the cart, so the next person at this browser starts
// clean (lib/cart-sync.mjs, signedOut). The draft is then a guest's,
// with no owner. Also run when a session ended any other way, or the
// draft belongs to another account (session/cart-sync.js).
export const forgetCustomer = () => {
  const current = read(DRAFT);

  if (!current) return;

  const { owner, ...rest } = current;

  if (!current.payload) {
    if (owner) write(DRAFT, rest);

    return;
  }
  write(DRAFT, { ...rest, payload: signedOut(current.payload) });
};
