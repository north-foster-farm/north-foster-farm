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

// `lines` is [{ sku, qty }]; `index` is indexCatalog(catalog).
export const computeTotals = ({ lines, method, index, money }) => {
  let subtotal = 0;

  for (const { sku, qty } of lines) {
    const item = index.get(sku);

    if (item) subtotal += toCents(item.price) * qty;
  }

  const discount = discountFor(subtotal, money);
  const isDelivery = method === "delivery";
  const deliveryFee = isDelivery && subtotal < toCents(money.feeWaivedAt)
    ? toCents(money.deliveryFee)
    : 0;

  return {
    subtotal,
    discountTier: discount.tier,
    discountAmount: discount.amount,
    deliveryFee,
    total: subtotal - discount.amount + deliveryFee,
  };
};

export const meetsMinimum = (totals, money) =>
  totals.subtotal - totals.discountAmount >= toCents(money.deliveryMinimum);
