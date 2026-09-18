// Browser-side persistence: the draft being typed, and a submission
// that could not be delivered yet. Every access is guarded because
// storage can be absent, full, or blocked.

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
  load() {
    return read(DRAFT);
  }

  save(payload) {
    write(DRAFT, { payload, savedAt: Date.now() });
  }

  clear() {
    write(DRAFT, null);
  }

  // One key per submission, kept across retries so Square never sees
  // the same order twice.
  key() {
    const current = read(DRAFT) || {};

    if (!current.key) {
      current.key = uuid();
      write(DRAFT, current);
    }

    return current.key;
  }

  pending() {
    return read(PENDING);
  }

  savePending(payload, attempts) {
    write(PENDING, { payload, attempts, savedAt: Date.now() });
  }

  clearPending() {
    write(PENDING, null);
  }
}
