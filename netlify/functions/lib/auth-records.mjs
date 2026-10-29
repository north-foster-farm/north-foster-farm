// The sign-in records of the auth store, found by customer (#508).
// Sessions, sign-in links, farm-news sign-ups and unsubscribe links
// are keyed by a hash of their secret, so the only way to find one
// address's records used to be reading every one. An email change
// did that inside a request, and slowed with every session anyone
// had (14.5 s on staging, 2026-10-28). Now every record also has an
// index key under each address it names, written before it and
// deleted after it, so a rename or a deletion lists one prefix.
//
// Store layout (the `auth` store), beside lib/auth.mjs's:
//   by-email/<sha256(email)>/<record key>   {}
//
// A record names its `email`, and an email-change link also the
// address it moves from (`changeFrom`). Every write and delete of a
// record under AUTH_PREFIXES goes through putAuth and deleteAuth;
// test/auth-records.test.mjs fails on one that doesn't.

import { createHash } from "node:crypto";

export const AUTH_PREFIXES = ["session/", "token/", "unsub/", "news/"];
export const INDEX = "by-email/";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const address = (email) => String(email || "").trim().toLowerCase();

export const indexPrefix = (email) => `${INDEX}${hash(address(email))}/`;
export const indexKey = (email, key) => `${indexPrefix(email)}${key}`;

// The addresses a record is found by.
export const namedBy = (value) => (value && typeof value === "object"
  ? [...new Set([value.email, value.changeFrom].filter(Boolean)
    .map(address))]
  : []);

// Writes a record and its index keys, the index first, so a record is
// never there without one. `before`, the record as it was, drops the
// index keys of an address it no longer names (a rename).
export const putAuth = async (stores, key, value, { before = null } = {}) => {
  const names = namedBy(value);

  for (const email of names) await stores.auth.set(indexKey(email, key), {});
  await stores.auth.set(key, value);
  for (const email of namedBy(before)) {
    if (!names.includes(email)) await stores.auth.delete(indexKey(email, key));
  }
};

// Deletes a record, then its index keys. `value` is the record when
// the caller has just read it; otherwise it is read here.
export const deleteAuth = async (stores, key, value) => {
  const found = value === undefined ? await stores.auth.get(key) : value;

  await stores.auth.delete(key);
  for (const email of namedBy(found)) {
    await stores.auth.delete(indexKey(email, key));
  }
};

// -> [{ key, value }], the records under `prefixes` that name `email`,
// read from its index alone and in parallel. An index key left by a
// write cut short (its record gone, or no longer naming the address)
// is skipped here and deleted by the sweep (records.sweepAuth).
export const authRecordsFor = async (stores, email, {
  prefixes = AUTH_PREFIXES,
} = {}) => {
  const who = address(email);
  const base = indexPrefix(who);
  const keys = (await stores.auth.list(base))
    .map(({ key }) => key.slice(base.length))
    .filter((key) => prefixes.some((p) => key.startsWith(p)));
  const found = await Promise.all(keys.map(async (key) => ({
    key, value: await stores.auth.get(key),
  })));

  return found.filter(({ value }) => namedBy(value).includes(who));
};

// An index key whose record is gone or no longer names its address.
// -> true when `key` (under INDEX) is one.
export const staleIndexKey = async (stores, key) => {
  const [, digest, ...rest] = key.split("/");
  const value = await stores.auth.get(rest.join("/"));

  return !namedBy(value).some((email) => hash(email) === digest);
};

// Deletes every stale index key, for the daily sweep. -> how many.
export const pruneIndex = async (stores) => {
  let pruned = 0;

  for (const { key } of await stores.auth.list(INDEX)) {
    if (await staleIndexKey(stores, key)) {
      await stores.auth.delete(key);
      pruned += 1;
    }
  }

  return pruned;
};
