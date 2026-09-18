// Server-side validation. The browser runs the same checks for
// guidance, but this is the gate: nothing the client claims about
// money or dates is trusted.

import { datesFor } from "./dates.mjs";
import { computeTotals, meetsMinimum } from "./totals.mjs";

export const METHODS = ["onfarm", "scituate", "southcounty", "delivery"];

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

const text = (value, max = 200) =>
  typeof value === "string" ? value.trim().slice(0, max) : "";

const digits = (value) => text(value).replace(/\D/g, "");

export const phoneOk = (value) => {
  const d = digits(value);

  return d.length === 10 || (d.length === 11 && d.startsWith("1"));
};

// Approved ZIP passes; an unlisted ZIP with an in-state prefix warns
// and flags the order; anything else is blocked.
export const zipStatus = (zip, area) => {
  const z = digits(zip).slice(0, 5);

  if (z.length !== 5) return "invalid";

  for (const state of area.states) {
    for (const town of state.towns) {
      if (town.zips.includes(z)) return "approved";
    }
  }

  const nearby = area.warnPrefixes.some((p) => z.startsWith(p));

  return nearby ? "unlisted" : "outside";
};

const ACKS = ["policy", "area", "minimum", "cooler"];

// Returns { ok: true, order } or { ok: false, status, errors, dates? }.
export const validateOrder = (payload, { index, terms, now }) => {
  const errors = {};
  const p = payload && typeof payload === "object" ? payload : {};
  const customer = p.customer || {};
  const fulfilment = p.fulfilment || {};
  const money = terms.money;

  const name = text(customer.name, 120);
  const email = text(customer.email, 254).toLowerCase();
  const phone = text(customer.phone, 40);

  if (!name) errors["customer.name"] = "Please tell us your name.";
  if (!EMAIL.test(email)) {
    errors["customer.email"] = "That email address doesn't look right.";
  }
  if (phone && !phoneOk(phone)) {
    errors["customer.phone"] = "That phone number doesn't look right.";
  }

  const lines = [];
  const seen = new Set();

  for (const raw of Array.isArray(p.lines) ? p.lines : []) {
    const sku = text(raw && raw.sku, 40);
    const qty = Number(raw && raw.qty);
    const item = index.get(sku);

    if (!item || seen.has(sku)) continue;
    seen.add(sku);

    if (!Number.isInteger(qty) || qty < 1 || qty > 99) {
      errors[`lines.${sku}`] = "Quantities are whole numbers from 1 to 99.";
      continue;
    }
    if (!item.inStock) {
      errors[`lines.${sku}`] = `${item.groupLabel}, ${item.label} is sold out.`;
      continue;
    }

    lines.push({ sku, qty, item });
  }

  const lineErrors = Object.keys(errors).some((k) => k.startsWith("lines."));

  if (lines.length === 0 && !lineErrors) {
    errors.lines = "Add at least one item to your order.";
  }

  const method = text(fulfilment.method, 20);

  if (!METHODS.includes(method)) {
    errors["fulfilment.method"] = "Choose how you'd like to get your order.";
  } else if (method === "southcounty") {
    errors["fulfilment.method"] = "The South County drop site isn't open yet.";
  }

  const totals = computeTotals({ lines, method, index, money });
  const out = { customer: { name, email, phone }, method };

  if (method === "onfarm") {
    const f = fulfilment.onfarm || {};
    const window = text(f.window, 20);

    if (!["morning", "afternoon"].includes(window)) {
      errors["onfarm.window"] = "Morning or afternoon?";
    }
    if (!phoneOk(f.phone)) {
      errors["onfarm.phone"] = "We need a phone number for pickup.";
    }
    out.onfarm = { window, phone: text(f.phone, 40), textOk: !!f.textOk };
  }

  if (method === "delivery") {
    const f = fulfilment.delivery || {};
    const acks = f.acknowledgements || {};

    for (const key of ACKS) {
      if (acks[key] !== true) {
        errors["delivery.acknowledgements"] =
          "Please confirm all four delivery points.";
      }
    }
    if (!meetsMinimum(totals, money)) {
      errors["delivery.minimum"] =
        `Delivery orders are $${money.deliveryMinimum} or more after ` +
        "discounts. On-farm pickup and the Scituate drop site have no " +
        "minimum.";
    }

    const status = zipStatus(f.zip, terms.area);

    if (status === "invalid") {
      errors["delivery.zip"] = "Please enter a five-digit ZIP code.";
    } else if (status === "outside") {
      errors["delivery.zip"] = "That's outside our delivery range.";
    }
    if (!text(f.contactName)) errors["delivery.contactName"] = "Required.";
    if (!phoneOk(f.contactPhone)) {
      errors["delivery.contactPhone"] = "We need a number for delivery day.";
    }
    if (!text(f.address1)) errors["delivery.address1"] = "Required.";
    if (!text(f.town)) errors["delivery.town"] = "Required.";
    if (!text(f.cooler)) {
      errors["delivery.cooler"] = "Tell us where the cooler will be.";
    }

    out.delivery = {
      contactName: text(f.contactName, 120),
      contactPhone: text(f.contactPhone, 40),
      address1: text(f.address1, 200),
      address2: text(f.address2, 200),
      town: text(f.town, 100),
      zip: digits(f.zip).slice(0, 5),
      gate: text(f.gate, 100),
      cooler: text(f.cooler, 300),
      notes: text(f.notes, 1000),
      acknowledgements: Object.fromEntries(
        ACKS.map((k) => [k, acks[k] === true])
      ),
      zipStatus: status,
    };
  }

  // The chosen date must still be valid now, not when the page loaded.
  if (["onfarm", "scituate", "delivery"].includes(method)) {
    const dates = datesFor(method, now, terms);
    const date = text(fulfilment.date, 10);

    if (!dates.some((d) => d.date === date)) {
      const status = Object.keys(errors).length ? 422 : 409;

      return {
        ok: false,
        status,
        errors: {
          ...errors,
          "fulfilment.date": "That date is no longer available.",
        },
        dates,
      };
    }
    out.date = date;
  }

  if (Object.keys(errors).length) return { ok: false, status: 422, errors };

  const vote = p.vote || {};

  return {
    ok: true,
    order: {
      customer: out.customer,
      fulfilment: {
        method,
        date: out.date || null,
        onfarm: out.onfarm || null,
        delivery: out.delivery || null,
      },
      lines: lines.map(({ sku, qty, item }) => ({
        sku,
        label: `${item.groupLabel}, ${item.label}`,
        name: item.name,
        unitPrice: item.price,
        qty,
        lineTotal: qty * item.price,
        squareVariationId: item.squareVariationId || null,
      })),
      totals,
      notes: text(p.notes, 2000),
      source: text(p.source, 100),
      vote: {
        southCounty: text(vote.southCounty, 20),
        town: text(vote.town, 100),
      },
      flags: {
        zipUnlisted: !!(out.delivery && out.delivery.zipStatus === "unlisted"),
        totalMismatch: Number(p.claimedTotal) !== totals.total,
      },
    },
  };
};
