// Address-keyed records still under a key from before #758's key
// scheme (lib/address-key.mjs): the address itself, or the space the
// functions' Blobs route made of a "+" in it. This finds every
// customer record, cart, credit ledger, support message and
// orders-by-address index entry whose address segment is not a hash,
// and moves each to the key the hash of its address names.
//
// `apply` false only reports. A record whose hashed key already holds
// one is never moved over it: it is deleted as a leftover when it is a
// copy of that one or older by the times both carry, and otherwise
// refused and reported. Nothing is overwritten. Each move and
// deletion is logged (lib/log.mjs adds the time): who, the store, and the key
// before and after, masked (#496), as `before` and `after`, since the
// log removes any field named `from` or `to`. The report itself names
// the keys in full, for the farm's terminal.

import { isDeepStrictEqual } from "node:util";

import {
  HASHED, addressHash, normalAddress, segmentAddress, storedAs,
} from "./address-key.mjs";
import { log } from "./log.mjs";
import { maskKey } from "./store.mjs";

// Each address-keyed kind, by store, and whether its value carries
// the address (which then wins over the key's).
const KINDS = [
  ["customers", "customer", true],
  ["customers", "cart", false],
  ["customers", "credit", true],
  ["customers", "support", true],
  ["orders", "by-email", false],
];

export { storedAs };

// Every move, each { store, from, to }, kind by kind.
export const plannedMoves = async (stores) => {
  const moves = [];

  for (const [name, kind, carries] of KINDS) {
    const store = stores[name];
    const prefix = `${kind}/`;

    for (const { key: listed } of await store.list(prefix)) {
      if (HASHED.test(listed.slice(prefix.length).split("/")[0])) continue;

      const stored = await storedAs(store, listed);

      if (!stored) continue;

      const rest = stored.key.slice(prefix.length);
      const segment = rest.split("/")[0];
      const tail = rest.slice(segment.length);
      const own = carries && stored.value && stored.value.email;
      const address = own ? normalAddress(own) : segmentAddress(segment);

      if (!address) continue;
      moves.push({
        store: name, from: stored.key,
        to: `${prefix}${addressHash(address)}${tail}`,
      });
    }
  }

  return moves;
};

// When a record says it was last written: a cart's `savedAt`, or the
// latest grant, spend or void on a credit ledger. -> ms, or null.
const writtenAt = (value) => {
  const v = value || {};
  const times = [v.savedAt, ...(v.entries || []).flatMap((e) => [
    e.grantedAt, ...(e.spent || []).map((x) => x.at),
    ...(e.voided || []).map((x) => x.at),
  ])].map((at) => (typeof at === "number" ? at : Date.parse(at)))
    .filter(Number.isFinite);

  return times.length ? Math.max(...times) : null;
};

// Whether the old record is a leftover of the one at its hashed key: a
// copy of it, or older by the times both carry. A customer record
// carries no such time, so one that differs from its twin is refused
// here (perk-remove criterion 4) and cleaned instead by the first save
// or list of it (lib/address-key.mjs), where the hashed one wins.
const leftover = (old, twin) => {
  if (isDeepStrictEqual(old, twin)) return true;

  const a = writtenAt(old);
  const b = writtenAt(twin);

  return a !== null && b !== null && b >= a;
};

// -> { apply, moved: [{ store, from, to }], cleaned: [{ store, from,
// to }], refused: [{ ..., why }] }. `cleaned` is an old record whose
// hashed twin replaced it (#758, qa on #787): deleted, not moved.
export const rekeyRecords = async (stores, {
  apply = false, by = "cli",
} = {}) => {
  const moved = [];
  const cleaned = [];
  const refused = [];
  const held = "the hashed key holds a record";

  for (const m of await plannedMoves(stores)) {
    const store = stores[m.store];
    const twin = await store.get(m.to);

    if (twin !== null) {
      if (!leftover(await store.get(m.from), twin)) {
        refused.push({ ...m, why: held });
        continue;
      }
      if (apply) {
        await store.delete(m.from);
        log.info({
          event: "store.leftover-deleted", by, store: m.store,
          before: maskKey(m.from), after: null,
        });
      }
      cleaned.push(m);
      continue;
    }
    if (apply) {
      const value = await store.get(m.from);

      if (!await store.create(m.to, value)) {
        refused.push({ ...m, why: held });
        continue;
      }
      await store.delete(m.from);
      log.info({
        event: "store.rekeyed", by, store: m.store,
        before: maskKey(m.from), after: maskKey(m.to),
      });
    }
    moved.push(m);
  }

  return { apply, moved, cleaned, refused };
};
