import assert from "node:assert/strict";
import {
  mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  findRedirect, headersFor, matchPath, parseToml,
} from "../bin/e2e/netlify-toml.mjs";
import { lookup, startServer } from "../bin/e2e/server.mjs";

// A site folder with a sibling whose name starts with the site's.
const sites = () => {
  const parent = mkdtempSync(join(tmpdir(), "e2e-serve-"));
  const site = join(parent, "e2e-site");
  const sibling = join(parent, "e2e-site-x");

  mkdirSync(site);
  mkdirSync(sibling);
  writeFileSync(join(site, "index.html"), "<p>home</p>");
  writeFileSync(join(sibling, "s.txt"), "secret");

  return { parent, site };
};

const get = (port, path) => new Promise((resolve, reject) => {
  request({ host: "localhost", port, path }, (res) => {
    let body = "";

    res.on("data", (chunk) => { body += chunk; });
    res.on("end", () => resolve({ status: res.statusCode, body }));
  }).on("error", reject).end();
});

describe("e2e server: the build only, this machine only", () => {
  it("refuses a path out of the site, a sibling folder's included", () => {
    const { parent, site } = sites();

    try {
      assert.deepEqual(lookup(site, "/"), { file: join(site, "index.html") });
      for (const path of ["/..%2fe2e-site-x/s.txt", "/../e2e-site-x/s.txt",
        "/%2e%2e/e2e-site-x/s.txt", "/..%2f..%2fetc/hosts", "/%E0%A4%A"]) {
        assert.equal(lookup(site, path), null, path);
      }
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("listens on this machine alone and answers 404 for a way out",
    async () => {
      const { parent, site } = sites();
      const server = await startServer({ site, port: 0 });

      try {
        const { address, port } = server.address();

        assert.ok(["127.0.0.1", "::1"].includes(address), address);

        const out = await get(port, "/..%2fe2e-site-x/s.txt");

        assert.equal(out.status, 404);
        assert.doesNotMatch(out.body, /secret/);
        assert.equal((await get(port, "/")).body, "<p>home</p>");
      } finally {
        await new Promise((resolve) => server.close(resolve));
        rmSync(parent, { recursive: true, force: true });
      }
    });
});

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
