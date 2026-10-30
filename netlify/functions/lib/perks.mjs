// Customer perks on the record (#514): `bin/nff perks add`, `list` and
// `remove`, and what the order path reads. The types and what each
// does are assets/scripts/order/lib/perks.mjs, shared with the page.
//
// Every change is logged (#497): who acted, the action, the customer's
// address masked (#496), never a name, and the types in force before
// and after. A perk is never deleted: removing one dates it, so the
// record keeps what applied when.

import {
  DAY, PERKS, PERK_TYPES, activePerks, perkActive, perksOf,
} from "../../../assets/scripts/order/lib/perks.mjs";
import { today } from "../../../assets/scripts/order/lib/zoned.mjs";
import { normalizeEmail, validEmail } from "./auth.mjs";
import { now as clock } from "./clock.mjs";
import { log } from "./log.mjs";
import { maskEmail } from "./mask.mjs";
import { allCustomers, getCustomer, saveCustomer } from "./records.mjs";
import terms from "./terms.mjs";

const dayOf = (now) => today(now, terms.timeZone);

const typesOn = (customer, day) => activePerks(customer, day)
  .map((p) => p.type).sort();

// The types that apply to the customer's orders now. -> ["friends", ..]
export const perkTypes = (customer, now = clock()) =>
  activePerks(customer, dayOf(now)).map((p) => p.type);

const checkType = (type) => {
  if (!PERKS[type]) {
    throw new Error(`Unknown perk "${type}". Known: ${
      PERK_TYPES.join(", ")}.`);
  }
};

const checkDay = (value, what) => {
  if (value && !(DAY.test(value) && !Number.isNaN(Date.parse(value)))) {
    throw new Error(`${what} is a date, YYYY-MM-DD.`);
  }
};

// A customer the farm serves who has never ordered online has no
// record yet: one is made, with nothing on it but the address, so the
// perk has somewhere to live and the farm's first order for them finds
// it. Farm news stays off.
const recordFor = async (stores, email, now) => (await getCustomer(stores,
  email)) || {
  email, name: "", firstName: "", lastName: "", phone: "", avatar: null,
  discountGroup: null, address: null, marketing: false, marketingAt: null,
  createdAt: now.toISOString(),
};

// Grants a perk. `start` defaults to today; `end`, the last day it
// applies, to none. `owner` says James himself is setting it, which
// the family perk needs. A type the customer already holds and that
// has not ended is refused: remove it first.
// -> { record (masked), perk, made } where `made` says the customer
// record was new.
export const addPerk = async (stores, email, type, {
  start = null, end = null, by = null, owner = false, now = clock(),
} = {}) => {
  const address = normalizeEmail(email);

  if (!validEmail(address)) throw new Error("Give an email address.");
  checkType(type);
  checkDay(start, "--start");
  checkDay(end, "--end");
  if (PERKS[type].owner && !owner) {
    throw new Error(`Only James sets the ${type} perk: add --owner if ` +
      "you are James.");
  }

  const day = dayOf(now);
  const from = start || day;

  if (end && end < from) throw new Error("--end is before the start.");

  const existing = await getCustomer(stores, address);
  const customer = await recordFor(stores, address, now);
  const open = perksOf(customer).find((p) => p.type === type
    && !p.removedAt && (!p.end || p.end >= day));

  if (open) {
    throw new Error(`This customer already holds ${type}${
      open.end ? ` through ${open.end}` : ""}. Remove it first.`);
  }

  const perk = {
    type, start: from, end: end || null, setBy: by || "cli",
    setAt: now.toISOString(),
  };
  const before = typesOn(customer, day);
  const saved = await saveCustomer(stores, {
    ...customer, perks: [...perksOf(customer), perk],
  });

  log.info({
    event: "perk.added", by: perk.setBy, record: maskEmail(address), type,
    start: perk.start, end: perk.end, before, after: typesOn(saved, day),
    ...(existing ? {} : { madeRecord: true }),
  });

  return { record: maskEmail(address), perk, made: !existing };
};

// Ends the customer's perk of `type` now: the open one is dated
// removed, and stops applying at once. -> { record (masked), perk }.
export const removePerk = async (stores, email, type, {
  by = null, now = clock(),
} = {}) => {
  const address = normalizeEmail(email);

  checkType(type);

  const customer = await getCustomer(stores, address);

  if (!customer) throw new Error("No such customer.");

  const day = dayOf(now);
  const list = perksOf(customer);
  const at = list.findIndex((p) => p.type === type && !p.removedAt
    && (!p.end || p.end >= day));

  if (at < 0) throw new Error(`This customer holds no ${type} perk.`);

  const perk = {
    ...list[at], removedAt: now.toISOString(), removedBy: by || "cli",
  };
  const before = typesOn(customer, day);
  const saved = await saveCustomer(stores, {
    ...customer, perks: list.map((p, i) => (i === at ? perk : p)),
  });

  log.info({
    event: "perk.removed", by: perk.removedBy, record: maskEmail(address),
    type, before, after: typesOn(saved, day),
  });

  return { record: maskEmail(address), perk };
};

// Every customer's perks, or one customer's, each with its state on
// the day: active, ended (past its end), removed or future. Read only.
export const listPerks = async (stores, {
  email = null, now = clock(),
} = {}) => {
  const day = dayOf(now);
  const people = email
    ? [await getCustomer(stores, normalizeEmail(email))].filter(Boolean)
    : await allCustomers(stores);
  const state = (p) => (p.removedAt ? "removed"
    : perkActive(p, day) ? "active"
      : p.start && p.start > day ? "future" : "ended");

  return people.flatMap((c) => perksOf(c).map((p) => ({
    email: c.email, ...p, state: state(p),
  })));
};
