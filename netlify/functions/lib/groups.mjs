// Buying groups (#471): a group's members hold a private code that
// unlocks the group's pickup place, which is listed nowhere, and
// prices their orders by the group's member price list. The group
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

import { randomBytes, randomInt, timingSafeEqual } from "node:crypto";

import groupData from "../../../data/groups.json" with { type: "json" };
import locationData from "../../../data/locations.json" with {
  type: "json",
};
import seriesData from "../../../data/series.json" with { type: "json" };
import {
  occurrenceId, seriesDates,
} from "../../../assets/scripts/order/lib/events.mjs";
import {
  addDays, today,
} from "../../../assets/scripts/order/lib/zoned.mjs";
import { noteJoin } from "./group-log.mjs";
import { log } from "./log.mjs";
import { newPassCode } from "./passes.mjs";
import { qrSvg } from "./qr.mjs";
import {
  allOrders, getCustomer, paidTotal, refundedTotal, saveCustomer,
} from "./records.mjs";
import { siteUrl } from "./site.mjs";

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

// The name members see, set from the CLI without a deploy (James:
// the farm sets the name, the host and the code itself); the data
// file's name is the default. -> the record.
export const setGroupName = async (stores, key, name, {
  now = new Date(),
} = {}) => {
  if (!groupOf(key)) throw new Error(`Unknown group "${key}".`);

  const clean = String(name || "").trim().slice(0, 80);

  if (!clean) throw new Error("A name is needed.");

  const stored = (await getGroupRecord(stores, key)) || {
    key, code: null, codeSetAt: null, previous: [], host: null,
  };
  const record = { ...stored, name: clean, nameSetAt: now.toISOString() };

  await stores.orders.set(groupKey(key), record);

  return record;
};

// The join token (#495, James 6452457293): a long random value on the
// group's record, apart from the typed code, that the group's QR code
// carries to the sign-up page. Unguessable, so it needs no limit of
// its own past the misses. Replacing it retires the old QR code at
// once and leaves the code and the members as they are; the record
// keeps when, never the old tokens.
export const newJoinToken = () => randomBytes(32).toString("base64url");

const TOKEN = /^[A-Za-z0-9_-]{40,64}$/;

export const rotateJoinToken = async (stores, key, {
  now = new Date(), token = newJoinToken(),
} = {}) => {
  if (!groupOf(key)) throw new Error(`Unknown group "${key}".`);

  const stored = (await getGroupRecord(stores, key)) || {
    key, code: null, codeSetAt: null, previous: [], host: null,
  };
  const record = {
    ...stored,
    joinToken: token,
    joinTokenSetAt: now.toISOString(),
    joinTokensRetired: (stored.joinTokensRetired || 0)
      + (stored.joinToken ? 1 : 0),
  };

  await stores.orders.set(groupKey(key), record);

  return record;
};

// The token in force, minted the first time it is asked for.
export const joinTokenOf = async (stores, key, { now = new Date() } = {}) => {
  const record = await getGroupRecord(stores, key);

  if (record && record.joinToken) return record.joinToken;

  return (await rotateJoinToken(stores, key, { now })).joinToken;
};

const same = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));

  return x.length === y.length && timingSafeEqual(x, y);
};

// The group a join token opens, or null. Only the token in force.
export const findGroupByToken = async (stores, token) => {
  if (!TOKEN.test(String(token || ""))) return null;

  for (const g of GROUPS) {
    const record = await getGroupRecord(stores, g.key);

    if (record && record.joinToken && same(record.joinToken, token)) return g;
  }

  return null;
};

// The sign-up page's link, which the QR code encodes.
export const joinPath = (token) => `/join/?t=${encodeURIComponent(token)}`;

// The links whole, from SITE_URL as the emails build theirs: a phone
// opens only an absolute address, so a QR code or a link sent to the
// host never holds a bare path.
export const joinUrl = (token, env = process.env) =>
  `${siteUrl(env)}${joinPath(token)}`;

export const codeUrl = (code, env = process.env) =>
  `${siteUrl(env)}/order/?group=${encodeURIComponent(code)}`;

// The join QR code and the link it holds, for the Membership tab and
// `bin/nff groups qr`. `draw` is the encoder, swapped in tests.
export const joinQr = (token, name, {
  env = process.env, draw = qrSvg,
} = {}) => {
  const link = joinUrl(token, env);

  return { link, svg: draw(link, { title: `Join ${name}` }) };
};

