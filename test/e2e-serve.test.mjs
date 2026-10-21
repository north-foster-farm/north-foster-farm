import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  findRedirect, headersFor, matchPath, parseToml,
} from "../bin/e2e/netlify-toml.mjs";

// CI's e2e server reads netlify.toml itself (bin/e2e/serve.mjs), so
// what it reads has to be what Netlify reads.
describe("e2e server: netlify.toml", () => {
  it("reads the four kinds of string, folding a backslash newline", () => {
    const toml = parseToml([
      "[[headers]]",
      "  for = \"/*\"",
      "  [headers.values]",
      "    A = \"one \\\"two\\\"\" # a comment",
      "    B = 'lit # not a comment'",
      "    C = '''",
      "      x,",
      "      y",
      "    '''",
      "    D = \"\"\"\\",
      "      p; \\",
      "      q;\"\"\"",
      "[[redirects]]",
      "  from = \"/a/*\"",
      "  to = \"/b/:splat\"",
      "  status = 302",
      "  force = true",
      "[functions]",
      "  included_files = [\"docs/x.md\"]",
    ].join("\n"));
    const values = toml.headers[0].values;

    assert.equal(values.A, "one \"two\"");
    assert.equal(values.B, "lit # not a comment");
    assert.equal(values.C, "      x,\n      y\n    ");
    assert.equal(values.D, "p; q;");
    assert.deepEqual(toml.redirects[0],
      { from: "/a/*", to: "/b/:splat", status: 302, force: true });
    assert.deepEqual(toml.functions.included_files, ["docs/x.md"]);
  });

  it("reads the site's own file whole", () => {
    const toml = parseToml(readFileSync(
      new URL("../netlify.toml", import.meta.url), "utf8"));
    const page = headersFor(toml.headers, "/order/");

    assert.ok(toml.redirects.length >= 20);
    assert.match(page["Content-Security-Policy"], /^default-src 'none'; /);
    assert.doesNotMatch(page["Content-Security-Policy"], /\n/);
    assert.equal(page["Cache-Control"], "public, max-age=0, must-revalidate");
    assert.equal(headersFor(toml.headers, "/api/dates")["Cache-Control"],
      "no-store");
  });

  it("matches a path exactly or by its splat", () => {
    assert.equal(matchPath("/api/dates", "/api/dates"), "");
    assert.equal(matchPath("/api/dates", "/api/dates/x"), null);
    assert.equal(matchPath("/api/account/*", "/api/account/orders/1"),
      "orders/1");
    assert.equal(matchPath("/api/account/*", "/api/accounts"), null);
  });

  it("keeps forced redirects apart from the rest, splat and all", () => {
    const rules = [
      { from: "/admin", to: "https://x.test", status: 301, force: true },
      { from: "/old/*", to: "/new/:splat", status: 301 },
      { from: "/account/orders/*", to: "/account/", status: 200 },
    ];

    assert.deepEqual(findRedirect(rules, "/admin", { forced: true }),
      { to: "https://x.test", status: 301 });
    assert.equal(findRedirect(rules, "/admin", { forced: false }), null);
    assert.deepEqual(findRedirect(rules, "/old/a/b", { forced: false }),
      { to: "/new/a/b", status: 301 });
    assert.deepEqual(
      findRedirect(rules, "/account/orders/N-1", { forced: false }),
      { to: "/account/", status: 200 });
  });
});
