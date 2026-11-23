// Criteria tests for #967, phase 4 of untangling the server
// libraries' import cycles (#925, docs/refactors/server-cycles.md):
// "Moves holderOf to holder.mjs (amend.mjs re-exports it), cutoffAt
// to cutoff.mjs (jobs.mjs re-exports it), and paymentPending,
// PENDING_MS and pendingKey to pay-pending.mjs, which exports all
// three (farm-orders.mjs re-exports the first two and imports
// pendingKey for its claim helpers). account.mjs and admin.mjs import
// from the new homes."
//
// One test per box marked (test), named for the box, written before
// the implementation. The two (guard) boxes are checks that already
// exist: account.test, account-change-holder.test, admin.test,
// amend.test, jobs.test, farm-orders.test, edit.test and
// edit-switch-cancel.test, and the dependency-cruiser baseline once
// #782 step 8 is on next.
//
// The design keeps the series' tests in test/server-imports.test.mjs.
// Phases 1 to 3 are already on, in that file and two beside it, so
// this phase's sit in a file of their own, and turning them on stays
// a pure rename. The readers below are phase 3's.
//
// PENDING_MS is a number, and two equal numbers cannot be told apart
// as bindings at run time. So the binding box checks it by value and
// by the source: farm-orders.mjs takes it from pay-pending.mjs and
// declares it nowhere itself. pendingKey is no export of farm-orders
// .mjs, so the same check covers it: taken, not declared.
//
// The 8 modules of the accounts tangle, as the design names them:
// account, admin, amend, edit, jobs, rounds and farm-orders in lib/,
// and the function file netlify/functions/orders.mjs.
//
// A module is found as .mjs, or as .mts if #795 (TypeScript) has
// landed when the phase starts.
//
// Held out of runs as server-imports-accounts.criteria.mjs until the
// implementer renames it to server-imports-accounts.test.mjs.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { LIB, load, need, rel, root, source } from "./server-graph.mjs";
// The kept names come in by static import, the way their importers
// would take them, so Knip sees each re-export used: once account.mjs
// and admin.mjs take holderOf and paymentPending from the new homes,
// this file is the only reader of amend.mjs's and farm-orders.mjs's.
import { holderOf as amendHolderOf } from "../netlify/functions/lib/amend.mjs";
import { cutoffAt as jobsCutoffAt } from "../netlify/functions/lib/jobs.mjs";
import {
  PENDING_MS as farmPendingMs, createFarmOrder, payFarmOrder,
  paymentPending as farmPaymentPending,
} from "../netlify/functions/lib/farm-orders.mjs";
import { testStores } from "../netlify/functions/lib/store.mjs";
import { instant } from "../assets/scripts/order/lib/zoned.mjs";
import { MORNING, SCHEDULE } from "./schedule-fixture.mjs";

// The four forms: import ... from "x", export ... from "x", import "x"
// and import("x").
const SPECIFIERS = [
  /\b(?:import|export)\b[^;"'`()]*?\bfrom\s*["']([^"']+)["']/g,
  /\bimport\s*["']([^"']+)["']/g,
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
];

const toPath = (file) => (spec) => (spec.startsWith(".")
  ? resolve(dirname(file), spec) : spec);

// Every module a file imports, resolved: a relative specifier as the
// absolute path of the file it names, any other (node:fs) as written.
const importsOf = (file) => {
  const text = source(file);
  const found = SPECIFIERS.flatMap((re) => [...text.matchAll(re)]
    .map((m) => m[1]));

  return [...new Set(found)].map(toPath(file));
};

const isModule = (path) => /\.m?[jt]s$/.test(path) && existsSync(path)
  && statSync(path).isFile();

// The modules a file reaches through its imports, by every form, in
// lib/ or out of it. The file itself is among them only when a path
// of imports leads back to it.
const reachedFrom = (file) => {
  const seen = new Set();
  const visit = (path) => {
    for (const to of importsOf(path)) {
      if (seen.has(to) || !isModule(to)) continue;
      seen.add(to);
      visit(to);
    }
  };

  visit(file);

  return seen;
};

// One path of imports from a module back to itself, for the message.
const loopOf = (file) => {
  const walk = (path, trail, seen) => {
    for (const to of importsOf(path)) {
      if (to === file) return [...trail, to];
      if (seen.has(to) || !isModule(to)) continue;
      seen.add(to);
      const found = walk(to, [...trail, to], seen);

      if (found) return found;
    }

    return null;
  };

  return walk(file, [file], new Set()) || [];
};

// Each static `import { a, b as c } from "x"` and `export { a } from
// "x"`: the module it names, resolved, and the names it takes (as
// exported, before any `as`).
const BRACES =
  /\b(?:import|export)\s+(?:type\s+)?([^;"'`()]*?)\bfrom\s*["']([^"']+)["']/g;

const bindingsOf = (file) => [...source(file).matchAll(BRACES)]
  .map(([, clause, spec]) => {
    const braced = clause.match(/\{([^}]*)\}/);
    const names = braced
      ? braced[1].split(",").map((part) => part.trim().split(/\s+/)[0])
        .filter(Boolean).filter((n) => n !== "type")
      : [];

    return { from: toPath(file)(spec), names };
  });

