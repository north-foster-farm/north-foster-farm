// Criteria tests for #924 (Order links in emails land on an account
// page that never loads), the boxes about the built HTML, one test
// each, named for its box:
//
// - box 1: from /account/orders/<id>/ the account page's script,
//   stylesheet, image and font addresses reach the files they reach
//   at /account/;
// - box 2: the same for every other page a netlify.toml rule serves at
//   a path of another depth;
// - box 4: the links inside the account page (its six tabs, the skip
//   link to #main, the order page's links, the menu's) go where they
//   go at /account/, from whichever address the browser ends on.
//
// Box 3, the page drawing at /account/orders/<id>/ in a browser, is
// e2e/account-orders-pinned.spec.mjs's test for #832's box 8; box 5
// is a check on production.
//
// Either fix passes: a base element (it counts in every resolution
// here), or netlify.toml sending the order address on to one at the
// page's own depth with a redirect, such as /account/?order=<id>.
// Read off a production build and netlify.toml's rules, matched as
// CI's e2e server matches them (bin/e2e/netlify-toml.mjs). Where Hugo
// is not installed (CI's test job) this is skipped. Held out of npm
// test by its name until the change lands: renamed to
// order-link-assets.test.mjs.
//
// How an address is judged, resolved against the page's base (its
// <base href>, or the address it is served at):
// - a file (script, stylesheet, icon, preload, manifest, image, video
//   poster, or a url() in a style) must resolve to the same URL at the
//   deep path as at the page's own;
// - a reference inside the page (an SVG <use> of "#avatar-...") must
//   stay on the document the browser shows, as it does at the page's
//   own path;
// - a link must reach the same path and fragment as it does at
//   /account/, with no base, as the build writes it today.
// Sign out is a button whose script sends the browser to "/", which
// no base changes; it has no address in the HTML to check.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { findRedirect, parseToml } from "../bin/e2e/netlify-toml.mjs";

const root = join(import.meta.dirname, "..");
const hasHugo = spawnSync("hugo", ["version"]).status === 0;

const ORIGIN = "https://www.northfosterfarm.com";
const ID = "NFF-0000-TEST";
const ORDER_PATHS = [`/account/orders/${ID}/`, `/account/orders/${ID}`];
const ACCOUNT = "/account/";

const rules = parseToml(readFileSync(join(root, "netlify.toml"), "utf8"))
  .redirects || [];

// What Netlify does with a path that has no file: the rule it takes,
// or null. Forced rules first, then the rest.
const ruleFor = (path) => findRedirect(rules, path, { forced: true })
  || findRedirect(rules, path, { forced: false });

const depth = (path) => new URL(path, ORIGIN).pathname
  .split("/").length;

