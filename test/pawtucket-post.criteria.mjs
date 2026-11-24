// Criteria tests for #545 (Pawtucket: Farm News post), James's final
// update of 2026-11-24, read off built HTML. One test per criterion,
// in his words, named for it:
//
// 1. "The Pawtucket news post should use this video as its main
//    graphic: ~/Code/nff/pawtucket-market-video" (its
//    pawtucket-market-web.mp4 and .webm, and
//    pawtucket-market-poster.jpg);
// 2. "Title: "Market in the Jungle"";
// 3. "Intro: No matter how cold it is outside, we'll be warm on
//    Tuesdays. Find us inside Jordan's Jungle at the Pawtucket Farmers
//    Market from now through April.";
// 4. "I have a new placeholder image for news posts too"
//    (news-placeholder-v2.tiff), which replaces the default thumbnail;
// 5. "I don't see the draft post on the home page": in a build with
//    drafts, as staging builds, the post is the home page's lead.
//
// One guard, which passes today and must keep passing: the post stays
// a draft, so a production build leaves it out, home page included.
//
// Readings, for the coordinator to correct:
// - "Main graphic" is the post's first picture, which is also what
//   its thumbnail is cut from (news/featured.html): the first picture
//   in the post's body is the video, and the post's thumbnail on the
//   news page is made from the video's poster. Where the egg basket
//   goes, or whether it stays, is not checked.
// - "Intro" is the post's first paragraph, word for word. The
//   description (search results and share card) is not checked.
// - "Replaces" keeps the default thumbnail's name: it is still made
//   from assets/images/farm-news-default in a web format, so
//   test/home-news-copy.test.mjs and e2e/home-news-layout.spec.mjs
//   hold as they are, and this checks only that the picture there is
//   no longer today's.
//
// The seam, what the tests rely on:
// - The post is content/news/pawtucket-farmers-market.md, at
//   /news/<its slug>/ (the slug from its front matter, else its file
//   name). Its page's title is the h1 `.news-header-title`, its body
//   the `.prose` after it.
// - The video is the video shortcode's `figure.video-figure`: a
//   `video` whose `poster` and `source` files keep the names James
//   gave them, as Hugo keeps a processed image's name at the front of
//   its file name.
// - The home page's lead is the `.home-update-card`, whose title links
//   to its post; the news page's rows are `li.news-item`, each with
//   its thumbnail `img` inside `.news-thumb`.
//
// Where Hugo is not installed (CI's test job) this is skipped. Held
// out of npm test by its name until the change lands: renamed to
// pawtucket-post.test.mjs.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync, mkdtempSync, readFileSync, readdirSync, rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

const root = join(import.meta.dirname, "..");
const hasHugo = spawnSync("hugo", ["version"]).status === 0;

const POST = join(root, "content", "news", "pawtucket-farmers-market.md");
const TITLE = "Market in the Jungle";
const INTRO = "No matter how cold it is outside, we'll be warm on "
  + "Tuesdays. Find us inside Jordan's Jungle at the Pawtucket Farmers "
  + "Market from now through April.";
const VIDEO = "pawtucket-market-web";
const POSTER = "pawtucket-market-poster";
const DEFAULT = "farm-news-default";
const WEB = /\.(webp|avif|jpe?g|png)$/;

// The SHA-256 of assets/images/farm-news-default.jpg on next at
// aa7a8990: the picture made from farm-news-default.tiff (#914) that
// the new one replaces.
const OLD_DEFAULT =
  "de8e41768d0693a9d8a0a4cc55cfa64fec9870171668ebc7685edd69acc8f1cc";

const slug = () => readFileSync(POST, "utf8")
  .match(/^slug:\s*"?([^"\n]+?)"?\s*$/m)?.[1]
  ?? "pawtucket-farmers-market";

const build = (dir, flags) => {
  const run = spawnSync("hugo", ["--gc", "--logLevel", "warn",
    "--environment", "production", "-d", dir, ...flags],
  { cwd: root, encoding: "utf8" });

  assert.equal(run.status, 0, run.stderr);
};

const read = (dir, ...path) => {
  const file = join(dir, ...path);

  return existsSync(file) ? readFileSync(file, "utf8") : null;
};

// Text as a reader sees it: tags gone, entities and curly quotes
// plain, spaces single.
const text = (html) => html.replace(/<[^>]+>/g, " ")
  .replaceAll("&nbsp;", " ").replaceAll("&rsquo;", "'")
  .replaceAll("&#39;", "'").replaceAll("&amp;", "&")
  .replace(/[‘’]/g, "'").replace(/\s+/g, " ").trim();

