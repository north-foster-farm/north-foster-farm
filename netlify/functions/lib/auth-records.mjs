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
//   by-email/<sha256(email)>/<record key>   { at }
//
// `at` is when the index key was written (ms), so the sweep can leave
// one whose record putAuth is still writing (pruneIndex).
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

// A session stored under a hash of its id (lib/auth.mjs). One under any
// other key is from before that, and the sweep deletes it.
export const HASHED_SESSION = /^session\/[0-9a-f]{64}$/;

// An index key younger than this may belong to a record putAuth has
// not written yet, so the sweep leaves it.
export const INDEX_GRACE = 10 * 60_000;

const BATCH = 25;

// Runs `fn` over `items` in parallel batches of BATCH, so a scan of the
// store neither reads one key at a time nor all at once. -> the results.
export const inBatches = async (items, fn) => {
  const results = [];

  for (let i = 0; i < items.length; i += BATCH) {
    results.push(...await Promise.all(items.slice(i, i + BATCH).map(fn)));
  }

  return results;
};

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

  for (const email of names) {
    await stores.auth.set(indexKey(email, key), { at: Date.now() });
  }
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
// older code after a rollback. A session under its raw id is skipped:
// the id is live to anyone who reads its key, and the sweep deletes it.
// A report unless `apply`; each key written is logged with `by`, who
// ran it, the record's prefix and the address masked (mask.mjs, #496),
// never the record's key, which for a link is half of its secret. Safe
// to run twice. -> { apply, records, skipped, missing, written }
export const backfillIndex = async (stores, {
  apply = false, by = null,
} = {}) => {
  const report = { apply, records: 0, skipped: 0, missing: 0, written: 0 };

  for (const prefix of AUTH_PREFIXES) {
    const keys = [];

    for (const { key } of await stores.auth.list(prefix)) {
      if (prefix === "session/" && !HASHED_SESSION.test(key)) {
        report.skipped += 1;
      } else {
        keys.push(key);
      }
    }

    const records = await inBatches(keys,
      async (key) => ({ key, value: await stores.auth.get(key) }));

    for (const { key, value } of records) {
      if (!value) continue;
      report.records += 1;
      for (const email of namedBy(value)) {
        if (await stores.auth.get(indexKey(email, key))) continue;
        report.missing += 1;
        if (!apply) continue;
        await stores.auth.set(indexKey(email, key), { at: Date.now() });
        report.written += 1;
        log.info({
          event: "auth.index_backfilled", by, prefix: prefix.slice(0, -1),
          record: maskEmail(email), before: "absent", after: "present",
        });
      }
    }
  }
  if (apply) {
    log.info({
      event: "auth.index_backfill", by, records: report.records,
      skipped: report.skipped, written: report.written,
    });
  }

  return report;
};

// Deletes every stale index key older than INDEX_GRACE, read in
// parallel batches, for the auth sweep, which runs with the jobs every
// 15 minutes. One younger may be putAuth's, written just before its
// record, and is left for a later sweep. One with no `at` is from
// before it was stored and counts as old. -> how many.
export const pruneIndex = async (stores, { now = Date.now() } = {}) => {
  const keys = (await stores.auth.list(INDEX)).map(({ key }) => key);
  const pruned = await inBatches(keys, async (key) => {
    if (!await staleIndexKey(stores, key)) return 0;

    const { at } = await stores.auth.get(key) || {};

    if (Number.isFinite(at) && now - at < INDEX_GRACE) return 0;
    await stores.auth.delete(key);

    return 1;
  });

  return pruned.reduce((sum, n) => sum + n, 0);
};
