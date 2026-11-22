// Criteria test for #566 (Home news: preview the second and third most
// recent posts as thumbnails), box 2: unpublished or future-dated
// posts never appear. Read off the built home page, from a copy of the
// site's content with fixture posts: a lead, three older published
// posts, and a draft and a future-dated post newer than all of them.
// Built twice, as production builds it and as staging, deploy
// previews and the e2e build do (--buildDrafts --buildFuture
// --buildExpired, netlify.toml), since "never" covers both. In each,
// the three places go to the three newest published posts after the
// lead, so neither the draft nor the future post took one. Where Hugo
// is not installed (CI's test job) this is skipped. Box 1, the layout,
// is e2e/home-news.criteria.mjs.
// Held out of npm test by its name until the change lands: renamed to
// home-news.test.mjs.
//
// The seam, what the test relies on: each preview on the home page is
// an element marked `data-news-preview` whose first link goes to its
// post. A preview may appear in the markup more than once (one copy
// per width); only the order of first appearance counts.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

const root = join(import.meta.dirname, "..");
const hasHugo = spawnSync("hugo", ["version"]).status === 0;

const STAGING = ["--buildDrafts", "--buildFuture", "--buildExpired"];

const build = (out, content, args = []) => {
  const run = spawnSync("hugo", ["--gc", "--logLevel", "warn",
    "--environment", "production", "-d", out, "--contentDir", content,
    ...args], { cwd: root, encoding: "utf8" });

  assert.equal(run.status, 0, run.stderr);
};

const day = (offset) => new Date(Date.now() + offset * 864e5)
  .toISOString().slice(0, 10);

const post = (title, front) => `---\ntitle: "${title}"\n${front}---\n\n` +
  "The hens came down the ramp and out onto the wet grass before the " +
  "fog had lifted off the far field.\n";

const FIXTURES = {
  "fixture-lead": post("Fixture Lead", `date: ${day(-2)}\nhome: true\n`),
  "fixture-second": post("Fixture Second", `date: ${day(-3)}\n`),
  "fixture-third": post("Fixture Third", `date: ${day(-4)}\n`),
  "fixture-fourth": post("Fixture Fourth", `date: ${day(-5)}\n`),
  "fixture-draft": post("Fixture Draft", `date: ${day(-1)}\ndraft: true\n`),
  "fixture-future": post("Fixture Future", `date: ${day(30)}\n`),
};

// The posts the home page previews, by slug, in order.
const previews = (out) => {
  const html = readFileSync(join(out, "index.html"), "utf8");
  const found = [...html.matchAll(
    /<[a-z]+\s[^>]*\bdata-news-preview\b[^>]*>[\s\S]*?\shref="([^"]+)"/g
  )].map((m) => m[1].match(/\/news\/([^/]+)\/?$/)?.[1] ?? m[1]);

  return [...new Set(found)];
};

describe("home news previews leave out drafts and future posts (#566)",
  { skip: !hasHugo }, () => {
    let dir;
    let production;
    let staging;

    before(() => {
      dir = mkdtempSync(join(tmpdir(), "nff-home-news-"));

      const content = join(dir, "content");
      const news = join(content, "news");

      cpSync(join(root, "content"), content, { recursive: true });
      // The fixture lead is the home page's post: no other is marked.
      for (const f of readdirSync(news)) {
        const file = join(news, f);

        writeFileSync(file, readFileSync(file, "utf8")
          .replace(/^home: true\n/m, ""));
      }
      for (const [slug, text] of Object.entries(FIXTURES)) {
        writeFileSync(join(news, `${slug}.md`), text);
      }

      production = join(dir, "production");
      staging = join(dir, "staging");
      build(production, content);
      build(staging, content, STAGING);
    });

    after(() => rmSync(dir, { recursive: true, force: true }));

    it("unpublished or future-dated posts never appear", () => {
      const want = ["fixture-second", "fixture-third", "fixture-fourth"];

      for (const [name, out] of [["production", production],
        ["staging", staging]]) {
        const shown = previews(out);

        assert.deepEqual(shown, want,
          `${name}: the three newest published posts after the lead`);
        for (const hidden of ["fixture-draft", "fixture-future",
          "pawtucket-farmers-market"]) {
          assert.ok(!shown.includes(hidden), `${name}: no ${hidden}`);
        }
      }
    });
  });
