// Criteria tests for #966, phase 3 of untangling the server
// libraries' import cycles (#925, docs/refactors/server-cycles.md):
// "Moves ping and PING_TIMEOUT to ping.mjs. health.mjs re-exports
// both. breaker.mjs imports ping from ping.mjs. After it the core has
// no cycle."
//
// One test per box marked (test), named for the box, written before
// the implementation. The two (guard) boxes are checks that already
// exist: breaker.test, health.test, morning-ping.test,
// quiet-morning.test, mail.test and maintenance.test, and the
// dependency-cruiser baseline once #782 step 8 is on next.
//
// The design keeps the series' tests in test/server-imports.test.mjs.
// Phases 1 and 2 are already on, in that file and in
// server-imports-log.test.mjs, so this phase's sit beside them, in a
// file of their own, and turning them on stays a pure rename. The
// readers below are phase 2's.
//
// PING_TIMEOUT is a number, and two numbers that are equal cannot be
// told apart as bindings at run time. So the binding box checks it by
// value and by the source: health.mjs takes both names from ping.mjs
// and declares neither itself.
//
// A module is found as .mjs, or as .mts if #795 (TypeScript) has
// landed when the phase starts.
//
// Held out of runs as server-imports-ping.criteria.mjs until the
// implementer renames it to server-imports-ping.test.mjs.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const LIB = join(root, "netlify/functions/lib");
const rel = (path) => relative(root, path);

// A module in lib/ by its name, as .mjs or .mts, or null.
const moduleOf = (name) => [".mjs", ".mts"]
  .map((ext) => join(LIB, `${name}${ext}`))
  .find((path) => existsSync(path)) || null;

const need = (name) => {
  const path = moduleOf(name);

  assert.ok(path, `netlify/functions/lib/${name}.mjs does not exist`);

  return path;
};

const load = async (name) => import(pathToFileURL(need(name)).href);

// The source with its comments taken out, so a comment that names a
// module is not read as an import. Strings and template literals are
// kept as they are, so a URL's "//" is not a comment.
const code = (text) => {
  let out = "";
  let i = 0;

  while (i < text.length) {
    const c = text[i];
    const pair = text.slice(i, i + 2);

    if (pair === "//") {
      while (i < text.length && text[i] !== "\n") i += 1;
    } else if (pair === "/*") {
      const end = text.indexOf("*/", i + 2);

      i = end === -1 ? text.length : end + 2;
    } else if (c === "\"" || c === "'" || c === "`") {
      let j = i + 1;

      while (j < text.length && text[j] !== c) j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else {
      out += c;
      i += 1;
    }
  }

  return out;
};

const source = (file) => code(readFileSync(file, "utf8"));

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

const inLib = (path) => path.startsWith(`${LIB}/`);

// The 14 modules of the core, as the design names them.
const CORE = [
  "log", "clock", "store", "health", "mail", "breaker", "resend-guard",
  "maintenance", "auth", "auth-records", "records", "address-key",
  "templates", "pickups",
];

describe("#966: phase 3, ping below the breaker", () => {
  it("breaker.mjs imports nothing from health.mjs", () => {
    const file = need("breaker");
    const health = need("health");
    const direct = importsOf(file);

    // The reader sees the breaker's imports at all: it logs through
    // log.mjs.
    assert.ok(direct.includes(need("log")),
      `the reader found no import of log.mjs in ${rel(file)}`);
    assert.ok(!direct.includes(health),
      `${rel(file)} imports ${rel(health)}`);
    // Nor through another module: one that re-exported health.mjs's
    // ping would still tie the breaker to health.
    assert.ok(!reachedFrom(file).has(health),
      `${rel(file)} reaches ${rel(health)} through its imports`);
  });

  it("ping.mjs imports only log.mjs from lib/", () => {
    const file = need("ping");
    const fromLib = importsOf(file).filter(inLib).map(rel);

    assert.deepEqual(fromLib, [rel(need("log"))],
      `${rel(file)} imports ${fromLib.join(", ") || "nothing"} from lib/`);
  });

  it("health.ping and health.PING_TIMEOUT are the same bindings as "
    + "ping.mjs's", async () => {
    const health = await load("health");
    const ping = await load("ping");

    for (const name of ["ping", "PING_TIMEOUT"]) {
      assert.ok(name in ping, `ping.mjs exports no ${name}`);
      assert.ok(name in health, `health.mjs no longer exports ${name}`);
      assert.equal(health[name], ping[name],
        `health.${name} is not ping.mjs's ${name}`);
    }
    assert.equal(typeof ping.ping, "function",
      "ping.mjs's ping is no function");

    // A number is the same by value whether moved or copied, so the
    // source settles it: health.mjs takes both from ping.mjs, and
    // declares neither.
    const file = need("health");
    const home = need("ping");
    const taken = bindingsOf(file)
      .filter((b) => b.from === home).flatMap((b) => b.names);
    const text = source(file);

    for (const name of ["ping", "PING_TIMEOUT"]) {
      assert.ok(taken.includes(name),
        `${rel(file)} does not take ${name} from ${rel(home)}`);
      assert.ok(!new RegExp(
        `\\b(?:const|let|var|function\\*?|class)\\s+${name}\\b`).test(text),
      `${rel(file)} declares ${name} itself`);
    }
  });

  it("no module among the 14 of the core reaches itself through its "
    + "imports", () => {
    const files = CORE.map(need);

    // The walk sees the core at all: health.mjs reaches mail.mjs, and
    // through it the breaker.
    const fromHealth = reachedFrom(need("health"));

    assert.ok(fromHealth.has(need("mail")) && fromHealth.has(need("breaker")),
      "the walk from health.mjs found neither mail.mjs nor breaker.mjs");

    const looping = files.filter((file) => reachedFrom(file).has(file))
      .map((file) => loopOf(file).map(rel).join(" -> "));

    assert.deepEqual(looping, [],
      `these reach themselves:\n${looping.join("\n")}`);
  });
});
