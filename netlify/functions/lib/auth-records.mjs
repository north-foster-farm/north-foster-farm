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

import { log } from "./log.mjs";
import { maskEmail } from "./mask.mjs";

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

// `bin/nff auth backfill-index`: an index key for every record that
// lacks one, for the records written before the index (#508) or by
// older code after a rollback. A report unless `apply`; each key
// written is logged with `by`, who ran it, and the address masked
// (mask.mjs, #496). Safe to run twice. -> { apply, records, missing,
// written }
export const backfillIndex = async (stores, {
  apply = false, by = null,
} = {}) => {
  const report = { apply, records: 0, missing: 0, written: 0 };
  const BATCH = 25;

  for (const prefix of AUTH_PREFIXES) {
    const keys = (await stores.auth.list(prefix)).map(({ key }) => key);

    for (let i = 0; i < keys.length; i += BATCH) {
      const batch = await Promise.all(keys.slice(i, i + BATCH)
        .map(async (key) => ({ key, value: await stores.auth.get(key) })));

      for (const { key, value } of batch) {
        if (!value) continue;
        report.records += 1;
        for (const email of namedBy(value)) {
          if (await stores.auth.get(indexKey(email, key))) continue;
          report.missing += 1;
          if (!apply) continue;
          await stores.auth.set(indexKey(email, key), {});
          report.written += 1;
          log.info({
            event: "auth.index_backfilled", by, key,
            record: maskEmail(email), before: "absent", after: "present",
          });
        }
      }
    }
  }
  if (apply) {
    log.info({
      event: "auth.index_backfill", by, records: report.records,
      written: report.written,
    });
  }

  return report;
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
