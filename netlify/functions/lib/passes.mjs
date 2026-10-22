// Minimum passes (#182): a code the farm issues from the CLI that lets
// one delivery order go below the delivery minimum, for a gift or a
// favor. It changes what the order page accepts, never what it
// charges: the fee, the discounts and Square see nothing of it.
//
// A pass is single use, expires (PASS_DAYS unless the farm says
// otherwise) and may be tied to one email. It lives in the orders
// store under `pass/<code>`. Checking one at submission holds it for
// that order for HOLD_MS, so a second order cannot take it while the
// first is being paid; the paid record uses it up. An order that meets
// the minimum anyway, or is not a delivery, leaves the pass alone.
//
// A standing pass (James, 6333265908) is tied to one email and lifts
// the minimum on every order from it until the farm revokes it: no
// expiry unless one is given, no hold, never used up. Either kind may
// also waive the delivery fee (6333306849): that is how the farm
// carries ride-along customers. The fee then goes to Square as $0.
//
// To the customer a pass is a discount code like any other: it goes in
// the same box, and nothing they see calls it a pass.

import { randomInt } from "node:crypto";

export const PASS_DAYS = 14;
export const HOLD_MS = 30 * 60_000;

// No 0/O, 1/I/L: the farm reads these out over the phone.
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

export const passKey = (code) => `pass/${code}`;

// Upper case, letters and digits, grouped XXXX-XXXX.
export const newPassCode = (pick = randomInt) => {
  let raw = "";

  for (let i = 0; i < 8; i++) raw += ALPHABET[pick(ALPHABET.length)];

  return `${raw.slice(0, 4)}-${raw.slice(4)}`;
};

// What the customer typed, in the stored form: the hyphen optional.
export const passCodeOf = (value) => {
  const raw = String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "");

  return raw.length === 8 ? `${raw.slice(0, 4)}-${raw.slice(4)}` : "";
};

const emailOf = (value) => String(value || "").trim().toLowerCase();

// What the customer sees (James, on #182): one sentence for every code
// that doesn't work, used, expired, revoked, for another email or held
// by an order being paid. The page never says which; the farm sees the
// reason in `passes list` (passState).
const INVALID = "That code isn't valid.";

export const PASS_MESSAGES = {
  unknown: INVALID,
  used: INVALID,
  expired: INVALID,
  email: INVALID,
  held: INVALID,
};

// What a pass lifts: the minimum always, the fee when issued so.
export const waivesFee = (pass) => !!pass
  && (pass.lifts || []).includes("fee");

export const getPass = async (stores, value) => {
  const code = passCodeOf(value);

  return code ? stores.orders.get(passKey(code)) : null;
};

// `days` null means no expiry, for a standing pass only.
export const issuePass = async (stores, {
  email = null, days = PASS_DAYS, note = "", standing = false,
  waiveFee = false, now = new Date(), pick = randomInt,
} = {}) => {
  if (standing && !email) {
    throw new Error("A standing pass needs --email.");
  }
  if (days === null ? !standing
    : !(Number.isInteger(days) && days >= 1 && days <= 365)) {
    throw new Error("--days is a whole number from 1 to 365.");
  }

  let code = newPassCode(pick);

  // Eight characters from 31 rarely meet, but a pass is never reissued.
  while (await stores.orders.get(passKey(code))) code = newPassCode(pick);

  const pass = {
    code,
    lifts: waiveFee ? ["minimum", "fee"] : ["minimum"],
    standing: !!standing,
    email: email ? emailOf(email) : null,
    note: String(note || ""),
    issuedAt: now.toISOString(),
    expiresAt: days === null ? null
      : new Date(now.getTime() + days * 86_400_000).toISOString(),
    heldBy: null,
    heldAt: null,
    usedBy: null,
    usedAt: null,
    revokedAt: null,
  };

  await stores.orders.set(passKey(code), pass);

  return pass;
};

// -> null when the pass may lift the minimum for this order, else the
// reason, a key of PASS_MESSAGES. `holder` is the submission's key,
// which holds the pass while it is paid. `email` and `holder` are left
// out by the page's lookup, which knows neither yet.
export const passProblem = (pass, {
  email, holder, now = new Date(),
} = {}) => {
  if (!pass || pass.revokedAt) return "unknown";
  if (pass.usedBy) return "used";
  if (pass.expiresAt && now.toISOString() > pass.expiresAt) {
    return "expired";
  }
  if (email && pass.email && pass.email !== emailOf(email)) return "email";

  const heldElsewhere = !pass.standing && pass.heldBy
    && pass.heldBy !== holder
    && now.getTime() - Date.parse(pass.heldAt) < HOLD_MS;

  return heldElsewhere ? "held" : null;
};

// `holder` is the submission's key (orders.mjs).
export const holdPass = async (stores, pass, holder, now = new Date()) => {
  const held = { ...pass, heldBy: holder, heldAt: now.toISOString() };

  await stores.orders.set(passKey(pass.code), held);

  return held;
};

// Idempotent: a retried write of the same order finds it used by that
// order and leaves it. A standing pass is never used up.
export const usePass = async (stores, code, orderId, now = new Date()) => {
  const pass = await getPass(stores, code);

  if (!pass || pass.usedBy || pass.standing) return pass;

  const used = { ...pass, usedBy: orderId, usedAt: now.toISOString() };

  await stores.orders.set(passKey(pass.code), used);

  return used;
};

export const revokePass = async (stores, value, now = new Date()) => {
  const pass = await getPass(stores, value);

  if (!pass) throw new Error(`No pass ${value}.`);
  if (pass.usedBy) throw new Error(`${pass.code} was used by ${pass.usedBy}.`);

  const revoked = { ...pass, revokedAt: now.toISOString() };

  await stores.orders.set(passKey(pass.code), revoked);

  return revoked;
};

export const listPasses = async (stores) => {
  const passes = [];

  for (const { key } of await stores.orders.list("pass/")) {
    const pass = await stores.orders.get(key);

    if (pass) passes.push(pass);
  }

  return passes.sort((a, b) => (a.issuedAt < b.issuedAt ? 1 : -1));
};

export const passState = (pass, now = new Date()) => {
  const fee = waivesFee(pass) ? ", waives the fee" : "";

  if (pass.revokedAt) return "revoked";
  if (pass.usedBy) return `used by ${pass.usedBy}`;
  if (pass.expiresAt && now.toISOString() > pass.expiresAt) {
    return "expired";
  }

  const until = pass.expiresAt ? ` until ${pass.expiresAt.slice(0, 10)}`
    : "";

  return pass.standing ? `standing${until}${fee}`
    : `open${until}${fee}`;
};
