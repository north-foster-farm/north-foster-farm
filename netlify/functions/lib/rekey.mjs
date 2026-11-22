// Records stored under a key that names a different address from
// their own (#758). Before lib/blob-key.mjs, a key went into the
// request path raw, and one Blobs route read a "+" in it as a space:
// a record the functions wrote for pat+dog@... could sit where the
// CLI read it only as "pat dog@...". This finds every customer record
// whose key is not customerKey(its own address), with the entries
// keyed by that same wrong address (its cart, credit and support
// messages), and every order index entry whose key is not
// byEmailKey(its order's address), and moves each to the right key.
//
// `apply` false only reports. A move whose right key already holds a
// record is refused and reported, never overwritten. Each move is
// logged (lib/log.mjs adds the time): who, the store, and the key
// before and after, masked (#496), as `before` and `after`, since the
// log removes any field named `from` or `to`.

import { inBatches } from "./auth-records.mjs";
import { creditKey } from "./credit.mjs";
import { log } from "./log.mjs";
import {
  byEmailKey, cartKey, customerKey, getOrder,
} from "./records.mjs";
import { maskKey } from "./store.mjs";

const CUSTOMER = "customer/";
const BY_EMAIL = "by-email/";

// The customer records under a wrong key -> [{ from, to, wrong, right }]
// with `wrong` the address the key names and `right` the record's.
const misplacedCustomers = async (stores) => {
  const keys = (await stores.customers.list(CUSTOMER)).map((e) => e.key);
  const found = await inBatches(keys, async (key) => {
    const record = await stores.customers.get(key);

    if (!record || !record.email) return null;

    const to = customerKey(record.email);

    return to === key ? null : {
      from: key, to, wrong: key.slice(CUSTOMER.length),
      right: to.slice(CUSTOMER.length),
    };
  });

  return found.filter(Boolean);
};

// The order index entries under a wrong address -> [{ from, to }].
const misplacedOrderIndex = async (stores) => {
  const keys = (await stores.orders.list(BY_EMAIL)).map((e) => e.key);
  const found = await inBatches(keys, async (key) => {
    const order = await getOrder(stores, key.split("/").pop());
    const email = order && order.customer && order.customer.email;

    if (!email) return null;

    const to = byEmailKey(email, order.id);

    return to === key ? null : { from: key, to };
  });

  return found.filter(Boolean);
};

// Every move, each { store, from, to }: a customer's record first, then
// what its wrong address also keys, then the order index.
export const plannedMoves = async (stores) => {
  const moves = [];

  for (const c of await misplacedCustomers(stores)) {
    moves.push({ store: "customers", from: c.from, to: c.to });
    for (const [from, to] of [
      [cartKey(c.wrong), cartKey(c.right)],
      [creditKey(c.wrong), creditKey(c.right)],
    ]) {
      // A cart or credit the wrong address holds; `from` equals `to`
      // only when the two addresses differ by case alone.
      if (from !== to && await stores.customers.get(from) !== null) {
        moves.push({ store: "customers", from, to });
      }
    }
    for (const { key } of await stores.customers.list(
      `support/${c.wrong}/`
    )) {
      moves.push({
        store: "customers", from: key,
        to: `support/${c.right}/${key.split("/").pop()}`,
      });
    }
  }
  for (const m of await misplacedOrderIndex(stores)) {
    moves.push({ store: "orders", ...m });
  }

  return moves;
};

// -> { apply, moved: [{ store, from, to }], refused: [...] }, keys
// masked, so the report can be pasted where the log line could go.
export const rekeyRecords = async (stores, {
  apply = false, by = "cli",
} = {}) => {
  const moved = [];
  const refused = [];
  const shown = (m) => ({
    store: m.store, from: maskKey(m.from), to: maskKey(m.to),
  });

  for (const m of await plannedMoves(stores)) {
    const store = stores[m.store];

    if (await store.get(m.to) !== null) {
      refused.push({ ...shown(m), why: "the right key holds a record" });
      continue;
    }
    if (apply) {
      const value = await store.get(m.from);

      if (!await store.create(m.to, value)) {
        refused.push({ ...shown(m), why: "the right key holds a record" });
        continue;
      }
      await store.delete(m.from);
      log.info({
        event: "store.rekeyed", by, store: m.store,
        before: maskKey(m.from), after: maskKey(m.to),
      });
    }
    moved.push(shown(m));
  }

  return { apply, moved, refused };
};
