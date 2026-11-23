// Criteria tests for #914 (Home page news previews: layout by width,
// new default image, button and eyebrow), the boxes about markup and
// text, read off the built HTML. One test per box, named for it:
//
// - box 5, the default thumbnail is the new image;
// - box 6, the button below the thumbnails reads "All news and
//   updates";
// - box 8, the home page's sign-up button reads "Sign up for Farm
//   News".
//
// The layout, shadow, alignment and bar boxes are
// e2e/home-news-layout.criteria.mjs. Built from a copy of the site's
// content with fixture posts, so that one preview is always a post with
// no picture of its own: a lead, then a post with none, then two with
// one. Where Hugo is not installed (CI's test job) this is skipped.
// Held out of npm test by its name until the change lands: renamed to
// home-news-copy.test.mjs.
//
// Provisional, on the readings the issue asks James to confirm:
// box 6 reads "More from the farm" and "All news and updates" as one
// button, the one under the previews, so this checks its text there;
// the foot of a post is not named and is not checked.
//
// The seam, what the tests rely on:
// - The new image is assets/images/farm-news-default in a web format
//   (.webp, .avif, .jpg, .jpeg or .png), converted from
//   ~/Code/nff/farm-news-default.tiff. Hugo keeps a processed image's
//   name at the front of its file name, so the thumbnail's src starts
//   with it.
// - Each preview on the home page is an element marked
//   `data-news-preview`, and its first link goes to its post; its
//   thumbnail is the `img` inside its `.news-thumb`. The news page's
//   rows are `li.news-item` with the same `.news-thumb`.
// - The band is `.home-update`; the sign-up is the link marked
//   `data-farm-list-jump` in it.

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

const NEW = "farm-news-default";
const WEB = /\.(webp|avif|jpe?g|png)$/;
const PICTURE = "images/chicks.jpg";

const ago = (days) => new Date(Date.now() - days * 864e5)
  .toISOString().slice(0, 10);

const fixture = (title, days, front = "") => `---\ntitle: "${title}"\n` +
  `date: ${ago(days)}\n${front}---\n\nThe geese walked the fence line ` +
  "twice before they settled under the apple tree for the afternoon.\n";

const FIXTURES = {
  "fixture-lead": fixture("Fixture Lead", 2, "home: true\n"),
  "fixture-bare": fixture("Fixture Bare", 3),
  "fixture-shot": fixture("Fixture Shot", 4, `featured: ${PICTURE}\n`),
  "fixture-snap": fixture("Fixture Snap", 5, `featured: ${PICTURE}\n`),
};

