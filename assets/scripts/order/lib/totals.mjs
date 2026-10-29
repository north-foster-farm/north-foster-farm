// Money, in integer cents. Client figures are display only; the
// function recomputes everything here from the catalog on every
// submission.

import { perkEffects } from "./perks.mjs";

export const toCents = (dollars) => Math.round(Number(dollars) * 100);

export const dollars = (cents) => {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const whole = Math.floor(abs / 100);
  const frac = abs % 100;

  return frac === 0
    ? `${sign}$${whole}`
    : `${sign}$${whole}.${String(frac).padStart(2, "0")}`;
};

// Highest tier whose threshold the subtotal meets. Tiers never stack.
export const discountFor = (subtotal, money) => {
  let best = null;

  for (const tier of money.bulkTiers) {
    if (subtotal >= toCents(tier.threshold)) best = tier;
  }

  return best
    ? { tier: best.threshold, amount: toCents(best.off) }
    : { tier: null, amount: 0 };
};

// The next tier above the subtotal and how far away it is.
export const nextTier = (subtotal, money) => {
  for (const tier of money.bulkTiers) {
    const threshold = toCents(tier.threshold);

    if (subtotal < threshold) {
      return { threshold, off: toCents(tier.off), gap: threshold - subtotal };
    }
  }

  return null;
};

// A customer's discount group, from money.discountGroups, as a
// percentage of the subtotal, in whole dollars, halves up (D5).
// -> { key, label, percent, amount }.
export const groupDiscountFor = (subtotal, group, money) => {
  const groups = money.discountGroups || {};
  const found = group && groups[group];

  if (!found || !(found.percent > 0)) return null;

  return {
    key: group,
    label: found.label || group,
    percent: found.percent,
    amount: Math.round(subtotal * found.percent / 10000) * 100,
  };
};

// A discount code from data/discount-codes.json, already looked up:
// { code, label, off } with `off` in whole dollars. -> { key, label,
// amount } or null. A code never takes more than the subtotal.
export const codeDiscountFor = (subtotal, code) => {
  if (!code || !(code.off > 0) || subtotal <= 0) return null;

  return {
    key: code.code,
    label: code.label || code.code,
    amount: Math.min(subtotal, toCents(code.off)),
  };
};

// A buying group's member price list (#471): a member pays the lower
// of an item's member price and its retail price, so a rise in retail
// shows as a whole-dollar discount on each item the lock holds down.
// `lock` is the group's `priceLock` (data/groups.json): { prices:
// { [sku]: dollars }, label? }. -> { key, label, amount, lines:
// [{ sku, off, qty, amount }] } in cents, or null while nothing is
// held down (today the member prices are retail).
export const lockDiscountFor = (lines, index, lock) => {
  if (!lock || !lock.prices) return null;

  const out = [];
  let amount = 0;

  for (const { sku, qty } of lines) {
    const item = index.get(sku);
    const locked = lock.prices[sku];

    if (!item || !(locked >= 0) || !(item.price > locked)) continue;

    const off = toCents(item.price - locked);

    out.push({ sku, off, qty, amount: off * qty });
    amount += off * qty;
  }

  return amount > 0
    ? { key: "lock", label: lock.label || "Member price", amount, lines: out }
    : null;
};

// The lock while it holds: through its last day (`through`, an ISO
// date), by the order's own day in the farm's zone, the day it is
// placed or, for a change, was. After that a member pays retail
// (security review, 6425096526). -> the lock, or null.
export const lockOn = (lock, day) =>
  (lock && (!lock.through || day <= lock.through) ? lock : null);