// An attribute as the browser reads it: the entities Hugo writes.
const decode = (s) => s
  .replace(/&#x([0-9a-f]+);/gi,
    (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replaceAll("&sol;", "/").replaceAll("&quot;", "\"")
  .replaceAll("&amp;", "&");

// Every attribute `name` on the tags `tag` in html.
const attrsOf = (html, tag, name) => [...html.matchAll(
  new RegExp(`<${tag}\\s[^>]*?\\b${name}="([^"]*)"`, "g"),
)].map((m) => decode(m[1]));

const baseOf = (html, at) => {
  const href = attrsOf(html, "base", "href")[0];

  return new URL(href === undefined ? at : href, new URL(at, ORIGIN));
};

// The files a page asks for, as written.
const files = (html) => [
  ...attrsOf(html, "script", "src"),
  ...attrsOf(html, "link", "href").filter((h) => !/^https?:/.test(h)),
  ...attrsOf(html, "img", "src"),
  ...attrsOf(html, "video", "poster"),
  ...[...attrsOf(html, "img", "srcset"), ...attrsOf(html, "source", "srcset")]
    .flatMap((s) => s.split(",").map((part) => part.trim().split(/\s+/)[0])),
  ...[...html.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g)]
    .map((m) => decode(m[1])),
].filter((a) => a && !a.startsWith("data:") && !a.startsWith("#"));

// References inside the page: <use> of a fragment.
const inPage = (html) => [...attrsOf(html, "use", "href"),
  ...attrsOf(html, "use", "xlink:href")].filter((a) => a.startsWith("#"));

// Where the browser ends for a path: through a 200 rule, the path
// itself, serving `page`; through a redirect, the address it names.
// -> { at, page } (page the site path whose HTML shows), or null.
const landing = (path) => {
  const rule = ruleFor(path);

  if (!rule) return null;
  if (rule.status === 200) return { at: path, page: rule.to };

  return { at: rule.to, page: new URL(rule.to, ORIGIN).pathname };
};

// The problems with a page served at `at`, against its own `own`:
// files that reach another URL, references that leave the document.
const problems = (html, at, own) => {
  const here = baseOf(html, at);
  const home = baseOf(html, own);
  const shown = new URL(at, ORIGIN);
  const out = [];

  for (const a of files(html)) {
    const from = new URL(a, here).href;
    const want = new URL(a, home).href;

    if (from !== want) out.push(`${a}: ${from}, not ${want}`);
  }
  for (const a of inPage(html)) {
    const to = new URL(a, here);

    to.hash = "";
    shown.hash = "";
    if (to.href !== shown.href) {
      out.push(`${a}: leaves the page for ${to.href}`);
    }
  }

  return out;
};

describe("order links reach a page that loads (#924)", { skip: !hasHugo },
  () => {
    let dir;
    const html = (page) => readFileSync(
      join(dir, page.replace(/^\//, ""), "index.html"), "utf8");

    before(() => {
      dir = mkdtempSync(join(tmpdir(), "nff-order-link-"));

      const run = spawnSync("hugo", ["--gc", "--quiet", "--environment",
        "production", "-d", dir], { cwd: root, encoding: "utf8" });

      assert.equal(run.status, 0, run.stderr);
    });

    after(() => rmSync(dir, { recursive: true, force: true }));

    it("Opened at /account/orders/<id>/, every script, stylesheet, image "
      + "and font address on the account page resolves to the same file "
      + "it does at /account/", () => {
      for (const path of ORDER_PATHS) {
        const end = landing(path);

        assert.ok(end, `${path}: a rule takes it`);
        assert.equal(new URL(end.page, ORIGIN).pathname, ACCOUNT,
          `${path}: the account page`);
        if (depth(end.at) === depth(ACCOUNT)) continue;

        const page = html(ACCOUNT);

        assert.ok(files(page).some((a) => /\.js(\?|$)/.test(a)),
          "the page has scripts");
        assert.deepEqual(problems(page, end.at, ACCOUNT), [],
          `${path}: as at ${ACCOUNT}`);
      }
    });

    it("The same holds for any other page a rewrite serves at a deeper "
      + "path than its own", () => {
      const pages = rules.filter((r) => (r.status || 301) === 200)
        .map((r) => ({ from: r.from, to: String(r.to) }))
        .filter(({ to }) => !/^https?:/.test(to)
          && existsSync(join(dir, new URL(to, ORIGIN).pathname
            .replace(/^\//, ""), "index.html")))
        .filter(({ to }) => new URL(to, ORIGIN).pathname !== ACCOUNT);

      for (const { from, to } of pages) {
        const at = from.replace(/\*$/, "sample/");
        const own = new URL(to, ORIGIN).pathname;

        if (depth(at) === depth(own)) continue;
        assert.deepEqual(problems(html(own), at, own), [],
          `${from}, serving ${own}`);
      }
    });

    it("The links inside the account page (tabs, sign out, the order "
      + "page) still go where they went", () => {
      const page = html(ACCOUNT);
      const links = attrsOf(page, "a", "href")
        .filter((h) => h && !/^(https?|mailto|tel):/.test(h));
      const tabs = [...page.matchAll(
        /<a class="account-tab"[^>]*\bhref="(#[a-z]+)"/g)].map((m) => m[1]);

      assert.equal(tabs.length, 6, "the six tabs");
      assert.ok(links.includes("#main"), "the skip link");
      assert.ok(links.some((h) => new URL(h, ORIGIN + ACCOUNT).pathname
        === "/order/"), "a link to the order page");

      // A link to this same document ("#orders", or "") reaches its
      // path and fragment, wherever the query stands; any other link
      // its whole address.
      const within = (h) => h === "" || h.startsWith("#");
      const where = (h, base) => {
        const u = new URL(h, base);

        return within(h) ? `${u.pathname}${u.hash}` : u.href;
      };

      for (const path of [ACCOUNT, ...ORDER_PATHS]) {
        const end = path === ACCOUNT ? { at: ACCOUNT } : landing(path);

        assert.ok(end, `${path}: a rule takes it`);

        const base = baseOf(page, end.at);
        const wrong = links
          .filter((h) => where(h, base) !== where(h, ORIGIN + ACCOUNT));

        assert.deepEqual(wrong, [], `from ${end.at}: links as at ${ACCOUNT}`);
      }
    });
  });
