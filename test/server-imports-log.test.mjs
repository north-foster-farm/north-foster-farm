// Criteria tests for #965, phase 2 of untangling the server
// libraries' import cycles (#925, docs/refactors/server-cycles.md):
// "Moves withLog, alertCrash and where to with-log.mjs. The 24
// function files and the two tests import withLog (and alertCrash)
// from there." log.mjs exports its private `line` for with-log.mjs
// alone, so there is still one log buffer.
//
// One test per box marked (test), named for the box, written before
// the implementation. The two (guard) boxes are checks that already
// exist: health.test, log-slow.test, log-fields.test, clock.test and
// staging.test, and the dependency-cruiser baseline once #782 step 8
// is on next.
//
// The design keeps the series' tests in test/server-imports.test.mjs.
// Phase 1's are already there, so this phase's sit beside it, in a
// file of their own, and turning them on stays a pure rename. The
// readers below are phase 1's, with static imports and import() told
// apart, which two of the boxes need. The `line` check is meant to
// stay after the series, so this file stays too (or is folded into
// server-imports.test.mjs by a later phase).
//
// A module is found as .mjs, or as .mts if #795 (TypeScript) has
// landed when the phase starts.
//
// Held out of runs as server-imports-log.criteria.mjs until the
// implementer renames it to server-imports-log.test.mjs.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import {
  LIB, load, need, rel, root, source,
} from "./server-graph.mjs";

const FUNCTIONS = join(root, "netlify/functions");
const BIN = join(root, "bin");

// The static forms (import ... from "x", export ... from "x", import
// "x") and the dynamic one (import("x")).
const STATIC = [
  /\b(?:import|export)\b[^;"'`()]*?\bfrom\s*["']([^"']+)["']/g,
  /\bimport\s*["']([^"']+)["']/g,
];
const DYNAMIC = [/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g];

const toPath = (file) => (spec) => (spec.startsWith(".")
  ? resolve(dirname(file), spec) : spec);

// The modules a file imports by the given forms, resolved: a relative
// specifier as the absolute path of the file it names, any other
// (node:fs) as written.
const read = (forms) => (file) => {
  const text = source(file);
  const found = forms.flatMap((re) => [...text.matchAll(re)]
    .map((m) => m[1]));

  return [...new Set(found)].map(toPath(file));
};

const staticImportsOf = read(STATIC);
const dynamicImportsOf = read(DYNAMIC);
const importsOf = read([...STATIC, ...DYNAMIC]);

// The modules a file reaches through its imports, itself left out.
// `skip(from, to)` drops one edge from the walk.
const reachedFrom = (file, { edges = importsOf, skip = () => false } = {}) => {
  const seen = new Set();
  const visit = (path) => {
    for (const to of edges(path)) {
      if (skip(path, to)) continue;
      if (seen.has(to) || !/\.m?[jt]s$/.test(to)) continue;
      if (!existsSync(to) || !statSync(to).isFile()) continue;
      seen.add(to);
      visit(to);
    }
  };

  visit(file);
  seen.delete(file);

  return [...seen];
};

// Each static `import { a, b as c } from "x"` and `export { a } from
// "x"`, and each `import * as n from "x"` and `export * from "x"`: the
// module it names, resolved, the names it takes (as exported, before
// any `as`), and whether it takes the whole namespace.
const BRACES =
  /\b(?:import|export)\s+(?:type\s+)?([^;"'`()]*?)\bfrom\s*["']([^"']+)["']/g;

const bindingsOf = (file) => [...source(file).matchAll(BRACES)]
  .map(([, clause, spec]) => {
    const braced = clause.match(/\{([^}]*)\}/);
    const names = braced
      ? braced[1].split(",").map((part) => part.trim().split(/\s+/)[0])
        .filter(Boolean).filter((n) => n !== "type")
      : [];

    return {
      from: toPath(file)(spec),
      names,
      whole: /\*/.test(clause.replace(/\{[^}]*\}/, "")),
    };
  });

const CODE_FILE = /\.(?:mjs|mts|js|ts|cjs|cts)$/;