// `lines` is [{ sku, qty }]; `index` is indexCatalog(catalog); `group`
// is the customer's discount group key, if any; `code` is a discount
// code entry, if a known one was typed; `lock` is a buying group
// member's member price list, if any. The bulk tier, the group
// discount, the code and the member price never stack: the customer
// gets the largest.
// `zipStatus` is the delivery ZIP's status from zipInfo, when known.
// `waiveFee` is a farm-issued pass that waives the delivery fee
// (#182): no fee and no outside-area fee, and `feeWaived` set when
// there was one to waive. Discounts apply as usual.
// `credit` is a buying group member's credit (#471, lib/credit.mjs),
// in cents, as much of it as they hold: stored value, not a
// discount, so it comes off after every discount and fee, and
// `total` is then the money due. `credit` on the totals is what it
// covered, only when it covered something.
// `perks` is the customer's perk types in force (#514, lib/perks.mjs),
// which the caller has read from the signed-in account or the
// customer's record. A perk that lifts the fee waives it as a pass
// does, and `perks` on the totals names every one the order was
// priced with, so a change to the order keeps them.
export const computeTotals = ({
  lines, method, index, money, group, code, lock, zipStatus,
  waiveFee = false, credit = 0, perks = [],
}) => {
  const perk = perkEffects(perks);
  let subtotal = 0;

  for (const { sku, qty } of lines) {
    const item = index.get(sku);

    if (item) subtotal += toCents(item.price) * qty;
  }

  const bulk = discountFor(subtotal, money);
  const byGroup = groupDiscountFor(subtotal, group, money);
  const byCode = codeDiscountFor(subtotal, code);
  const byLock = lockDiscountFor(lines, index, lock);
  const best = Math.max(
    bulk.amount, byGroup ? byGroup.amount : 0, byCode ? byCode.amount : 0,
    byLock ? byLock.amount : 0
  );
  const useCode = !!byCode && byCode.amount === best && byCode.amount > 0;
  // A tie between the lock and the tier goes to the lock: it is the
  // member's own, and the record then says which group the order is.
  const useLock = !useCode && !!byLock && byLock.amount === best;
  const useGroup = !useCode && !useLock && !!byGroup
    && byGroup.amount > bulk.amount;
  // An empty cart owes nothing, whatever method is chosen: Delivery
  // is the starting choice, and a fee on nothing read as a $5 order.
  const isDelivery = method === "delivery" && subtotal > 0;
  const baseFee = isDelivery && subtotal < toCents(money.feeWaivedAt)
    ? toCents(money.deliveryFee)
    : 0;
  // A Rhode Island address outside the published towns pays a flat
  // charge on top, never waived: it covers the extra miles.
  const areaFee = isDelivery && zipStatus === "unlisted"
    ? toCents(money.outsideAreaFee || 0)
    : 0;
  const owed = baseFee + areaFee;
  const feeWaived = (!!waiveFee || perk.fee) && owed > 0;
  const deliveryFee = feeWaived ? 0 : owed;

  const discountAmount = useCode
    ? byCode.amount
    : (useLock ? byLock.amount
      : (useGroup ? byGroup.amount : bulk.amount));
  const discountLabel = useCode
    ? byCode.label
    : (useLock ? byLock.label
      : (useGroup
        ? `${byGroup.label} (${byGroup.percent}%)`
        : (bulk.tier ? `Bulk discount ($${bulk.tier}+)` : null)));
  const owedBeforeCredit = subtotal - discountAmount + deliveryFee;
  // Credit covers the items, never the delivery fee: Square carries
  // the credit as an order discount, which it applies to the items
  // alone, so a fee paid with credit would leave Square's total above
  // ours (fakes audit, 6426321360, C1). The fee is always money.
  const creditUsed = Math.min(
    Math.max(0, Math.floor(Number(credit) || 0)), subtotal - discountAmount
  );

  return {
    subtotal,
    discountTier: useCode || useGroup || useLock ? null : bulk.tier,
    discountGroup: useGroup ? byGroup.key : null,
    discountCode: useCode ? byCode.key : null,
    discountLabel,
    discountAmount,
    deliveryFee,
    areaFee: feeWaived ? 0 : areaFee,
    // Only on an order that waived one, so no other record changes.
    ...(feeWaived ? { feeWaived: true } : {}),
    // Only on an order the member price held down (#471): the per-item
    // amounts Square shows on the receipt.
    ...(useLock ? { discountLock: true, lockLines: byLock.lines } : {}),
    // Only on an order credit covered some of (#471).
    ...(creditUsed > 0 ? { credit: creditUsed } : {}),
    // Only on an order of a customer with a perk (#514).
    ...(perk.types.length ? { perks: perk.types } : {}),
    total: owedBeforeCredit - creditUsed,
  };
};

export const meetsMinimum = (totals, money) =>
  totals.subtotal - totals.discountAmount >= toCents(money.deliveryMinimum);
