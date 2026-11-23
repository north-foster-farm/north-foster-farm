// Criteria tests for #968, phase 5 of untangling the server
// libraries' import cycles (#925, docs/refactors/server-cycles.md):
// "Moves orderId and ID_LENGTH to order-id.mjs. orders.mjs re-exports
// both. farm-orders.mjs imports orderId from order-id.mjs. orderId
// reads terms.timeZone, so order-id.mjs gains an import of terms.mjs,
// a leaf."
//
// One test per box marked (test), named for the box, written before
// the implementation. The (guard) box is checks that already exist:
// orders.test, fake.test, farm-orders.test and records.test, which
// pass unedited.
//
// ID_LENGTH is already in order-id.mjs on next (#937 put it there,
// from assets/scripts/utils/order-id.mjs), and orders.mjs already
// re-exports it, so of the two names only orderId moves. A number
// cannot be told apart from a copy at run time, so the binding test
// checks ID_LENGTH by value and by the source: orders.mjs takes both
// names from lib/order-id.mjs and declares neither.
//
// "A file outside lib/ in netlify/functions/" is read as any module
// under netlify/functions/ that is not under netlify/functions/lib/:
// the function files, such as orders.mjs. Imports of assets/ and data/
// are outside netlify/functions/ and stay allowed. order-id.mjs's
// other imports (node:crypto, assets/) are outside lib/, which the
// second box does not reach.
//
// The design keeps the series' tests in test/server-imports.test.mjs.
// Phases 1 to 4 are already on, in that file and three beside it, so
// this phase's sit in a file of their own, and turning them on stays a
// pure rename.
//
// A module is found as .mjs, or as .mts if #795 (TypeScript) has
// landed when the phase starts.
//
// Held out of runs as server-imports-order-id.criteria.mjs until the
// implementer renames it to server-imports-order-id.test.mjs.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { LIB, load, need, rel, root, source } from "./server-graph.mjs";
// The names of orders.mjs come in by static import, the way orders.test
// and fake.test take them, so Knip sees the re-exports used.
import {
  ID_LENGTH as ordersIdLength, orderId as ordersOrderId,
} from "../netlify/functions/orders.mjs";

const FUNCTIONS = join(root, "netlify/functions");

// Each module a file names, in any of the four forms (import ... from,
// export ... from, a bare import and import()), with the clause before
// "from" when there is one. A relative specifier is resolved to the
// absolute path of the file it names; any other (node:fs) is kept.
const FORMS = new RegExp([
  String.raw`\b(?:import|export)\b([^;"'\`()]*?)\bfrom\s*["']([^"']+)["']`,
  String.raw`\bimport\s*()["']([^"']+)["']`,
  String.raw`\bimport\s*\(\s*()["']([^"']+)["']\s*\)`,
].join("|"), "g");

const edgesOf = (file) => [...source(file).matchAll(FORMS)]
  .map((m) => {
    const clause = m[1] ?? m[3] ?? m[5] ?? "";
    const spec = m[2] ?? m[4] ?? m[6];

    return {
      to: spec.startsWith(".") ? resolve(dirname(file), spec) : spec,
      names: (clause.match(/\{([^}]*)\}/)?.[1] || "").split(",")
        .map((part) => part.trim().split(/\s+/)[0])
        .filter((n) => n && n !== "type"),
    };
  });

const importsOf = (file) => [...new Set(edgesOf(file).map((e) => e.to))];

// The names a file takes from one module by `import { }` or
// `export { } from`, as exported, before any `as`.
const namesFrom = (file, home) => edgesOf(file)
  .filter((e) => e.to === home).flatMap((e) => e.names);

const declared = (file, name) => new RegExp(
  `\\b(?:const|let|var|function\\*?|class)\\s+${name}\\b`)
  .test(source(file));

const under = (dir) => (path) => path.startsWith(`${dir}/`);

// Every module under lib/, its folders included.
const libModules = (dir = LIB) => readdirSync(dir, { withFileTypes: true })
  .flatMap((entry) => {
    const path = join(dir, entry.name);

    if (entry.isDirectory()) return libModules(path);

    return /\.m?[jt]s$/.test(entry.name) ? [path] : [];
  });

// The function file, outside lib/, as .mjs or .mts.
const ordersFunction = () => {
  const path = [".mjs", ".mts"].map((ext) => join(FUNCTIONS, `orders${ext}`))
    .find((p) => existsSync(p));

  assert.ok(path, "netlify/functions/orders.mjs does not exist");

  return path;
};

describe("#968: phase 5, no library imports a function", () => {
  it("no module under lib/ imports a file outside lib/ in "
    + "netlify/functions/", () => {
    const files = libModules();

    // The reader sees lib/ at all, and its imports out of lib/:
    // order-id.mjs takes the pattern from assets/.
    assert.ok(files.includes(need("farm-orders")),
      "the walk found no farm-orders.mjs under lib/");
    assert.ok(importsOf(need("order-id")).some((to) => !under(LIB)(to)
      && to.startsWith(root)),
    "the reader found no import out of lib/ in order-id.mjs");

    const out = files.flatMap((file) => importsOf(file)
      .filter((to) => under(FUNCTIONS)(to) && !under(LIB)(to))
      .map((to) => `${rel(file)} -> ${rel(to)}`));

    assert.deepEqual(out, [],
      `these import a function file:\n${out.join("\n")}`);
    // The one that took orderId from orders.mjs, farm-orders.mjs, now
    // takes it from order-id.mjs.
    assert.ok(namesFrom(need("farm-orders"), need("order-id"))
      .includes("orderId"),
    "farm-orders.mjs does not take orderId from order-id.mjs");
  });

  it("order-id.mjs imports only terms.mjs from lib/", () => {
    const file = need("order-id");
    const terms = need("terms");
    const fromLib = importsOf(file).filter(under(LIB));

    assert.deepEqual(fromLib.map(rel), [rel(terms)],
      `${rel(file)} imports ${fromLib.map(rel).join(", ") || "nothing"}`
      + " from lib/");
    // The design calls terms.mjs a leaf, so order-id.mjs stays
    // light enough for lib/store.mjs to load.
    const fromTerms = importsOf(terms).filter(under(LIB));

    assert.deepEqual(fromTerms, [],
      `${rel(terms)} imports ${fromTerms.map(rel).join(", ")} from lib/`);
  });

  it("orders.orderId is the same binding as order-id.mjs's", async () => {
    const home = await load("order-id");

    assert.ok("orderId" in home, "order-id.mjs exports no orderId");
    assert.equal(typeof home.orderId, "function",
      "order-id.mjs's orderId is no function");
    assert.notEqual(ordersOrderId, undefined,
      "orders.mjs no longer exports orderId");
    assert.equal(ordersOrderId, home.orderId,
      "orders.orderId is not order-id.mjs's orderId");

    // ID_LENGTH, which orders.mjs re-exports too: the same by value,
    // and, since a number cannot show a copy, taken and not declared.
    assert.equal(ordersIdLength, home.ID_LENGTH,
      "orders.ID_LENGTH is not order-id.mjs's ID_LENGTH");

    const file = ordersFunction();
    const taken = namesFrom(file, need("order-id"));

    for (const name of ["orderId", "ID_LENGTH"]) {
      assert.ok(taken.includes(name),
        `${rel(file)} does not take ${name} from order-id.mjs`);
      assert.ok(!declared(file, name), `${rel(file)} declares ${name} itself`);
    }
    assert.ok(!declared(need("farm-orders"), "orderId"),
      "farm-orders.mjs declares orderId itself");
  });
});
