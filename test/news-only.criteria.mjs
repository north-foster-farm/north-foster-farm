// Criteria tests for #916 (News posts: a setting to keep a post off the
// home page and other pages), one per tested box, named for it. Box 4,
// the setting described in docs/farm-news.md, is not a test. Read off
// the built site, from a copy of the content with fixture posts; where
// Hugo is not installed (CI's test job) this is skipped. Held out of
// npm test by its name until the change lands: renamed to
// news-only.test.mjs.
//
// Provisional, on the proposal James is asked to settle: the setting
// is `newsOnly: true` in a post's front matter, and the site search
// and the feed keep the post (the site builds no feed today). So box
// 3 checks the built HTML pages only; search.json and llms.txt, the
// machine-read lists, are not checked either way. A post's page links
// to the posts either side of it ("More news", rel prev and next):
// that is a way through the news, not a list, and is not checked.
//
// Two builds. In the first a fixture lead is marked `home: true` and
// the news-only post is the next newest, so it would take the first
// preview. In the second no post is marked and the news-only post is
// the newest, so it would be the home page's lead.
//
// The seam, what the tests rely on: each preview on the home page is
// an element marked `data-news-preview` whose first link goes to its
// post; the lead is `.home-update-card`, its title link
// `.news-header-link`.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { after, before, describe, it } from "node:test";

const root = join(import.meta.dirname, "..");
const hasHugo = spawnSync("hugo", ["version"]).status === 0;

const ONLY = "fixture-news-only";
const TITLE = "Fixture News Only";

const ago = (days) => new Date(Date.now() - days * 864e5)
  .toISOString().slice(0, 10);

const fixture = (title, days, front = "") => `---\ntitle: "${title}"\n` +
  `date: ${ago(days)}\n${front}---\n\nThe ducks found the puddle by ` +
  "the barn door and would not be moved from it until supper.\n";

const POSTS = {
  marked: {
    "fixture-lead": fixture("Fixture Lead", 1, "home: true\n"),
    [ONLY]: fixture(TITLE, 2, "newsOnly: true\n"),
    "fixture-a": fixture("Fixture A", 3),
    "fixture-b": fixture("Fixture B", 4),
    "fixture-c": fixture("Fixture C", 5),
    "fixture-d": fixture("Fixture D", 6),
  },
  newest: {
    [ONLY]: fixture(TITLE, 1, "newsOnly: true\n"),
    "fixture-a": fixture("Fixture A", 3),
    "fixture-b": fixture("Fixture B", 4),
  },
};

const build = (dir, posts) => {
  const content = join(dir, "content");
  const news = join(content, "news");
  const out = join(dir, "public");

  cpSync(join(root, "content"), content, { recursive: true });
  for (const f of readdirSync(news)) {
    const file = join(news, f);

    writeFileSync(file, readFileSync(file, "utf8")
      .replace(/^home: true\n/m, ""));
  }
  for (const [slug, body] of Object.entries(posts)) {
    writeFileSync(join(news, `${slug}.md`), body);
  }

  const run = spawnSync("hugo", ["--gc", "--logLevel", "warn",
    "--environment", "production", "-d", out, "--contentDir", content],
  { cwd: root, encoding: "utf8" });

  assert.equal(run.status, 0, run.stderr);

  return out;
};

const page = (out, path) => readFileSync(join(out, path, "index.html"),
  "utf8");

const slugOf = (href) => href.match(/\/news\/([^/]+)\/?(?:[#?].*)?$/)?.[1];

const previews = (html) => [...new Set([...html.matchAll(
  /<[a-z]+\s[^>]*\bdata-news-preview\b[^>]*>[\s\S]*?\shref="([^"]+)"/g,
)].map((m) => slugOf(m[1]) ?? m[1]))];

const leadOf = (html) => slugOf(html
  .match(/home-update-card[\s\S]*?class="news-header-link" href="([^"]+)"/)
  ?.[1] ?? "");

const linksTo = (html, slug) => new RegExp(
  `href="[^"]*/news/${slug}/?(?:[#?][^"]*)?"`).test(html);

const htmlFiles = (dir) => readdirSync(dir, { recursive: true })
  .filter((f) => f.endsWith(".html")).map((f) => join(dir, f));

describe("a post kept to the news page (#916)", { skip: !hasHugo }, () => {
  let dir;
  let marked;
  let newest;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), "nff-news-only-"));
    marked = build(join(dir, "marked"), POSTS.marked);
    newest = build(join(dir, "newest"), POSTS.newest);
  });

  after(() => rmSync(dir, { recursive: true, force: true }));

  it("A post with the setting does not appear in the home page's "
    + "previews, and the next post takes its place", () => {
    const html = page(marked, "");

    assert.equal(leadOf(html), "fixture-lead", "the marked lead leads");
    assert.deepEqual(previews(html), ["fixture-a", "fixture-b",
      "fixture-c"], "the three newest after the lead, less the post");
  });

  it("It appears in the news page's list and at its own address", () => {
    const list = page(marked, "news");
    const own = page(marked, `news/${ONLY}`);

    assert.ok(linksTo(list, ONLY), "the news page lists it");
    assert.match(own, new RegExp(`<h1[^>]*>\\s*${TITLE}\\s*</h1>`),
      "its own page heads it");
  });

  it("No other page's list of posts shows it", () => {
    for (const [name, out] of [["marked", marked], ["newest", newest]]) {
      const own = join(out, "news", ONLY, "index.html");
      const list = join(out, "news", "index.html");
      const shown = htmlFiles(out)
        .filter((f) => f !== own && f !== list
          && !/[/\\]news[/\\]page[/\\]/.test(f))
        .filter((f) => linksTo(readFileSync(f, "utf8")
          .replace(/<nav class="news-nav[\s\S]*?<\/nav>/g, ""), ONLY))
        .map((f) => relative(out, f));

      assert.deepEqual(shown, [], `${name}: pages that list it`);
    }
    assert.equal(leadOf(page(newest, "")), "fixture-a",
      "newest: the newest post without the setting leads the home page");
  });
});
