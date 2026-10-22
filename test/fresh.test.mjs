import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";

import { check } from "../bin/fresh/check.mjs";

const SITE = "https://x.example";
const MANIFEST = {
  id: "/", name: "X", "start_url": "/", scope: "/",
  "theme_color": "#123456",
  icons: [{ src: "/i/192.png?v=2", sizes: "192x192" }],
};
const HOME = `<head><meta name="description" content="A farm.">
<meta name="theme-color" content="#123456">
<link rel="manifest" href="/m.webmanifest?v=2"></head>`;

// A small build: the home page, a post, a noindex page and a 404,
// with the three files, each of which `change` may spoil.
const build = (change = () => {}) => {
  const dir = mkdtempSync(join(tmpdir(), "fresh-"));
  const files = {
    "index.html": HOME,
    "news/a-post/index.html": "<head></head>",
    "news/page/2/index.html": "<head></head>",
    "login/index.html": '<meta name="robots" content="noindex">',
    "404.html": "<head></head>",
    "sitemap.xml": `<urlset>${[["", "2026-10-01"], ["news/a-post/",
      "2026-10-02T00:00:00-04:00"]].map(([p, d]) =>
      `<url><loc>${SITE}/${p}</loc><lastmod>${d}</lastmod></url>`)
      .join("")}</urlset>`,
    "llms.txt": `# X\n\n> A farm.\n\n- [Post](${SITE}/news/a-post/index.md)\n`,
    "news/a-post/index.md": "x",
    "m.webmanifest": JSON.stringify(MANIFEST),
    "i/192.png": "x",
  };

  change(files);
  for (const [path, body] of Object.entries(files)) {
    if (body === null) continue;
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), body);
  }

  return dir;
};
const rules = (change) => check(build(change)).map((f) => f.rule);

describe("the freshness check", () => {
  it("passes a build whose sitemap, llms.txt and manifest match", () => {
    assert.deepEqual(check(build()), []);
  });

  it("wants all three files", () => {
    assert.deepEqual(rules((f) => { f["sitemap.xml"] = null; }), ["F1"]);
    assert.deepEqual(rules((f) => { f["llms.txt"] = null; }), ["F3"]);
    assert.deepEqual(rules((f) => { f["m.webmanifest"] = null; }), ["F4"]);
  });

  it("finds a page missing from the sitemap, or no longer built", () => {
    assert.deepEqual(rules((f) => {
      f["sitemap.xml"] = f["sitemap.xml"]
        .replace(/<url><loc>[^<]*a-post.*?<\/url>/, "");
    }), ["F2"]);
    assert.deepEqual(rules((f) => { f["news/a-post/index.html"] = null; }),
      ["F2"]);
  });

  it("wants a lastmod on every address", () => {
    assert.deepEqual(rules((f) => {
      f["sitemap.xml"] = f["sitemap.xml"]
        .replace(/<lastmod>[^<]*<\/lastmod>/, "");
    }), ["F2"]);
  });

  it("wants llms.txt to list each post and say what home says", () => {
    assert.deepEqual(rules((f) => {
      f["llms.txt"] = "# X\n\n> A farm.\n";
    }), ["F3"]);
    assert.deepEqual(rules((f) => {
      f["llms.txt"] = f["llms.txt"].replace("> A farm.", "> Old words.");
    }), ["F3"]);
    assert.deepEqual(rules((f) => {
      f["news/a-post/index.md"] = null;
    }), ["F3"]);
  });

  it("wants a manifest that agrees with the page", () => {
    const manifest = (patch) => (f) => {
      f["m.webmanifest"] = JSON.stringify({ ...MANIFEST, ...patch });
    };

    assert.deepEqual(rules(manifest({ "start_url": undefined })), ["F4"]);
    assert.deepEqual(rules(manifest({ scope: "/app/" })), ["F4"]);
    assert.deepEqual(rules(manifest({ "theme_color": "#ffffff" })), ["F4"]);
    assert.deepEqual(rules(manifest({ icons: [{ src: "/gone.png" }] })),
      ["F4"]);
  });
});
