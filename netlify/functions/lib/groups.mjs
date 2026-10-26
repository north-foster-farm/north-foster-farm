// Buying groups (#471): a group's members hold a private code that
// unlocks the group's pickup place, which is listed nowhere, and
// prices their orders by the group's locked price list. The group
// itself is data (data/groups.json); its code is a record in the
// orders store under `group/<key>`, minted or set from the CLI, so a
// leaked code is replaced without a deploy. The code is checked on the
// server only: the page learns nothing of a group until a code is
// accepted, and an unknown code is answered like a wrong one.
//
// Membership is on the customer record as `memberGroup`, set when an
// order placed with the code is paid, or by `customers set
// member=<key>`. A member signed in needs no code: the account knows
// the group. A member not signed in types it, or follows the link
// `/order/?group=<code>`, which the page reads and takes off the
// address.

import { randomInt } from "node:crypto";

import groupData from "../../../data/groups.json" with { type: "json" };
import locationData from "../../../data/locations.json" with {
  type: "json",
};
import seriesData from "../../../data/series.json" with { type: "json" };
import { seriesDates } from "../../../assets/scripts/order/lib/events.mjs";
import { addDays } from "../../../assets/scripts/order/lib/zoned.mjs";
import { newPassCode } from "./passes.mjs";
import { getCustomer, saveCustomer } from "./records.mjs";

export const GROUPS = groupData.groups;

export const groupOf = (key) => GROUPS.find((g) => g.key === key) || null;

export const groupKey = (key) => `group/${key}`;

// Every code that fails says only this (James, 6424477473): nothing
// of whether a code exists, or what it would unlock.
export const INVALID_CODE = "That code isn't valid.";

// What the customer typed, as compared: upper case, letters and
// digits. A code shorter than six characters is not worth a lookup.
export const groupCodeOf = (value) => {
  const raw = String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "");

  return raw.length >= 6 && raw.length <= 40 ? raw : "";
};

// A code as the farm sets it by hand: 6 to 24 letters, digits and
// hyphens, kept as typed for the host to read out.
const CUSTOM = /^[A-Z0-9][A-Z0-9-]{4,22}[A-Z0-9]$/;

export const getGroupRecord = (stores, key) =>
  stores.orders.get(groupKey(key));

// Mints a code (XXXX-XXXX in the pass alphabet) or sets the one given,
// keeping the codes before it, dated, so the farm can see when a link
// stopped working. -> the record.
export const setGroupCode = async (stores, key, {
  code = null, now = new Date(), pick = randomInt,
} = {}) => {
  if (!groupOf(key)) throw new Error(`Unknown group "${key}".`);

  const next = code === null ? newPassCode(pick)
    : String(code).trim().toUpperCase();

  if (code !== null && !CUSTOM.test(next)) {
    throw new Error("A code is 6 to 24 letters, digits and hyphens.");
  }

  const at = now.toISOString();
  const stored = (await getGroupRecord(stores, key)) || {
    key, code: null, codeSetAt: null, previous: [], host: null,
  };
  const record = {
    ...stored,
    code: next,
    codeSetAt: at,
    previous: stored.code
      ? [...(stored.previous || []), { code: stored.code, until: at }]
      : stored.previous || [],
  };

  await stores.orders.set(groupKey(key), record);

  return record;
};

// The host's email address, for the reward and the walk-in sales;
// null clears it. Printed nowhere public. -> the record.
export const setGroupHost = async (stores, key, email, {
  now = new Date(),
} = {}) => {
  if (!groupOf(key)) throw new Error(`Unknown group "${key}".`);

  const stored = (await getGroupRecord(stores, key)) || {
    key, code: null, codeSetAt: null, previous: [], host: null,
  };
  const record = {
    ...stored,
    host: email ? String(email).trim().toLowerCase() : null,
    hostSetAt: now.toISOString(),
  };

  await stores.orders.set(groupKey(key), record);

  return record;
};

// The group a typed code unlocks, or null. Only the current code
// counts: a replaced one is as wrong as any other.
export const findGroupByCode = async (stores, typed) => {
  const wanted = groupCodeOf(typed);

  if (!wanted) return null;

  for (const g of GROUPS) {
    const record = await getGroupRecord(stores, g.key);

    if (record && record.code && groupCodeOf(record.code) === wanted) {
      return g;
    }
  }

  return null;
};

// The terms with the group's series offered (lib/dates.mjs).
export const memberTerms = (terms, group) => (group
  ? { ...terms, groups: [...(terms.groups || []), group.key] }
  : terms);

// The group's place and series as the page's model takes them: the
// raw data, which the page never embeds, served only with its code.
export const privatePlaces = (group) => ({
  locations: locationData.locations.filter((l) => l.code === group.location),
  series: seriesData.series.filter((s) => s.group === group.key),
});

// What the page is told of a group once its code is accepted: the
// name members see, the lock, and the places the model needs.
export const publicGroup = (group) => ({
  key: group.key,
  name: group.name,
  series: group.series,
  location: group.location,
  lockThrough: group.priceLock ? group.priceLock.through : null,
  lock: group.priceLock ? { prices: group.priceLock.prices } : null,
  places: privatePlaces(group),
});

// The round an order falls in (James, 6406932945): the group's first
// pickup day on or after the order's own date. A pickup at the group
// is its own round. null when the series has no day within a year.
export const roundFor = (group, terms, date) => {
  const s = terms.model.seriesOf(group.series);

  if (!s || !date) return null;

  return seriesDates(s, date, addDays(date, 366))[0] || null;
};

// The customer's group key from their record, or null.
export const memberKeyOf = (customer) => (customer && customer.memberGroup
  && typeof customer.memberGroup === "object"
  ? customer.memberGroup.id || null
  : null);

// Marks the customer a member of the group, once: a paid order with
// the code, or the CLI. -> the record, or null when there is none to
// mark (the order's touch comes first, so there always is).
export const joinGroup = async (stores, email, key, {
  now = new Date(), via = "order",
} = {}) => {
  const customer = await getCustomer(stores, email);

  if (!customer) return null;
  if (memberKeyOf(customer) === key) return customer;

  return saveCustomer(stores, {
    ...customer,
    memberGroup: { id: key, joinedAt: now.toISOString(), via },
    memberSince: customer.memberSince || now.toISOString(),
  });
};

export const leaveGroup = async (stores, email) => {
  const customer = await getCustomer(stores, email);

  if (!customer || !customer.memberGroup) return customer;

  return saveCustomer(stores, { ...customer, memberGroup: null });
};
