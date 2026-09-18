// What the cart panel says about an order: the badges, the one-line
// nudge and the delivery status. Pure, so every sentence the customer
// might read is pinned by a test. Money is integer cents.

import { discountFor, dollars, meetsMinimum, toCents } from "./totals.mjs";

const BIGGEST = (off) => `That's our biggest discount: ${dollars(off)} off.`;

// Badges in the order they are shown. Each is on or off, never a
// number that could disagree with the totals.
export const badges = (totals, money) => {
  const s = totals.subtotal;
  const list = [
    {
      key: "delivery",
      label: "Local delivery",
      on: meetsMinimum(totals, money),
    },
  ];

  for (const tier of money.bulkTiers) {
    list.push({
      key: `tier-${tier.threshold}`,
      label: `$${tier.threshold}+`,
      on: s >= toCents(tier.threshold),
    });
  }

  list.push({
    key: "free-delivery",
    label: "Free delivery",
    on: s >= toCents(money.feeWaivedAt),
  });

  return list;
};

// The next bulk tier above the subtotal, or null at the top.
const nextTierAbove = (subtotal, money) => {
  for (const tier of money.bulkTiers) {
    const threshold = toCents(tier.threshold);

    if (subtotal < threshold) return { threshold, off: toCents(tier.off) };
  }

  return null;
};

// One sentence, or none. Every figure is what the customer will see in
// the breakdown once they act on it: "take $10 off" is the discount
// row that will appear, not an increment.
export const nudge = (totals, method, money) => {
  const s = totals.subtotal;

  if (s === 0) return "";

  const isDelivery = method === "delivery";

  if (isDelivery && !meetsMinimum(totals, money)) {
    const gap = toCents(money.deliveryMinimum) - (s - totals.discountAmount);

    return `Add ${dollars(gap)} to reach the ${
      dollars(toCents(money.deliveryMinimum))} delivery minimum.`;
  }

  const next = nextTierAbove(s, money);

  if (!next) {
    return BIGGEST(discountFor(s, money).amount);
  }

  const gap = dollars(next.threshold - s);
  const off = dollars(next.off);
  const waivesFee = next.threshold === toCents(money.feeWaivedAt)
    && s < toCents(money.feeWaivedAt);

  if (waivesFee && (isDelivery || !method)) {
    return `Add ${gap} and we'll take ${off} off, and delivery is free.`;
  }

  return `Add ${gap} and we'll take ${off} off.`;
};

// The fee cell: nothing outside delivery, the fee, or a struck fee.
export const feeCell = (totals, method, money) => {
  if (method !== "delivery") return { show: false };
  if (totals.deliveryFee === 0) {
    return {
      show: true, waived: true, was: dollars(toCents(money.deliveryFee)),
    };
  }

  return {
    show: true, waived: false, text: `+${dollars(totals.deliveryFee)}`,
  };
};

const plural = (n) => `${n} item${n === 1 ? "" : "s"}`;

export const summarize = ({ totals, method, money, count }) => ({
  count,
  countText: count === 0 ? "Nothing yet" : plural(count),
  subtotal: dollars(totals.subtotal),
  discount: totals.discountAmount
    ? {
      label: totals.discountLabel || "Discount",
      text: `−${dollars(totals.discountAmount)}`,
    }
    : null,
  fee: feeCell(totals, method, money),
  total: dollars(totals.total),
  eligible: meetsMinimum(totals, money),
  badges: badges(totals, money),
  nudge: nudge(totals, method, money),
});
