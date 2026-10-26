import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { checkPosts, urlize, urlOf } from "../bin/check-news.mjs";

const post = (file, front) => ({ file, text: `---\n${front}\n---\n\nBody.\n` });

describe("news post URLs", () => {
  it("makes the address from the title, as Hugo does", () => {
    assert.equal(urlize("Mid-Winter Update"), "mid-winter-update");
    assert.equal(urlize("Update: New Farmers Market Schedule"),
      "update-new-farmers-market-schedule");
    assert.equal(urlize("2026 Update"), "2026-update");
  });

  it("prefers a post's own slug", () => {
    const text = post("a.md", 'title: "June Update"\nslug: "june-2025-update"')
      .text;
    assert.equal(urlOf(text), "/news/june-2025-update/");
  });

  it("passes posts with their own titles and URLs", () => {
    assert.deepEqual(checkPosts([
      post("2025-05-30-june-update.md",
        'title: "June 2025 Update"\nslug: "june-2025-update"'),
      post("2026-06-01-june-update.md", 'title: "June Update"'),
    ]), []);
  });

  it("fails a reused title, even with a distinct slug", () => {
    const errors = checkPosts([
      post("a.md", 'title: "June Update"'),
      post("b.md", 'title: "June Update"\nslug: "june-2025-update"'),
    ]);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /share the title "June Update"/);
  });

  it("fails two posts that land on one URL", () => {
    const errors = checkPosts([
      post("a.md", 'title: "Fall Update"'),
      post("b.md", 'title: "Fall: Update"'),
    ]);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /share the URL \/news\/fall-update\//);
  });

  it("holds the real posts to it", () => {
    const dir = new URL("../content/news/", import.meta.url);
    const posts = readdirSync(dir)
      .filter((f) => f.endsWith(".md") && f !== "_index.md")
      .map((file) => ({
        file, text: readFileSync(new URL(file, dir), "utf8"),
      }));
    assert.deepEqual(checkPosts(posts), []);
  });

  it("redirects every dated address a post once had", () => {
    const toml = readFileSync(new URL("../netlify.toml", import.meta.url),
      "utf8");
    const dir = new URL("../content/news/", import.meta.url);
    for (const file of readdirSync(dir)) {
      if (!/^\d{4}-\d\d-\d\d-/.test(file)) continue;
      const to = urlOf(readFileSync(new URL(file, dir), "utf8"));
      assert.ok(toml.includes(
        `from = "/news/${file.replace(/\.md$/, "")}/"\n  to = "${to}"\n` +
        "  status = 301"), file);
    }
  });
});
