// The key segment of every address-keyed record (#758): customers,
// carts, credit, support messages and the orders-by-address index.
// Netlify's two Blobs routes disagree on an encoded path (the
// functions' route decodes it, the API route keeps "%40" as text), and
// the functions' route reads a raw "+" as a space, so no form of the
// address itself names the same blob on both. A record is keyed by
// base64url(SHA-256(normalized address)) instead, no padding: 43
// letters, digits, "-" and "_", the same on every route. The value
// keeps the address, so listing and showing work as before. It keeps
// addresses out of URLs and request logs; it is no protection against
// anyone with access to the store.
//
// Records written before the switch sit under the address itself, or,
// for a "+", under the space the functions' route made of it. Reads
// try the hashed key first and then those (`addressSegments`); a write
// always goes to the hashed key. `bin/nff customers rekey`
// (lib/rekey.mjs) moves the old ones, and the fallback goes once every
// record has moved.

import { createHash } from "node:crypto";

import { log } from "./log.mjs";
import { maskKey } from "./store.mjs";

export const normalAddress = (email) =>
  String(email || "").trim().toLowerCase();

export const addressHash = (email) => createHash("sha256")
  .update(normalAddress(email)).digest("base64url");

// Whether a key segment is a hashed address rather than an address.
export const HASHED = /^[A-Za-z0-9_-]{43}$/;

// The segments an address's records may sit under, the hashed one
// first: then the address, and the space form of its "+"s.
export const addressSegments = (email) => {
  const address = normalAddress(email);
  const spaced = address.replaceAll("+", " ");

  return [...new Set([addressHash(address), address, spaced])];
};

// The address an old, unhashed segment names: a space in one is a "+"
// the functions' route read as a space, since an address has none.
export const segmentAddress = (segment) =>
  normalAddress(String(segment).replaceAll(" ", "+"));

// The first record found for `email` under `kind/<segment>`, hashed
// first. -> { key, value } or null.
export const findAddressed = async (store, kind, email) => {
  for (const segment of addressSegments(email)) {
    const key = `${kind}/${segment}`;
    const value = await store.get(key);

    if (value !== null && value !== undefined) return { key, value };
  }

  return null;
};

export const readAddressed = async (store, kind, email) => {
  const found = await findAddressed(store, kind, email);

  return found ? found.value : null;
};

// Deletes the record under every segment, so nothing is left behind
// under an old key. `rest` follows the segment: `/<id>` for an index
// entry.
export const deleteAddressed = async (store, kind, email, rest = "") => {
  for (const segment of addressSegments(email)) {
    await store.delete(`${kind}/${segment}${rest}`);
  }
};

// Logs one leftover taken out: an old key whose record the hashed key
// has replaced. `by` is who acted.
const dropped = (key, by) => log.info({
  event: "store.leftover-deleted", by, store: "customers",
  before: maskKey(key), after: null,
});

// Deletes `kind/<segment>` under each old segment of `email`, after a
// write to its hashed key has succeeded, so no stale twin of a
// single-key record (customer, cart, credit) stays for a list to find
// (#758, qa on #787). -> how many it deleted.
export const dropOldForms = async (store, kind, email, {
  by = "site",
} = {}) => {
  let n = 0;

  for (const segment of addressSegments(email).slice(1)) {
    const key = `${kind}/${segment}`;

    if (await store.get(key) === null) continue;
    await store.delete(key);
    dropped(key, by);
    n++;
  }

  return n;
};

// A listed key -> { key, value } as stored, or null. @netlify/blobs
// hands back the key the server lists, verbatim (Store
// formatListResultBlob, 11.1.0), and staging lists a record that
// answers only to "james dog@..." as "james+dog@..." (the
// coordinator's read-only check, 2026-11-21, #758). So the listed key
// is not always the stored one: when it misses, its "+"s read as
// spaces name the record.
export const storedAs = async (store, listed) => {
  const value = await store.get(listed);

  if (value !== null) return { key: listed, value };

  const decoded = listed.replaceAll("+", " ");
  const found = decoded === listed ? null : await store.get(decoded);

  return found === null ? null : { key: decoded, value: found };
};

// Every record of a single-key kind (customer, cart, credit), one per
// address: where a hashed record and an old one name the same address,
// the hashed one wins, since every write since the switch goes to it,
// and the old one is deleted and logged. Of two old forms with no
// hashed twin, the first listed is kept and the other ignored.
// -> [{ key, value }]
export const listLatest = async (store, kind, { by = "site" } = {}) => {
  const prefix = `${kind}/`;
  const listed = await store.list(prefix);
  const found = (await Promise.all(listed.map(({ key }) =>
    storedAs(store, key)))).filter(Boolean);
  const hashed = new Set(found
    .filter(({ key }) => HASHED.test(key.slice(prefix.length)))
    .map(({ key }) => key));
  const seen = new Set();
  const out = [];

  for (const record of found) {
    const segment = record.key.slice(prefix.length);

    if (HASHED.test(segment)) {
      out.push(record);
      continue;
    }

    const own = record.value && record.value.email;
    const twin = `${prefix}${addressHash(own || segmentAddress(segment))}`;

    if (hashed.has(twin)) {
      await store.delete(record.key);
      dropped(record.key, by);
    } else if (!seen.has(twin)) {
      seen.add(twin);
      out.push(record);
    }
  }

  return out;
};

// The keys listed under `kind/<segment>/` for every segment, hashed
// first. -> [{ key }]
export const listAddressed = async (store, kind, email) => {
  const out = [];

  for (const segment of addressSegments(email)) {
    out.push(...await store.list(`${kind}/${segment}/`));
  }

  return out;
};
