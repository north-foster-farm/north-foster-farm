// Browser-side persistence: the draft being typed, and a submission
// that could not be delivered yet. Every access is guarded because
// storage can be absent, full, or blocked.
//
// One draft carries one submission key, and an attempt number that
// counts up whenever the processor was asked and the answer was no,
// or the form changed after it was asked. The server derives every
// idempotency key from the pair, so a retry of one attempt finds what
// it made and a new attempt never collides with an old one.

const DRAFT = "nff-order-draft";
const PENDING = "nff-order-pending";

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
  }

  clear() {
    this.memory = null;
    write(this.name, null);
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

// Signing out takes the customer's details out of the draft and
// leaves the cart, so the next person at this browser starts clean.
export const forgetCustomer = () => {
  const current = read(DRAFT);

  if (!current || !current.payload) return;
  write(DRAFT, {
    ...current, payload: { ...current.payload, customer: {} },
  });
};
