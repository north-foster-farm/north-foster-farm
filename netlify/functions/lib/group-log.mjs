// A buying group's two logs (#495, part 3), in the orders store beside
// the group's record. Both are append-only: a record is written once
// and never edited, except that deleting a customer's details
// (lib/forget.mjs) takes their address off every record that names it.
//
//   group-join/<key>/<time>-<random>   a first join, or a refused one
//     { group, email, at, via, event, backfilled? }
//   group-log/<key>/<time>-<random>    a host's, member's or farm's act
//     { group, at, by: { role, email? }, action, target, before, after }
//
// The join log is written by joinGroup (lib/groups.mjs) on the first
// join only, so typing the code again adds nothing, with the path the
// member came by (JOIN_PATHS). A join another group's code would have
// made is logged as refused (edge 2). Members from before the log are
// added once by `bin/nff groups members <key> --backfill`.
//
// The audit log has one record per action: who acted (the host, the
// member, or the farm by the CLI), what they did, to whom, and the
// values before and after. The farm reads both logs with `bin/nff
// groups members` and `groups log`. Neither is shown to anyone else.

import { randomBytes } from "node:crypto";

import { allCustomers } from "./records.mjs";

// How a member came to the group. `order` and `account` are older
// records' paths, kept as they were written.
export const JOIN_PATHS = [
  "code", "link", "qr", "walk-in", "farm", "host", "invite",
];

// Who acts on a group: its host on the Membership tab, a member
// leaving, or the farm through bin/nff.
export const ROLES = ["host", "member", "farm"];

// A key that sorts by time, then by order of writing within one
// instance (two acts in the same millisecond), with no characters
// Blobs could mind.
let written = 0;

const stamp = (at) => {
  written += 1;

  return `${at.replace(/[:.]/g, "-")}-${String(written).padStart(8, "0")}-${
    randomBytes(4).toString("hex")}`;
};

export const joinKey = (key, at) => `group-join/${key}/${stamp(at)}`;
export const logKey = (key, at) => `group-log/${key}/${stamp(at)}`;

// Oldest first: the list is sorted by key, which starts with the time.
const listAll = async (stores, prefix) => {
  const keys = await stores.orders.list(prefix);
  const found = await Promise.all(keys.map((k) => stores.orders.get(k.key)));

  return found.filter(Boolean);
};

// One line in the join log. `event` is "join", or "switch-refused"
// when another group's code would have moved the member.
export const noteJoin = async (stores, {
  group, email, via, now = new Date(), event = "join", backfilled = false,
  member = null,
}) => {
  const at = now.toISOString();
  const record = {
    group, email, at, via, event,
    ...(member ? { member } : {}),
    ...(backfilled ? { backfilled: true } : {}),
  };

  await stores.orders.set(joinKey(group, at), record);

  return record;
};

export const joinLog = (stores, key) => listAll(stores, `group-join/${key}/`);

// One record of an act on the group. `by` is { role, email? }; the
// farm acts by the CLI and has no address here.
export const audit = async (stores, {
  group, by, action, target = null, before = null, after = null,
  now = new Date(),
}) => {
  if (!by || !ROLES.includes(by.role)) {
    throw new Error(`Who acted is one of: ${ROLES.join(", ")}.`);
  }

  const at = now.toISOString();
  const record = {
    group, at,
    by: by.email ? { role: by.role, email: by.email } : { role: by.role },
    action, target, before, after,
  };

  await stores.orders.set(logKey(group, at), record);

  return record;
};

export const auditLog = (stores, key) => listAll(stores, `group-log/${key}/`);

// The group's members as they stand: each customer whose record says
// they are in it, with how they came, oldest first. The record is the
// truth; the join log only says how a member came when the record
// does not.
export const groupMembers = async (stores, key) => {
  const customers = (await allCustomers(stores)).filter((c) =>
    c.memberGroup && typeof c.memberGroup === "object"
    && c.memberGroup.id === key);
  const joins = new Map();

  for (const j of await joinLog(stores, key)) {
    if (j.event === "join" && !joins.has(j.email)) joins.set(j.email, j);
  }

  return customers.map((c) => {
    const join = joins.get(c.email);

    return {
      email: c.email,
      firstName: c.firstName || "",
      lastName: c.lastName || "",
      name: c.name || [c.firstName, c.lastName].filter(Boolean).join(" "),
      joinedAt: c.memberGroup.joinedAt || (join && join.at) || null,
      via: c.memberGroup.via || (join && join.via) || null,
      logged: !!join,
    };
  }).sort((a, b) => String(a.joinedAt).localeCompare(String(b.joinedAt))
    || a.email.localeCompare(b.email));
};

// A join line for each member on record with none: those who joined
// before the log. Dated as they joined, and marked. With `apply`
// false, only says who would be added. -> the members added.
export const backfillJoins = async (stores, key, { apply = false } = {}) => {
  const missing = (await groupMembers(stores, key)).filter((m) => !m.logged);

  if (apply) {
    for (const m of missing) {
      await noteJoin(stores, {
        group: key, email: m.email, via: m.via || "code",
        now: new Date(m.joinedAt || Date.now()), backfilled: true,
      });
    }
  }

  return missing;
};

// Whether a value holds the address anywhere in it.
const names = (value, email) => (typeof value === "string"
  ? value === email
  : !!value && typeof value === "object"
    && Object.values(value).some((v) => names(v, email)));

// The value with the address blanked wherever it is.
const without = (value, email) => {
  if (typeof value === "string") return value === email ? "" : value;
  if (Array.isArray(value)) return value.map((v) => without(v, email));
  if (!value || typeof value !== "object") return value;

  return Object.fromEntries(Object.entries(value)
    .map(([k, v]) => [k, without(v, email)]));
};

// The keys of the log records that name an address, for
// lib/forget.mjs: a join's member, an act's actor, target, or a value
// before or after (a host's address).
export const namingKeys = async (stores, email) => {
  const named = [];

  for (const prefix of ["group-join/", "group-log/"]) {
    for (const { key } of await stores.orders.list(prefix)) {
      if (names(await stores.orders.get(key), email)) named.push(key);
    }
  }

  return named;
};

// The same record with the address gone: the act and its date stay
// for the farm's audit, the person does not.
export const scrubbed = (record, email) => ({
  ...without(record, email), forgotten: true,
});
