// #577: Netlify reads each function's `export const config` from the
// source at build time, and takes only literals. membership.mjs once
// wrote `config = { path: PATHS }`: the function deployed with no
// route, and every /api/membership request got the site's HTML 404,
// on staging and production alike, while every test passed. This
// reads every function's source and holds `path` and `excludedPath`
// to an inline string, or an array of inline strings.

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import { config, handle } from "../netlify/functions/membership.mjs";

const dir = join(import.meta.dirname, "..", "netlify", "functions");
const files = readdirSync(dir).filter((name) => name.endsWith(".mjs"));

const STRING = /^(?:"[^"\\\n]*"|'[^'\\\n]*')$/;
const ROUTES = ["path", "excludedPath"];

// From `start`, an opening bracket, to just past its match, skipping
// what is inside strings and comments. -> the index, or -1.
const close = (text, start) => {
  const pairs = { "{": "}", "[": "]", "(": ")" };
  const stack = [];

  for (let i = start; i < text.length; i += 1) {
    const c = text[i];

    if (c === "\"" || c === "'" || c === "`") {
      const end = text.indexOf(c, i + 1);

      if (end < 0) return -1;
      i = end;
    } else if (text.startsWith("//", i)) {
      i = text.indexOf("\n", i);
      if (i < 0) return -1;
    } else if (text.startsWith("/*", i)) {
      i = text.indexOf("*/", i) + 1;
      if (i < 1) return -1;
    } else if (pairs[c]) {
      stack.push(pairs[c]);
    } else if (c === "}" || c === "]" || c === ")") {
      if (stack.pop() !== c) return -1;
      if (stack.length === 0) return i + 1;
    }
  }

  return -1;
};

const uncomment = (text) =>
  text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

// What is wrong with a source's config. -> a list of problems, empty
// when the config is literal enough for Netlify, or has none.
const problems =(source) => {
  const found = [...source.matchAll(/export\s+const\s+config\s*=\s*/g)];

  if (found.length === 0) return [];
  if (found.length > 1) return ["more than one export const config"];

  const start = found[0].index + found[0][0].length;

  if (source[start] !== "{") return ["config is not an object literal"];

  const end = close(source, start);

  if (end < 0) return ["config's braces don't close"];

  const body = uncomment(source.slice(start + 1, end - 1));
  const out = [];

  if (/\.\.\./.test(body)) out.push("config spreads another object");

  for (const key of ROUTES) {
    const at = [...body.matchAll(
      new RegExp(`(?:^|[\\s,{])["']?${key}["']?\\s*:\\s*`, "g"))];

    // `{ path }` shorthand names a variable.
    if (new RegExp(`(?:^|[\\s,{])${key}\\s*(?:,|$)`).test(body)) {
      out.push(`${key} is shorthand for a variable`);
    }

    for (const m of at) {
      const from = m.index + m[0].length;
      const rest = body.slice(from);

      if (rest[0] === "[") {
        const stop = close(rest, 0);
        const items = rest.slice(1, stop - 1).split(",")
          .map((item) => item.trim()).filter(Boolean);

        if (stop < 0 || items.length === 0
          || !items.every((item) => STRING.test(item))) {
          out.push(`${key} is not an array of string literals`);
        }
      } else {
        const value = rest.match(/^[^,\n}]*/)[0].trim();

        if (!STRING.test(value)) {
          out.push(`${key} is not a string literal: ${value}`);
        }
      }
    }
  }

  return out;
};

describe("function config (#577)", () => {
  it("finds the functions", () => {
    assert.ok(files.includes("membership.mjs"));
    assert.ok(files.includes("auth.mjs"));
  });

  for (const name of files) {
    it(`${name} routes by literals only`, () => {
      assert.deepEqual(problems(readFileSync(join(dir, name), "utf8")), []);
    });
  }

  it("catches a path or excludedPath that isn't literal", () => {
    const bad = [
      "export const config = { path: PATHS };",
      "export const config = { path };",
      "export const config = { path: [\"/a\", B] };",
      "export const config = { path: [...PATHS] };",
      "export const config = { path: `/api/${x}` };",
      "export const config = { path: \"/a\", excludedPath: SKIP };",
      "export const config = { ...BASE };",
      "export const config = CONFIG;",
    ];

    for (const source of bad) {
      assert.notDeepEqual(problems(source), [], source);
    }
  });

  it("accepts the shapes the functions use", () => {
    const good = [
      "export const config = { path: \"/api/a\", method: \"GET\" };",
      "export const config = {\n  path: [\n    \"/a\", '/b/*',\n  ],\n};",
      "export const config = {\n  // path: X\n  path: \"/a\",\n};",
      "export const config = { schedule: \"0 7 * * *\" };",
      "export const config = { path: \"/a\", excludedPath: [\"/a/b\"] };",
      "const x = 1;",
    ];

    for (const source of good) {
      assert.deepEqual(problems(source), [], source);
    }
  });

  // The handler checks config.path itself, so the routes Netlify serves
  // and the ones it answers are one list: each one reaches the handler
  // and asks for a session, rather than the handler's own 404.
  it("membership answers every routed path", async () => {
    assert.deepEqual(config.path, [
      "/api/membership", "/api/membership/qr", "/api/membership/remove",
      "/api/membership/leave", "/api/membership/code",
    ]);

    for (const path of config.path) {
      const res = await handle(new Request(`http://x${path}`),
        { stores: {} });

      assert.equal(res.status, 401, path);
      assert.deepEqual(await res.json(), { error: "Sign in first." });
    }

    const res = await handle(new Request("http://x/api/membership/nope"),
      { stores: {} });

    assert.equal(res.status, 404);
  });
});
