// Money, in integer cents. Client figures are display only; the
// function recomputes everything here from the catalog on every
// submission.

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

// A buying group's locked price list (#471): a member pays the lower
// of an item's locked price and its retail price, so a rise in retail
// shows as a whole-dollar discount on each item the lock holds down.
// `lock` is the group's `priceLock` (data/groups.json): { prices:
// { [sku]: dollars }, label? }. -> { key, label, amount, lines:
// [{ sku, off, qty, amount }] } in cents, or null while nothing is
// held down (today the locked prices are retail).
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
    ? { key: "lock", label: lock.label || "Price lock", amount, lines: out }
    : null;
};

// `lines` is [{ sku, qty }]; `index` is indexCatalog(catalog); `group`
// is the customer's discount group key, if any; `code` is a discount
// code entry, if a known one was typed; `lock` is a buying group
// member's locked price list, if any. The bulk tier, the group
// discount, the code and the price lock never stack: the customer
// gets the largest.
// `zipStatus` is the delivery ZIP's status from zipInfo, when known.
// `waiveFee` is a farm-issued pass that waives the delivery fee
// (#182): no fee and no outside-area fee, and `feeWaived` set when
// there was one to waive. Discounts apply as usual.
export const computeTotals = ({
  lines, method, index, money, group, code, lock, zipStatus,
  waiveFee = false,
}) => {
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
  const feeWaived = !!waiveFee && owed > 0;
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
    // Only on an order the price lock held down (#471): the per-item
    // amounts Square shows on the receipt.
    ...(useLock ? { discountLock: true, lockLines: byLock.lines } : {}),
    total: subtotal - discountAmount + deliveryFee,
  };
};

export const meetsMinimum = (totals, money) =>
  totals.subtotal - totals.discountAmount >= toCents(money.deliveryMinimum);
