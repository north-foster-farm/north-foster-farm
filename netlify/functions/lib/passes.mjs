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
// A ride-along pass (#183) lifts the fee as well: the farm grants a
// delivery on a run it drives anyway, one order at a time, to one
// email, and to no more than RIDE_ALONG_CAP customers a month. It is
// used by any delivery order it is given to, since it changes the
// price.

import { randomInt } from "node:crypto";

export const PASS_DAYS = 14;
export const HOLD_MS = 30 * 60_000;
export const RIDE_ALONG_CAP = 3;

// Whether a pass makes its order a ride-along.
export const ridesAlong = (pass) => !!pass
  && (pass.lifts || []).includes("fee");

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

// Drafts: the customer sees these on the order page.
export const PASS_MESSAGES = {
  unknown: "Not a valid code.",
  used: "That code has already been used.",
  expired: "That code has expired.",
  email: "That code was issued for a different email address.",
  held: "That code is in use on another order. Try again in half an hour.",
};

export const getPass = async (stores, value) => {
  const code = passCodeOf(value);

  return code ? stores.orders.get(passKey(code)) : null;
};

// `riders` is who already rides along this month (rideAlongRiders in
// lib/admin.mjs); a ride-along pass needs it and an email.
export const issuePass = async (stores, {
  email = null, days = PASS_DAYS, note = "", now = new Date(),
  pick = randomInt, rideAlong = false, riders = [],
} = {}) => {
  if (!(Number.isInteger(days) && days >= 1 && days <= 365)) {
    throw new Error("--days is a whole number from 1 to 365.");
  }
  if (rideAlong && !email) {
    throw new Error("A ride-along pass needs --email.");
  }
  if (rideAlong && !riders.includes(emailOf(email))
    && riders.length >= RIDE_ALONG_CAP) {
    throw new Error(`${RIDE_ALONG_CAP} customers already ride along this ` +
      `month: ${riders.join(", ")}.`);
  }

  let code = newPassCode(pick);

  // Eight characters from 31 rarely meet, but a pass is never reissued.
  while (await stores.orders.get(passKey(code))) code = newPassCode(pick);

  const pass = {
    code,
    lifts: rideAlong ? ["minimum", "fee"] : ["minimum"],
    email: email ? emailOf(email) : null,
    note: String(note || ""),
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + days * 86_400_000).toISOString(),
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
// reason, a key of PASS_MESSAGES. `email` and `orderId` are left out
// by the page's lookup, which knows neither yet.
export const passProblem = (pass, {
  email, orderId, now = new Date(),
} = {}) => {
  if (!pass || pass.revokedAt) return "unknown";
  if (pass.usedBy) return pass.usedBy === orderId ? null : "used";
  if (now.toISOString() > pass.expiresAt) return "expired";
  if (email && pass.email && pass.email !== emailOf(email)) return "email";

  const heldElsewhere = pass.heldBy && pass.heldBy !== orderId
    && now.getTime() - Date.parse(pass.heldAt) < HOLD_MS;

  return heldElsewhere ? "held" : null;
};

export const holdPass = async (stores, pass, orderId, now = new Date()) => {
  const held = { ...pass, heldBy: orderId, heldAt: now.toISOString() };

  await stores.orders.set(passKey(pass.code), held);

  return held;
};

// Idempotent: a retried write of the same order finds it used by that
// order and leaves it.
export const usePass = async (stores, code, orderId, now = new Date()) => {
  const pass = await getPass(stores, code);

  if (!pass || pass.usedBy) return pass;

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
  if (pass.revokedAt) return "revoked";
  if (pass.usedBy) return `used by ${pass.usedBy}`;
  if (now.toISOString() > pass.expiresAt) return "expired";

  return `open until ${pass.expiresAt.slice(0, 10)}`;
};
