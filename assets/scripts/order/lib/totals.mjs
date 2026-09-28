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

// `lines` is [{ sku, qty }]; `index` is indexCatalog(catalog); `group`
// is the customer's discount group key, if any; `code` is a discount
// code entry, if a known one was typed. The bulk tier, the group
// discount and the code never stack: the customer gets the largest.
// `zipStatus` is the delivery ZIP's status from zipInfo, when known.
// `rideAlong` marks a delivery the farm makes on a run it drives
// anyway (#183): a delivery at no fee, never a fee comped.
export const computeTotals = ({
  lines, method, index, money, group, code, zipStatus, rideAlong = false,
}) => {
  let subtotal = 0;

  for (const { sku, qty } of lines) {
    const item = index.get(sku);

    if (item) subtotal += toCents(item.price) * qty;
  }

  const bulk = discountFor(subtotal, money);
  const byGroup = groupDiscountFor(subtotal, group, money);
  const byCode = codeDiscountFor(subtotal, code);
  const best = Math.max(
    bulk.amount, byGroup ? byGroup.amount : 0, byCode ? byCode.amount : 0
  );
  const useCode = !!byCode && byCode.amount === best && byCode.amount > 0;
  const useGroup = !useCode && !!byGroup && byGroup.amount > bulk.amount;
  // An empty cart owes nothing, whatever method is chosen: Delivery
  // is the starting choice, and a fee on nothing read as a $5 order.
  const isDelivery = method === "delivery" && subtotal > 0;
  const riding = isDelivery && !!rideAlong;
  const baseFee = isDelivery && !riding
    && subtotal < toCents(money.feeWaivedAt)
    ? toCents(money.deliveryFee)
    : 0;
  // A Rhode Island address outside the published towns pays a flat
  // charge on top, never waived: it covers the extra miles. A
  // ride-along drives none.
  const areaFee = isDelivery && !riding && zipStatus === "unlisted"
    ? toCents(money.outsideAreaFee || 0)
    : 0;
  const deliveryFee = baseFee + areaFee;

  const discountAmount = useCode
    ? byCode.amount
    : (useGroup ? byGroup.amount : bulk.amount);
  const discountLabel = useCode
    ? byCode.label
    : (useGroup
      ? `${byGroup.label} (${byGroup.percent}%)`
      : (bulk.tier ? `Bulk discount ($${bulk.tier}+)` : null));

  return {
    subtotal,
    discountTier: useCode || useGroup ? null : bulk.tier,
    discountGroup: useGroup ? byGroup.key : null,
    discountCode: useCode ? byCode.key : null,
    discountLabel,
    discountAmount,
    deliveryFee,
    areaFee,
    rideAlong: riding,
    total: subtotal - discountAmount + deliveryFee,
  };
};

// A ride-along has no minimum: the run is made whatever it carries.
export const meetsMinimum = (totals, money) => !!totals.rideAlong
  || totals.subtotal - totals.discountAmount
    >= toCents(money.deliveryMinimum);