// The group with the name the farm set on its record, if any.
export const namedGroup = async (stores, group) => {
  if (!group) return group;

  const record = await getGroupRecord(stores, group.key);

  return record && record.name ? { ...group, name: record.name } : group;
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

// The occurrence a round is: the group's series on that Sunday.
export const roundOccurrence = (group, round) =>
  occurrenceId(group.series, round);

// A walk-in buyer's details for the farm-made order: what the farm
// typed, else what the record has, else a placeholder the farm can
// fix with `customers set`. The email address is the one thing that
// must be real (James, 6424244841).
export const walkInCustomer = async (stores, email, {
  first, last, phone,
} = {}) => {
  const existing = (await getCustomer(stores, email)) || {};

  return {
    email,
    firstName: first || existing.firstName || "Walk-in",
    lastName: last || existing.lastName || "Customer",
    phone: phone || existing.phone || "",
    contact: "text",
  };
};

// The group's round today or next: the one its orders gather for.
export const nextRound = (group, terms, now = new Date()) =>
  roundFor(group, terms, today(now, terms.timeZone));

// The orders that fall in a round: every order tagged with the group
// and the round, whatever its status, newest first.
export const roundOrders = async (stores, key, round) =>
  (await allOrders(stores)).filter((o) => o.group && o.group.key === key
    && o.group.round === round);

// A round's orders added up, for the farm and the host: each member
// with what they ordered and paid, the pick list across the round,
// and the net total (paid less refunded, in cents), which the host
// reward will read. Pure, so the close can use it on a snapshot.
export const roundSummary = (orders) => {
  const members = new Map();
  const pick = new Map();
  let paid = 0;
  let refunded = 0;

  for (const o of orders) {
    const email = o.customer.email;
    const m = members.get(email) || {
      email, name: o.customer.name || "", orders: 0, lines: new Map(),
      paid: 0, refunded: 0, walkIn: false, cancelled: 0,
    };
    const took = paidTotal(o);
    const back = refundedTotal(o);

    m.orders += 1;
    m.paid += took;
    m.refunded += back;
    if (o.group && o.group.walkIn) m.walkIn = true;
    if (o.status === "cancelled") m.cancelled += 1;
    if (o.status !== "cancelled") {
      for (const l of o.lines) {
        const key = l.sku;
        const label = l.label || l.name || l.sku;

        m.lines.set(key, { sku: key, label,
          qty: ((m.lines.get(key) || {}).qty || 0) + l.qty });
        pick.set(key, { sku: key, label,
          qty: ((pick.get(key) || {}).qty || 0) + l.qty });
      }
    }
    paid += took;
    refunded += back;
    members.set(email, m);
  }

  const list = [...members.values()].map((m) => ({
    ...m, lines: [...m.lines.values()], net: m.paid - m.refunded,
  })).sort((a, b) => b.net - a.net || a.email.localeCompare(b.email));

  return {
    count: orders.length,
    members: list,
    pickList: [...pick.values()].sort((a, b) => a.sku.localeCompare(b.sku)),
    paid,
    refunded,
    net: paid - refunded,
  };
};

// The group whose rounds a change may offer (#495): the order's tag's
// only while the customer is still in that group, so a member removed
// can't move an order into a round; an untagged order, the customer's
// own group. A change stays priced by the tag's lock (lockGroupOf):
// member prices on a placed order never change.
export const offeredGroup = (tagged, member) => (tagged
  ? (member && member.key === tagged.key ? tagged : null)
  : member || null);

export const buyingFor = async (stores, order) => {
  const tagged = groupOf(order.group && order.group.key);
  const customer = await getCustomer(stores, order.customer.email);

  return offeredGroup(tagged, groupOf(memberKeyOf(customer)));
};

// The group whose price lock a change keeps: the order's tag's, member
// or not, else the group it is offered.
export const lockGroupOf = (order, buying) =>
  groupOf(order.group && order.group.key) || buying || null;

// The tag an order carries after a change (#471): the same group,
// its round following the order's new date; an order that has none
// and is a member's gains one. -> the tag, or the order's as it was.
export const retag = (order, group, terms, date) => {
  if (!group) return order.group || null;

  return {
    ...(order.group || { viaCode: false }),
    key: group.key,
    round: roundFor(group, terms, date),
  };
};

// The customer's group key from their record, or null.
export const memberKeyOf = (customer) => (customer && customer.memberGroup
  && typeof customer.memberGroup === "object"
  ? customer.memberGroup.id || null
  : null);

// Marks the customer a member of the group, once: a paid order with
// the code, or the CLI. -> the record, or null when there is none to
// mark (the order's touch comes first, so there always is).
//
// The member record is the customer's `memberGroup`: { id, joinedAt,
// via }, where `id` is the group's key. A membership ID and its QR code
// (James, 6452408603: later) go beside them as `memberId`, so nothing
// that reads the record today changes; leaving clears the whole of it.
//
// A customer is in one group at a time (#495, edge 2). Another
// group's code prices and places that one order, and never moves the
// membership: the refusal is logged, and the farm moves someone with
// `customers set member=`.
export const joinGroup = async (stores, email, key, {
  now = new Date(), via = "order",
} = {}) => {
  const customer = await getCustomer(stores, email);

  if (!customer) return null;

  const current = memberKeyOf(customer);

  if (current === key) return customer;
  if (current) {
    log.warn({ event: "group.switch_refused", group: key, member: current,
      via });
    await noteJoin(stores, {
      group: key, email: customer.email, via, now, event: "switch-refused",
      member: current,
    });

    return customer;
  }

  const saved = await saveCustomer(stores, {
    ...customer,
    memberGroup: { id: key, joinedAt: now.toISOString(), via },
    memberSince: customer.memberSince || now.toISOString(),
  });

  // The first join only (#495): every later call returned above.
  await noteJoin(stores, { group: key, email: customer.email, via, now });

  return saved;
};

export const leaveGroup = async (stores, email) => {
  const customer = await getCustomer(stores, email);

  if (!customer || !customer.memberGroup) return customer;

  return saveCustomer(stores, { ...customer, memberGroup: null });
};