const attrs = (tag) => Object.fromEntries([...tag.matchAll(
  /\s([a-z-]+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));

// A thumbnail as it is served: where it comes from, its format, and the
// sizes the page asks for.
const served = (block) => {
  const thumb = block.match(/class="news-thumb"[\s\S]*?<\/a>/)?.[0] ?? "";
  const img = thumb.match(/<img\s[^>]*>/)?.[0];

  if (!img) return null;

  const a = attrs(img);
  const file = a.src.split("?")[0].split("/").pop();

  return {
    file,
    format: file.match(/\.[a-z]+$/)?.[0],
    width: a.width,
    height: a.height,
    srcset: (a.srcset ?? "").split(",").map((s) => s.trim().split(/\s+/)[1])
      .filter(Boolean),
    sizes: a.sizes ?? null,
  };
};

const slugOf = (block) => block.match(/\shref="[^"]*\/news\/([^/"]+)\/"/)?.[1];

const previewsOf = (html) => html
  .split(/(?=<[a-z]+\s[^>]*\bdata-news-preview\b)/).slice(1)
  .map((block) => ({ slug: slugOf(block), thumb: served(block) }));

const rowsOf = (html) => html.split(/(?=<li class="news-item)/).slice(1)
  .map((block) => ({ slug: slugOf(block), thumb: served(block) }));

const text = (html) => html.replace(/<[^>]+>/g, " ")
  .replace(/\s+/g, " ").trim();

// The band, from its opening tag to the one that closes it.
const bandOf = (html) => {
  const start = html.search(/<div class="home-update[\s"]/);

  if (start < 0) return "";

  let depth = 0;

  for (const m of html.slice(start).matchAll(/<(\/?)div[\s>]/g)) {
    depth += m[1] ? -1 : 1;
    if (depth === 0) return html.slice(start, start + m.index + m[0].length);
  }

  return html.slice(start);
};

describe("home news previews: image and words (#914)",
  { skip: !hasHugo }, () => {
    let dir;
    let home;
    let news;

    before(() => {
      dir = mkdtempSync(join(tmpdir(), "nff-home-copy-"));

      const content = join(dir, "content");
      const posts = join(content, "news");
      const out = join(dir, "public");

      cpSync(join(root, "content"), content, { recursive: true });
      for (const f of readdirSync(posts)) {
        const file = join(posts, f);

        writeFileSync(file, readFileSync(file, "utf8")
          .replace(/^home: true\n/m, ""));
      }
      for (const [slug, body] of Object.entries(FIXTURES)) {
        writeFileSync(join(posts, `${slug}.md`), body);
      }

      const run = spawnSync("hugo", ["--gc", "--logLevel", "warn",
        "--environment", "production", "-d", out, "--contentDir", content],
      { cwd: root, encoding: "utf8" });

      assert.equal(run.status, 0, run.stderr);
      home = readFileSync(join(out, "index.html"), "utf8");
      news = readFileSync(join(out, "news", "index.html"), "utf8");
    });

    after(() => rmSync(dir, { recursive: true, force: true }));

    it("The default thumbnail is the new image, from "
      + "farm-news-default.tiff, served in a web format with the sizes "
      + "the others have", () => {
      const asset = readdirSync(join(root, "assets", "images"))
        .find((f) => f.startsWith(`${NEW}.`));

      assert.ok(asset, `assets/images/${NEW} is in the repository`);
      assert.match(asset, WEB, `${asset} is a web format`);

      for (const [where, items] of [["home page", previewsOf(home)],
        ["news page", rowsOf(news)]]) {
        const bare = items.find((i) => i.slug === "fixture-bare");
        const others = items.filter((i) => i.slug?.startsWith("fixture-s"));

        assert.ok(bare, `${where}: the post with no picture is shown`);
        assert.ok(bare.thumb, `${where}: its thumbnail is an image`);
        assert.ok(bare.thumb.file.startsWith(NEW),
          `${where}: ${bare.thumb.file} is made from ${asset}`);
        assert.ok(others.length > 0, `${where}: posts with pictures`);
        for (const other of others) {
          assert.ok(other.thumb, `${where}: ${other.slug} has its picture`);
          assert.deepEqual(
            { ...bare.thumb, file: undefined },
            { ...other.thumb, file: undefined },
            `${where}: served as ${other.slug}'s is`);
        }
      }
    });

    it("The button below the thumbnails reads All news and updates", () => {
      const band = bandOf(home);
      const tail = band.split(/\bdata-news-preview\b/).at(-1);
      const link = tail
        .match(/<a\s[^>]*href="[^"]*\/news\/"[^>]*>[\s\S]*?<\/a>/);

      assert.ok(link, "a link to the news page after the previews");
      assert.equal(text(link[0]), "All news and updates");
      assert.doesNotMatch(text(band), /More from the farm/);
    });

    it("The home page's sign-up button reads Sign up for Farm News", () => {
      const band = bandOf(home);
      const jump = band
        .match(/<a\s[^>]*data-farm-list-jump[^>]*>[\s\S]*?<\/a>/);

      assert.ok(jump, "the sign-up link in the band");
      assert.equal(text(jump[0]), "Sign up for Farm News");
      assert.doesNotMatch(text(home), /Sign up for news like this/);
    });
  });
