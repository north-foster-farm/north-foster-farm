// What the cart panel says about an order: the badges, the one-line
// nudge and the delivery status. Pure, so every sentence the customer
// might read is pinned by a test. Money is integer cents.

import { short } from "./catalog.mjs";
import { dollars, meetsMinimum, toCents } from "./totals.mjs";

// Badges in the order they are shown. Each is on or off, never a
// number that could disagree with the totals.
export const badges = (totals, money) => {
  const s = totals.subtotal;
  const list = [
    {
      key: "delivery",
      label: "Delivery",
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
// row that will appear, not an increment. Nothing at the top tier.
export const nudge = (totals, method, money) => {
  const s = totals.subtotal;
  const isDelivery = method === "delivery";

  if (s === 0) {
    return isDelivery
      ? `Delivery orders need a ${
        dollars(toCents(money.deliveryMinimum))} minimum.`
      : "";
  }

  if (isDelivery && !meetsMinimum(totals, money)) {
    const gap = toCents(money.deliveryMinimum) - (s - totals.discountAmount);

    return `Add ${dollars(gap)} to reach the ${
      dollars(toCents(money.deliveryMinimum))} delivery minimum.`;
  }

  const next = nextTierAbove(s, money);

  if (!next) return "";

  const gap = dollars(next.threshold - s);
  const off = dollars(next.off);
  const waivesFee = next.threshold === toCents(money.feeWaivedAt)
    && s < toCents(money.feeWaivedAt);

  if (waivesFee && (isDelivery || !method)) {
    return `Next discount: add ${gap} for ${off} off and free delivery.`;
  }

  return `Next discount: add ${gap} for ${off} off.`;
};

// The Delivery card's own warning, in red while delivery is chosen
// and the cart is short of the minimum after discounts, so the
// customer learns it at the choice and not at the last step.
export const deliveryShort = (totals, money) => {
  if (meetsMinimum(totals, money)) return "";

  const minimum = toCents(money.deliveryMinimum);
  const need = `You need ${dollars(minimum)} or more in your cart to use ` +
    "this option.";
  const gap = minimum - (totals.subtotal - totals.discountAmount);

  return totals.subtotal === 0 ? need : `${need} Add ${dollars(gap)} more.`;
};

// The fee cell: nothing outside delivery, the fee, or "Free".
export const feeCell = (totals, method) => {
  if (method !== "delivery") return { show: false };
  if (totals.deliveryFee === 0) {
    return { show: true, waived: true, text: "Free" };
  }

  return {
    show: true, waived: false, text: `+${dollars(totals.deliveryFee)}`,
  };
};

const plural = (n) => `${n} item${n === 1 ? "" : "s"}`;

// The cart's own lines, grouped by category in catalog order: each
// tier with how many at what price and the line's subtotal. `lines`
// is [{ sku, qty }] with qty > 0.
export const itemGroups = (lines, index) => {
  const groups = [];
  const byKey = new Map();

  for (const { sku, qty } of lines) {
    const item = index.get(sku);
    const unit = toCents(item.price);
    let group = byKey.get(item.groupKey);

    if (!group) {
      group = {
        key: item.groupKey, label: short(item.groupLabel), items: [],
      };
      byKey.set(item.groupKey, group);
      groups.push(group);
    }
    group.items.push({
      sku,
      label: item.label,
      qtyText: `${qty} × ${dollars(unit)}`,
      subtotal: dollars(qty * unit),
    });
  }

  return groups;
};

export const summarize = ({ totals, method, money, count, lines, index }) => ({
  count,
  countText: plural(count),
  groups: lines && index ? itemGroups(lines, index) : [],
  subtotal: dollars(totals.subtotal),
  discount: totals.discountAmount
    ? {
      label: totals.discountLabel || "Discount",
      text: `−${dollars(totals.discountAmount)}`,
    }
    : null,
  fee: feeCell(totals, method),
  total: dollars(totals.total),
  eligible: meetsMinimum(totals, money),
  badges: badges(totals, money),
  nudge: nudge(totals, method, money),
  // A delivery short of the minimum is a warning, not a nudge.
  nudgeTone: method === "delivery" && !meetsMinimum(totals, money)
    ? "warn" : "",
  deliveryShort: method === "delivery" ? deliveryShort(totals, money) : "",
});
