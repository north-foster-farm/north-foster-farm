// A buying group's credit (#471): stored value the farm grants a
// member, the host reward or a share of it (lib/rounds.mjs), spent on
// a later order alongside member pricing. It is the site's own, in
// the customers store under `credit/<email>`, never Square's: a
// ledger of grants, each with what has been spent of it, so the
// books show every dollar and where it went.
//
// Credit expires at the end of the year it was granted (James,
// 6405284935: a firm rule), by the farm's clock. An expired grant
// stays on the ledger, worth nothing. A refund of an order paid with
// credit puts the credit back on the grants it came from, first
// (James, 6405215783).

import {
  instant, parts,
} from "../../../assets/scripts/order/lib/zoned.mjs";
import { getOrder } from "./records.mjs";

const emailOf = (value) => String(value || "").trim().toLowerCase();

export const creditKey = (email) => `credit/${emailOf(email)}`;

// When a grant made at `now` expires: 11:59 PM on 31 December of the
// same year, or, for a grant made in December, of the following year
// (James, 2026-10-26: credit granted in December 2026 runs to the end
// of 2027), as an instant.
export const yearEnd = (now, timeZone) => {
  const { year, month } = parts(now, timeZone);

  return instant(`${month === 12 ? year + 1 : year}-12-31`, 23, 59, timeZone)
    .toISOString();
};

export const getLedger = async (stores, email) =>
  (await stores.customers.get(creditKey(email)))
  || { email: emailOf(email), entries: [] };

// What a member removed from a group, or who leaves it, keeps of their
// credit (#495). James has not ruled; this is the one switch:
//   "keep"  it stays theirs, spendable on any signed-in order until it
//           expires (the recommended default), and the farm voids it
//           for abuse with `bin/nff groups credit <email> --void`;
//   "void"  what is left is voided when they leave.
export const REMOVED_MEMBER_CREDIT = "keep";

// Whether credit spends on a signed-in order with no group.
export const creditWithoutGroup = () => REMOVED_MEMBER_CREDIT === "keep";

export const spentOf = (entry) =>
  (entry.spent || []).reduce((s, x) => s + x.amount, 0);

// What the farm voided of a grant (#495).
export const voidedOf = (entry) =>
  (entry.voided || []).reduce((s, x) => s + x.amount, 0);

export const leftOf = (entry) => entry.amount - spentOf(entry)
  - voidedOf(entry);

export const live = (entry, now) => now.toISOString() <= entry.expiresAt;

// What a ledger is worth now, in cents: the unexpired grants, less
// what was spent of them.
export const balanceOf = (ledger, now) => ledger.entries
  .filter((e) => live(e, now))
  .reduce((s, e) => s + leftOf(e), 0);

export const creditBalance = async (stores, email, now = new Date()) =>
  balanceOf(await getLedger(stores, email), now);

// How many times a change reads the ledger again after losing a swap
// to another writer before giving up.
const SWAPS = 5;

// Reads the ledger, lets `change` decide from what is stored, and
// writes only if no one wrote in between. `change` -> the next
// ledger, or null to write nothing. -> what is stored after.
const swapLedger = async (stores, email, change) => {
  const key = creditKey(email);

  for (let i = 0; i < SWAPS; i++) {
    const found = await stores.customers.getTagged(key);
    const ledger = found ? found.value : { email: emailOf(email), entries: [] };
    const next = change(ledger);

    if (!next) return ledger;
    if (!found) {
      if (await stores.customers.create(key, next)) return next;
    } else if (await stores.customers.swap(key, next, found.etag)) {
      return next;
    }
  }

  throw new Error(`The credit of ${emailOf(email)} kept changing; try again.`);
};

// A grant, once: the same `from` (the group, the round and the kind,
// host or share) is never granted twice. -> the ledger.
export const grantCredit = async (stores, email, {
  amount, from, now = new Date(), timeZone,
}) => {
  if (!(Number.isInteger(amount) && amount > 0)) {
    throw new Error("A grant is a whole number of cents above zero.");
  }

  const id = `${from.group}/${from.round}/${from.kind}`;

  return swapLedger(stores, email, (ledger) => (
    ledger.entries.some((e) => e.id === id) ? null : {
      ...ledger,
      entries: [...ledger.entries, {
        id, amount, from, grantedAt: now.toISOString(),
        expiresAt: yearEnd(now, timeZone), spent: [],
      }],
    }
  ));
};

// What an order still holds of a ledger, across its grants: its
// spends less what refunds put back.
export const heldBy = (ledger, orderId) => ledger.entries
  .reduce((s, e) => s + (e.spent || [])
    .filter((x) => x.orderId === orderId)
    .reduce((t, x) => t + x.amount, 0), 0);