// A file with no extension is code when its first line runs node
// (bin/nff and the like).
const isCode = (path) => CODE_FILE.test(path) || (extname(path) === ""
  && /^#!.*\bnode\b/.test(readFileSync(path, "utf8").split("\n")[0]));

// Every code file under a folder, node_modules left out.
const codeFiles = (dir) => readdirSync(dir, { withFileTypes: true })
  .flatMap((entry) => {
    const path = join(dir, entry.name);

    if (entry.isDirectory()) {
      return entry.name === "node_modules" ? [] : codeFiles(path);
    }

    return entry.isFile() && isCode(path) ? [path] : [];
  });

describe("#965: phase 2, log.mjs a leaf", () => {
  it("log.mjs imports nothing from lib/, statically or with import()",
    () => {
      const file = need("log");
      const all = importsOf(file);

      // The reader sees log.mjs's imports at all: it hashes with
      // node:crypto.
      assert.ok(all.includes("node:crypto"),
        `the reader found no import of node:crypto in ${rel(file)}`);

      const fromLib = all.filter((to) => to.startsWith(`${LIB}/`)).map(rel);

      assert.deepEqual(fromLib, [], `${rel(file)} imports ${fromLib}`);
    });

  it("log.mjs no longer exports withLog or alertCrash, and with-log.mjs "
    + "does", async () => {
    const log = await load("log");
    const withLog = await load("with-log");

    for (const name of ["withLog", "alertCrash"]) {
      assert.ok(!(name in log), `log.mjs still exports ${name}`);
      assert.equal(typeof withLog[name], "function",
        `with-log.mjs exports no function ${name}`);
    }
  });

  it("every function file that wraps its handler imports withLog from "
    + "lib/with-log.mjs", () => {
    const home = need("with-log");
    const naming = codeFiles(FUNCTIONS)
      .filter((file) => file !== home)
      .filter((file) => /\bwithLog\b/.test(source(file)));
    const handlers = naming.filter((file) => dirname(file) === FUNCTIONS);

    // The reader finds the function files: the issue counts 24.
    assert.ok(handlers.length >= 24,
      `found ${handlers.length} function files naming withLog, not 24`);

    const wrong = naming.filter((file) => !bindingsOf(file).some((b) =>
      b.from.replace(/\.m[jt]s$/, "") === home.replace(/\.m[jt]s$/, "")
      && b.names.includes("withLog"))).map(rel);

    assert.deepEqual(wrong, [],
      `these name withLog but do not import it from lib/with-log.mjs: ${
        wrong.join(", ")}`);
  });

  it("with-log.mjs imports health.mjs and store.mjs only with import(), "
    + "and reaches health.mjs no other way", () => {
    const file = need("with-log");
    const health = need("health");
    const store = need("store");
    const statics = staticImportsOf(file);
    const dynamics = dynamicImportsOf(file);

    for (const target of [health, store]) {
      assert.ok(!statics.includes(target),
        `${rel(file)} imports ${rel(target)} statically`);
      assert.ok(dynamics.includes(target),
        `${rel(file)} does not import() ${rel(target)}`);
    }

    // Only that one import() leads to health.mjs: not a static import
    // of another module (a cold start would load the core), nor a
    // module behind store.mjs's import().
    const without = reachedFrom(file, {
      skip: (from, to) => from === file && to === health,
    });

    assert.ok(!without.includes(health),
      `${rel(file)} reaches ${rel(health)} through another module`);
    assert.ok(!reachedFrom(file, { edges: staticImportsOf }).includes(health),
      `${rel(file)} loads ${rel(health)} through its static imports`);
  });

  it("with-log.mjs takes line from log.mjs, and no other module under "
    + "netlify/functions/ or bin/ imports line", () => {
    const home = need("with-log");
    const log = need("log");
    const fromLog = (b) => b.from === log;

    assert.ok(bindingsOf(home).some((b) => fromLog(b)
      && b.names.includes("line")),
    `${rel(home)} does not import line from ${rel(log)}`);

    // A namespace import, `export *` or import() of log.mjs hands over
    // line as well, so each counts as taking it.
    const takers = [...codeFiles(FUNCTIONS), ...codeFiles(BIN)]
      .filter((file) => file !== home && file !== log)
      .filter((file) => bindingsOf(file).some((b) => fromLog(b)
        && (b.whole || b.names.includes("line")))
        || dynamicImportsOf(file).includes(log))
      .map(rel);

    assert.deepEqual(takers, [],
      `these import line from lib/log.mjs: ${takers.join(", ")}`);
  });

  it("withLog flushes the lines log buffered during the handler, so "
    + "there is one buffer, log.mjs's", async () => {
    const { flush, log, pending } = await load("log");
    const { withLog } = await load("with-log");
    const request = () => new Request("https://example.test/api/criteria");

    // Start from an empty buffer.
    await flush({ env: {} });
    assert.equal(pending(), 0);

    // The flushImpl is log.mjs's flush, shipping to a store that is
    // offline: the lines it was handed are read off the request, and
    // no answer is invented.
    const sent = [];
    const flushImpl = () => flush({
      env: { AXIOM_TOKEN: "t", AXIOM_DATASET: "d" },
      fetchImpl: async (url, init = {}) => {
        sent.push(...JSON.parse(init.body));
        throw new Error("offline");
      },
    });
    // A 5xx answer, so withLog writes function.slow through line too,
    // with no alert (onCrash null).
    const wrapped = withLog("criteria", async () => {
      log.info({ event: "criteria.inside" });

      return new Response("down", { status: 503 });
    }, { flushImpl, onCrash: null });

    await wrapped(request());

    const events = sent.map((l) => l.event);

    assert.ok(events.includes("criteria.inside"),
      `the handler's line did not reach flushImpl: ${events}`);
    assert.ok(events.includes("function.slow"),
      `withLog's own line did not reach flushImpl: ${events}`);
    assert.equal(pending(), 0, "lines are left in log.mjs's buffer");

    // With no flushImpl given, the flush that runs is log.mjs's: the
    // buffer is emptied after the handler, the store not configured.
    const kept = {};

    for (const key of ["AXIOM_TOKEN", "AXIOM_DATASET"]) {
      kept[key] = process.env[key];
      delete process.env[key];
    }
    try {
      const plain = withLog("criteria", async () => {
        log.info({ event: "criteria.default" });

        return new Response("ok");
      }, { onCrash: null });

      await plain(request());
      assert.equal(pending(), 0,
        "withLog's own flush left log.mjs's buffer full");
    } finally {
      for (const [key, value] of Object.entries(kept)) {
        if (value !== undefined) process.env[key] = value;
      }
    }
  });
});