// The names a file takes from one module by `import { }` or
// `export { } from`.
const takenFrom = (file, home) => bindingsOf(file)
  .filter((b) => b.from === home).flatMap((b) => b.names);

const declares = (file, name) => new RegExp(
  `\\b(?:const|let|var|function\\*?|class)\\s+${name}\\b`)
  .test(source(file));

const inLib = (path) => path.startsWith(`${LIB}/`);

// The function file, outside lib/, as .mjs or .mts.
const ordersFunction = () => {
  const path = [".mjs", ".mts"]
    .map((ext) => join(root, `netlify/functions/orders${ext}`))
    .find((p) => existsSync(p));

  assert.ok(path, "netlify/functions/orders.mjs does not exist");

  return path;
};

const ACCOUNTS = [
  "account", "admin", "amend", "edit", "jobs", "rounds", "farm-orders",
];

// Asserts a file neither imports nor reaches any of the targets.
const cutFrom = (name, targets) => {
  const file = need(name);
  const direct = importsOf(file);
  const reached = reachedFrom(file);

  for (const target of targets.map(need)) {
    assert.ok(!direct.includes(target),
      `${rel(file)} imports ${rel(target)}`);
    // Nor through another module: one that re-exported the moved
    // name from its old home would keep the edge by another road.
    assert.ok(!reached.has(target),
      `${rel(file)} reaches ${rel(target)} through its imports`);
  }
};