// Brings what an order holds of the ledger to exactly `amount`: more
// is spent from the grants that expire soonest, less is put back on
// the grants the order spent (security re-re-review, 6427102482: a
// retry under the same order id may hold some already, or too much).
// A hold already at `amount` leaves the ledger. Throws when the
// balance is short of what more is needed. -> the ledger.
export const spendCredit = (stores, email, {
  orderId, amount, now = new Date(),
}) => swapLedger(stores, email, (ledger) => {
  const held = heldBy(ledger, orderId);

  if (held === amount) return null;

  const at = now.toISOString();
  const entries = ledger.entries.map((e) => ({ ...e, spent: [...e.spent] }));

  if (held > amount) {
    // Too much held: give the difference back, newest spends first.
    let back = held - amount;

    for (const e of [...entries].reverse()) {
      if (back === 0) break;

      const mine = (e.spent || []).filter((x) => x.orderId === orderId)
        .reduce((s, x) => s + x.amount, 0);

      if (mine <= 0) continue;

      const give = Math.min(mine, back);

      e.spent.push({ orderId, amount: -give, at, trimmed: true });
      back -= give;
    }

    return { ...ledger, entries };
  }

  let left = amount - held;

  if (balanceOf(ledger, now) < left) {
    throw new Error(`${emailOf(email)} has less credit than ${left}.`);
  }
  for (const e of entries.sort((a, b) =>
    a.expiresAt.localeCompare(b.expiresAt))) {
    if (left === 0) break;
    if (!live(e, now) || leftOf(e) === 0) continue;

    const take = Math.min(leftOf(e), left);

    e.spent.push({ orderId, amount: take, at });
    left -= take;
  }

  return { ...ledger, entries };
});

// Puts credit back after a refund: onto the grants the order spent,
// up to `amount`, whatever their expiry (the member lost nothing by
// the refund). -> the ledger, and how much went back.
export const restoreCredit = async (stores, email, {
  orderId, amount, now = new Date(),
}) => {
  let restored = 0;
  const ledger = await swapLedger(stores, email, (stored) => {
    let left = amount;
    const at = now.toISOString();

    restored = 0;

    const entries = stored.entries.map((e) => {
      const spent = [...(e.spent || [])];
      // What the order still holds of this grant: its spends less
      // what earlier refunds put back.
      const held = spent.filter((x) => x.orderId === orderId)
        .reduce((s, x) => s + x.amount, 0);

      if (left === 0 || held <= 0) return e;

      const give = Math.min(held, left);

      left -= give;
      restored += give;
      spent.push({ orderId, amount: -give, at, refund: true });

      return { ...e, spent };
    });

    return restored > 0 ? { ...stored, entries } : null;
  });

  return { ledger, restored };
};

// Voids what is left of every live grant (#495): for abuse, or on
// leaving a group when REMOVED_MEMBER_CREDIT says so. Each grant keeps
// what was voided, when and why, so the books still show every dollar.
// -> { ledger, voided } with `voided` in cents.
export const voidCredit = async (stores, email, {
  now = new Date(), reason = "",
} = {}) => {
  let voided = 0;
  const ledger = await swapLedger(stores, email, (stored) => {
    const at = now.toISOString();

    voided = 0;

    const entries = stored.entries.map((e) => {
      const left = live(e, now) ? leftOf(e) : 0;

      if (left <= 0) return e;
      voided += left;

      return {
        ...e, voided: [...(e.voided || []), { amount: left, at, reason }],
      };
    });

    return voided > 0 ? { ...stored, entries } : null;
  });

  return { ledger, voided };
};

// How long a spend may stand with no order to show for it: a
// submission the page would have retried has long since been
// abandoned (lib/records.mjs CHECKOUT_TTL is a day too).
export const STRANDED_MS = 24 * 60 * 60_000;

// Credit a submission spent and never settled (a failure the page
// would have retried, then a closed tab; security re-review,
// 6426747224): the spend stays on the ledger for an order id that
// has no record. Once it is a day old it goes back, so the member
// loses nothing. For the jobs; every ledger is read.
// -> [{ email, orderId, restored }]
export const sweepStrandedCredit = async (stores, {
  now = new Date(),
} = {}) => {
  const keys = await stores.customers.list("credit/");
  const out = [];

  for (const { key } of keys) {
    const ledger = await stores.customers.get(key);

    if (!ledger || !Array.isArray(ledger.entries)) continue;

    const since = new Map();

    for (const e of ledger.entries) {
      for (const s of e.spent || []) {
        if (s.amount > 0 && (!since.has(s.orderId)
          || s.at < since.get(s.orderId))) since.set(s.orderId, s.at);
      }
    }

    for (const [orderId, at] of since) {
      const held = heldBy(ledger, orderId);

      if (held <= 0) continue;
      if (now.getTime() - Date.parse(at) < STRANDED_MS) continue;
      if (await getOrder(stores, orderId)) continue;

      const { restored } = await restoreCredit(stores, ledger.email, {
        orderId, amount: held, now,
      });

      if (restored > 0) out.push({ email: ledger.email, orderId, restored });
    }
  }

  return out;
};