const attrs = (tag) => Object.fromEntries([...tag.matchAll(
  /\s([a-z-]+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));

const fileOf = (url) => (url ?? "").split("?")[0].split("/").pop();

const proseOf = (page) => page.slice(page.indexOf('class="prose"'));

// The body's first picture: a figure whole, or else the first video,
// embed or image tag.
const firstPicture = (prose) => {
  const at = prose.search(/<(?:figure|video|iframe|img)[\s>]/);

  if (at < 0) return "";

  const rest = prose.slice(at);

  if (!rest.startsWith("<figure")) return rest.match(/^[^>]*>/)[0];

  return rest.slice(0, rest.indexOf("</figure>") + "</figure>".length);
};

describe("Pawtucket post: James's final update (#545)",
  { skip: !hasHugo }, () => {
    let dir;
    let drafts;
    let production;
    let path;

    before(() => {
      dir = mkdtempSync(join(tmpdir(), "nff-pawtucket-"));
      drafts = join(dir, "drafts");
      production = join(dir, "production");
      path = ["news", slug(), "index.html"];
      build(drafts, ["--buildDrafts", "--buildFuture", "--buildExpired"]);
      build(production, []);
    });

    after(() => rmSync(dir, { recursive: true, force: true }));

    it("The post uses the Pawtucket market video as its main graphic",
      () => {
        const page = read(drafts, ...path);

        assert.ok(page, `${path.join("/")} is built with drafts`);

        const first = firstPicture(proseOf(page));

        assert.match(first, /^<figure\s[^>]*\bvideo-figure\b/,
          "the post's first picture is a video");

        const video = attrs(first.match(/<video\s[^>]*>/)?.[0] ?? "");
        const sources = [...first.matchAll(/<source\s[^>]*>/g)]
          .map((m) => fileOf(attrs(m[0]).src)).sort();

        assert.deepEqual(sources, [`${VIDEO}.mp4`, `${VIDEO}.webm`],
          "its encodes are the market video's");
        assert.ok(fileOf(video.poster).startsWith(POSTER),
          `its poster, ${fileOf(video.poster)}, is made from ${POSTER}`);

        const news = read(drafts, "news", "index.html");
        const row = news.split(/(?=<li class="news-item)/).slice(1)
          .find((r) => r.includes(`/news/${slug()}/"`)) ?? "";
        const thumb = row.match(/class="news-thumb"[\s\S]*?<\/a>/)?.[0];
        const img = attrs(thumb?.match(/<img\s[^>]*>/)?.[0] ?? "");

        assert.ok(row, "the post has a row on the news page");
        assert.ok(fileOf(img.src).startsWith(POSTER),
          `its thumbnail, ${fileOf(img.src)}, is cut from the poster`);
      });

    it("The post's title is Market in the Jungle", () => {
      const page = read(drafts, ...path);

      assert.ok(page, `${path.join("/")} is built with drafts`);

      const h1 = page.match(
        /<h1 class="news-header-title[^"]*">([\s\S]*?)<\/h1>/)?.[1];
      const tab = page.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? "";

      assert.equal(text(h1 ?? ""), TITLE, "the post's heading");
      assert.ok(text(tab).startsWith(TITLE),
        `the page's title, ${text(tab)}, names the post`);
    });

    it("The post's intro is No matter how cold it is outside", () => {
      const page = read(drafts, ...path);

      assert.ok(page, `${path.join("/")} is built with drafts`);

      const body = proseOf(page).replace(/<figure[\s\S]*?<\/figure>/g, "");
      const first = body.match(/<p[\s>][\s\S]*?<\/p>/)?.[0] ?? "";

      assert.equal(text(first), INTRO, "the post's first paragraph");
    });

    it("The default news thumbnail is the new placeholder image", () => {
      const images = join(root, "assets", "images");
      const asset = readdirSync(images)
        .find((f) => f.startsWith(`${DEFAULT}.`));

      assert.ok(asset, `assets/images/${DEFAULT} is in the repository`);
      assert.match(asset, WEB, `${asset} is a web format`);

      const sha = createHash("sha256")
        .update(readFileSync(join(images, asset))).digest("hex");

      assert.notEqual(sha, OLD_DEFAULT,
        `${asset} is the new placeholder, not today's picture`);
    });

    it("The draft post shows on the home page in a build with drafts",
      () => {
        const home = read(drafts, "index.html");
        const card = home.match(
          /<article class="home-update-card[\s\S]*?<\/article>/)?.[0] ?? "";
        const link = attrs(card.match(
          /<a class="news-header-link"[^>]*>/)?.[0] ?? "").href ?? "";

        assert.ok(card, "the home page has its news card");
        assert.ok(link.endsWith(`/news/${slug()}/`),
          `the home page's lead, ${link}, is the Pawtucket post`);
      });

    it("The post stays a draft: production builds neither it nor its "
      + "place on the home page", () => {
      const home = read(production, "index.html");

      assert.equal(read(production, ...path), null,
        `${path.join("/")} is not in a production build`);
      assert.doesNotMatch(home, new RegExp(`/news/${slug()}/`),
        "the production home page does not link to it");
    });
  });