describe("#967: phase 4, accounts above admin", () => {
  it("account.mjs imports nothing from amend.mjs or jobs.mjs", () => {
    const file = need("account");

    // The reader sees account.mjs's imports at all: it takes
    // cancelOrder from admin.mjs, and the moved names from their new
    // homes.
    assert.ok(importsOf(file).includes(need("admin")),
      `the reader found no import of admin.mjs in ${rel(file)}`);
    assert.ok(takenFrom(file, need("holder")).includes("holderOf"),
      `${rel(file)} does not take holderOf from holder.mjs`);
    assert.ok(takenFrom(file, need("cutoff")).includes("cutoffAt"),
      `${rel(file)} does not take cutoffAt from cutoff.mjs`);

    cutFrom("account", ["amend", "jobs"]);
  });

  it("admin.mjs imports nothing from amend.mjs or farm-orders.mjs", () => {
    const file = need("admin");

    // The reader sees admin.mjs's imports at all: it logs through
    // log.mjs, and takes the moved names from their new homes.
    assert.ok(importsOf(file).includes(need("log")),
      `the reader found no import of log.mjs in ${rel(file)}`);
    assert.ok(takenFrom(file, need("holder")).includes("holderOf"),
      `${rel(file)} does not take holderOf from holder.mjs`);
    assert.ok(
      takenFrom(file, need("pay-pending")).includes("paymentPending"),
      `${rel(file)} does not take paymentPending from pay-pending.mjs`);

    cutFrom("admin", ["amend", "farm-orders"]);
  });

  it("cutoff.mjs and pay-pending.mjs import nothing from lib/ but "
    + "terms.mjs and clock.mjs, and holder.mjs nothing at all", () => {
    const allowed = new Set([need("terms"), need("clock")]);

    for (const name of ["cutoff", "pay-pending"]) {
      const file = need(name);
      const others = importsOf(file).filter(inLib)
        .filter((to) => !allowed.has(to)).map(rel);

      assert.deepEqual(others, [],
        `${rel(file)} imports ${others.join(", ")} from lib/`);
    }

    const holder = need("holder");
    const any = importsOf(holder);

    assert.deepEqual(any, [], `${rel(holder)} imports ${any.join(", ")}`);
  });

  it("no module among the 8 of the accounts reaches itself through "
    + "its imports", () => {
    const files = [...ACCOUNTS.map(need), ordersFunction()];

    // The walk sees the tangle at all: jobs.mjs reaches admin.mjs,
    // edit.mjs and rounds.mjs, and through them account.mjs.
    const fromJobs = reachedFrom(need("jobs"));

    assert.ok(["admin", "edit", "rounds", "account"].map(need)
      .every((to) => fromJobs.has(to)),
    "the walk from jobs.mjs missed admin, edit, rounds or account");

    const looping = files.filter((file) => reachedFrom(file).has(file))
      .map((file) => loopOf(file).map(rel).join(" -> "));

    assert.deepEqual(looping, [],
      `these reach themselves:\n${looping.join("\n")}`);
  });

  it("the re-exported names are the same bindings as at their new "
    + "homes", async () => {
    const KEPT = [
      { by: "amend", home: "holder", names: { holderOf: amendHolderOf } },
      { by: "jobs", home: "cutoff", names: { cutoffAt: jobsCutoffAt } },
      {
        by: "farm-orders", home: "pay-pending",
        names: {
          paymentPending: farmPaymentPending, PENDING_MS: farmPendingMs,
        },
      },
    ];

    for (const { by, home, names } of KEPT) {
      const to = await load(home);

      for (const [name, kept] of Object.entries(names)) {
        assert.ok(name in to, `${home}.mjs exports no ${name}`);
        assert.notEqual(kept, undefined, `${by}.mjs no longer exports ${name}`);
        assert.equal(kept, to[name],
          `${by}.${name} is not ${home}.mjs's ${name}`);
      }
    }

    const payPending = await load("pay-pending");

    assert.equal(typeof payPending.pendingKey, "function",
      "pay-pending.mjs exports no pendingKey function");
    for (const name of ["holderOf", "cutoffAt", "paymentPending"]) {
      const home = KEPT.find((k) => name in k.names).home;

      assert.equal(typeof (await load(home))[name], "function",
        `${home}.mjs's ${name} is no function`);
    }

    // A number is the same by value whether moved or copied, and
    // pendingKey is private to farm-orders.mjs, so the source settles
    // both: farm-orders.mjs takes them from pay-pending.mjs and
    // declares neither.
    const file = need("farm-orders");
    const home = need("pay-pending");
    const taken = takenFrom(file, home);

    for (const name of ["paymentPending", "PENDING_MS", "pendingKey"]) {
      assert.ok(taken.includes(name),
        `${rel(file)} does not take ${name} from ${rel(home)}`);
      assert.ok(!declares(file, name), `${rel(file)} declares ${name} itself`);
    }
    for (const { by, home: to, names } of KEPT.slice(0, 2)) {
      for (const name of Object.keys(names)) {
        assert.ok(takenFrom(need(by), need(to)).includes(name),
          `${by}.mjs does not take ${name} from ${to}.mjs`);
        assert.ok(!declares(need(by), name),
          `${by}.mjs declares ${name} itself`);
      }
    }
  });

  it("pay-pending/<id> is still the key a claim writes and "
    + "paymentPending reads", async () => {
    const { PENDING_MS, paymentPending, pendingKey } = await load(
      "pay-pending");
    const now = instant("2026-10-06", 9, 0, "America/New_York");
    const env = {
      FARM_NOTIFICATIONS_EMAIL: "farm@x.com",
      DEV_NOTIFICATIONS_EMAIL: "dev@x.com",
      PICKUP_SCHEDULE: SCHEDULE,
    };
    const mail = async () => ({ id: "m" });
    const stores = testStores();
    // What pay-pending.mjs sees while farm-orders.mjs takes the money,
    // its claim standing.
    const seen = {};
    const square = {
      createOrder: async () => ({ squareOrderId: "SQO", customerId: "C" }),
      createPayment: async () => {
        const id = seen.id;

        seen.held = await stores.orders.get(`pay-pending/${id}`);
        seen.during = await paymentPending(stores, id, now);
        seen.before = await paymentPending(stores, id,
          new Date(now.getTime() + PENDING_MS - 1));
        seen.after = await paymentPending(stores, id,
          new Date(now.getTime() + PENDING_MS));

        return {
          squarePaymentId: "PAY-1", status: "COMPLETED", receiptUrl: null,
          brand: null, last4: null, wallet: null,
        };
      },
      completeOrder: async (id) => ({ id, completed: true }),
      findPaid: async () => null,
      getOrder: async (id) => ({ id, tenders: [] }),
    };
    const made = await createFarmOrder(stores, {
      customer: {
        firstName: "Pat", lastName: "Example", email: "pat@example.com",
        phone: "401-555-0100", contact: "call",
      },
      lines: [{ sku: "NFF-CHK-WHL-35-39", qty: 2 }],
      fulfilment: {
        method: "onfarm", date: "2026-10-07", onfarm: { window: MORNING },
      },
    }, {
      key: "farm-0f7c1e3a-9c9b-4b3a-8e9d-1a2b3c4d5e6f", now, env, mail,
      square,
    });

    assert.equal(made.ok, true, "the farm's order was not made");
    seen.id = made.order.id;
    assert.equal(pendingKey(seen.id), `pay-pending/${seen.id}`);

    const paid = await payFarmOrder(stores, seen.id, { tender: "cash" },
      { now, env, mail, square });

    assert.equal(paid.ok, true, "the farm's tender was not taken");
    assert.ok(seen.held, `the claim wrote no pay-pending/${seen.id}`);
    assert.equal(seen.during, true,
      "pay-pending.mjs did not see the claim as pending");
    assert.equal(seen.before, true,
      "the claim lapsed before PENDING_MS");
    assert.equal(seen.after, false,
      "the claim still held at PENDING_MS");
    assert.equal(await stores.orders.get(pendingKey(seen.id)), null,
      "the claim was not released");
  });
});
