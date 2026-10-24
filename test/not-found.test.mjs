// #395: Netlify serves 404.html for any missing path, from the deploy's
// own origin, so the page must load its CSS, scripts and images from
// that origin at any depth. It once set its base to .Site.BaseURL, which
// a plain `hugo` (or a local build) leaves at production's address.
// Builds the site with a base URL that is not production's, as a deploy
// preview does, and resolves the page's assets the way a browser would
// at a missing path three levels down. Where Hugo is not installed
// (CI's test job), CI's build job builds the same page.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

const root = join(import.meta.dirname, "..");
const hasHugo = spawnSync("hugo", ["version"]).status === 0;

const DEPLOY = "https://deploy-preview-1--nff.example/";
const MISSING = `${DEPLOY}a/b/c`;

const decode = (text) => text.replaceAll("&sol;", "/")
  .replaceAll("&#43;", "+").replaceAll("&amp;", "&");

// Every tag's attributes, in order, as an object.
const tags = (html, name) => [...html.matchAll(
  new RegExp(`<${name}\\b([^>]*)>`, "g"))].map(([, attrs]) =>
  Object.fromEntries([...attrs.matchAll(/([\w-]+)="([^"]*)"/g)]
    .map(([, key, value]) => [key, decode(value)])));

describe("the 404 page", {
  timeout: 120_000, skip: !hasHugo && "Hugo is not installed here",
}, () => {
  let out;
  let html;

  before(() => {
    out = mkdtempSync(join(tmpdir(), "nff-404-"));
    const run = spawnSync("hugo", ["--gc", "--quiet", "--environment",
      "production", "-b", DEPLOY, "-d", out], {
      cwd: root, encoding: "utf8",
      env: { PATH: process.env.PATH, HOME: process.env.HOME },
    });

    assert.equal(run.status, 0, run.stderr);
    html = readFileSync(join(out, "404.html"), "utf8");
  });
  after(() => {
    if (out) rmSync(out, { recursive: true, force: true });
  });

  it("resolves its base to the root of the origin that served it", () => {
    const bases = tags(html, "base");

    assert.equal(bases.length, 1);
    assert.equal(new URL(bases[0].href, MISSING).href, DEPLOY);
  });

  it("loads every asset from that origin, at any missing path", () => {
    const base = new URL(tags(html, "base")[0].href, MISSING);
    const assets = [
      ...tags(html, "link").filter(({ rel }) => rel !== "canonical")
        .map(({ href }) => href),
      ...tags(html, "script").map(({ src }) => src),
      ...tags(html, "img").map(({ src }) => src),
    ].filter(Boolean);

    assert.ok(assets.some((url) => url.includes("styles/main.")));
    assert.ok(assets.some((url) => url.includes("scripts/main.")));

    for (const url of assets) {
      assert.equal(new URL(url, base).origin, new URL(DEPLOY).origin, url);
    }
  });

  it("is kept out of search and names no address of its own", () => {
    assert.match(html, /<meta name="robots" content="noindex">/);
    assert.doesNotMatch(html, /rel="canonical"/);
    assert.doesNotMatch(html, /property="og:url"/);
    assert.match(html, /<title>Page not found \| /);
  });

  it("has one h1", () => {
    assert.equal(tags(html, "h1").length, 1);
  });
});
