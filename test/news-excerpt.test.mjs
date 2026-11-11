// #537: the home page shows the latest post as an excerpt, cut at a
// block of text, with "Continue reading" to the first block it leaves
// out, which the post's own page marks data-continue. Read off the
// built HTML: the site as it stands, then a copy of its content with
// fixture posts for the rule's edges. Where Hugo is not installed
// (CI's test job), CI's build job builds the pages and this is skipped.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

const root = join(import.meta.dirname, "..");
const hasHugo = spawnSync("hugo", ["version"]).status === 0;

// Builds the site into out; returns what Hugo logged, its warnings
// among it.
const build = (out, args = []) => {
  const run = spawnSync("hugo", ["--gc", "--logLevel", "warn",
    "--environment", "production", "-d", out, ...args],
  { cwd: root, encoding: "utf8" });

  assert.equal(run.status, 0, run.stderr);

  return `${run.stdout}${run.stderr}`;
};

const read = (out, path) => readFileSync(join(out, path, "index.html"),
  "utf8");

// The blocks of a post's body, as news/split.html cuts them: a block
// runs from a line that opens one to the line where its tags balance.
const TAGS = "(?:p|h[1-6]|figure|ul|ol|blockquote|div|table|pre|dl|" +
  "section|aside|details)";
const OPEN = new RegExp(`<${TAGS}[\\s>]`, "g");
const CLOSE = new RegExp(`</${TAGS}>`, "g");

const split = (html) => {
  const blocks = [];
  let lines = [];
  let depth = 0;

  for (const line of html.split("\n")) {
    if (depth === 0 && !line.trim()) continue;
    lines.push(line);
    depth += (line.match(OPEN) || []).length;
    depth -= (line.match(CLOSE) || []).length;
    if (depth <= 0) {
      blocks.push(lines.join("\n"));
      lines = [];
      depth = 0;
    }
  }

  return blocks;
};

const text = (html) => html
  .replace(/<[^>]+>/g, " ")
  .replace(/&rsquo;|&lsquo;/g, "'")
  .replace(/&rdquo;|&ldquo;|&quot;/g, "\"")
  .replace(/&amp;/g, "&")
  .replace(/&[a-z]+;|&#\d+;/g, " ")
  .replace(/\s+/g, " ")
  .trim();

const words = (html) => text(html).split(" ").filter(Boolean).length;

// The body of a post: the .prose div, which a news-continue link or
// the footer follows.
const prose = (html) => {
  const m = html.match(new RegExp("<div class=\"prose\">([\\s\\S]*?)" +
    "</div>\\s*(?:<p class=\"news-continue\">|<div class=\"news-footer\">)"));

  assert.ok(m, "a .prose body");

  return split(m[1]);
};

const id = (block) => block.match(/^\s*<[a-z0-9]+[^>]*\sid="([^"]+)"/)?.[1];
const isText = (block) => /^\s*<(?:p|ul|ol|blockquote|table)[\s>]/
  .test(block) && !/^\s*<p[^>]*class="sign-off"/.test(block) &&
  !/^\s*<p>\s*(?:<a [^>]*>\s*)?<img /.test(block);

// Where a post's own page says its excerpt ends: the blocks before
// the one marked data-continue, and that one's id.
const cut = (blocks) => {
  const at = blocks.findIndex((b) => /^\s*<[a-z0-9]+[^>]*\sdata-continue/
    .test(b));

  return at < 0 ? { at, anchor: "" } : { at, anchor: id(blocks[at]) };
};

// The home page's card: its blocks, and its Continue reading link.
const card = (html) => {
  const m = html.match(/<article class="home-update-card[\s\S]*?<\/article>/);

  assert.ok(m, "the home page's news card");

  return {
    html: m[0],
    blocks: prose(m[0]),
    link: m[0].match(/<p class="news-continue">\s*<a href="([^"]+)">/)?.[1],
  };
};

const posts = (out) => readdirSync(join(out, "news"))
  .filter((d) => existsSync(join(out, "news", d, "index.html")) &&
    d !== "page")
  .map((d) => ({ slug: d, html: read(out, `news/${d}`) }))
  .filter((p) => p.html.includes('<div class="prose">'));

describe("news excerpt, the site as built", { skip: !hasHugo }, () => {
  let out;

  before(() => {
    out = mkdtempSync(join(tmpdir(), "nff-excerpt-"));
    build(out);
  });

  after(() => rmSync(out, { recursive: true, force: true }));

  it("gives every block of every post an id, once", () => {
    for (const { slug, html } of posts(out)) {
      const ids = prose(html).map(id);

      assert.ok(ids.every(Boolean), `${slug}: a block without an id`);
      assert.equal(new Set(ids).size, ids.length, `${slug}: a repeated id`);
    }
  });

  it("cuts every long post after a block of text that ends a sentence",
    () => {
      const long = posts(out).filter((p) => words(p.html.match(
        /<div class="prose">[\s\S]*?<div class="news-footer">/)[0]) > 300);

      assert.ok(long.length >= 5, "the site has long posts to cut");
      for (const { slug, html } of long) {
        const blocks = prose(html);
        const { at, anchor } = cut(blocks);
        const last = blocks[at - 1];

        assert.ok(at > 0, `${slug}: long, so cut`);
        assert.ok(anchor, `${slug}: the anchor has an id`);
        assert.ok(isText(last), `${slug}: ends on text, not ${last}`);
        assert.match(text(last), /[.!?]["')’”]*$/,
          `${slug}: ends a sentence`);

        const shown = blocks.slice(0, at).reduce((n, b) => n + words(b), 0);

        assert.ok(shown >= 60 && shown <= 300,
          `${slug}: a good length (${shown} words)`);
      }
    });

  it("shows a short post whole", () => {
    const short = posts(out).filter((p) => words(p.html.match(
      /<div class="prose">[\s\S]*?<div class="news-footer">/)[0]) < 150);

    assert.ok(short.length >= 3, "the site has short posts");
    for (const { slug, html } of short) {
      assert.equal(cut(prose(html)).at, -1, `${slug}: shown whole`);
    }
  });

  it("shows the home post's excerpt and links to where it leaves off",
    () => {
      const home = card(read(out, ""));
      const slug = home.html
        .match(/class="news-header-link" href="[^"]*news\/([^/"]+)\//)[1];
      const blocks = prose(read(out, `news/${slug}`));
      const { at, anchor } = cut(blocks);

      assert.ok(at > 0, "the home post is long enough to cut");
      assert.deepEqual(home.blocks.map(text),
        blocks.slice(0, at).map(text));
      assert.match(home.link, new RegExp(`news/${slug}/#${anchor}$`));
    });

  it("heads the band as James wrote, and the post under it", () => {
    const html = read(out, "");
    const intro = html
      .match(/<div class="[^"]*home-update-intro[\s\S]*?<\/h2>/);

    assert.ok(intro, "the eyebrow and title before the card");
    assert.match(intro[0], /<p class="home-eyebrow">Learn more<\/p>/);
    assert.match(intro[0],
      /<h2 class="home-title">Farm news and updates<\/h2>/);
    assert.match(card(html).html, /<h3 class="news-header-title/);
    assert.doesNotMatch(card(html).html, /<h2[\s>]/);
  });
});

// A paragraph of plain sentences, n words long, ending in `end`.
const para = (n, end = ".") => {
  const pool = ("the hens came down the ramp and out onto the wet grass " +
    "before the fog had lifted off the far field").split(" ");
  const out = Array.from({ length: n }, (_, i) => pool[i % pool.length]);

  out[0] = "The";

  return `${out.join(" ")}${end}`;
};

const post = (title, front, body) =>
  `---\ntitle: "${title}"\n${front}---\n\n${body.join("\n\n")}\n`;

describe("news excerpt, at the rule's edges", { skip: !hasHugo }, () => {
  let out;
  let content;
  let warnings;

  before(() => {
    const dir = mkdtempSync(join(tmpdir(), "nff-excerpt-fx-"));

    out = join(dir, "public");
    content = join(dir, "content");
    cpSync(join(root, "content"), content, { recursive: true });

    // The short fixture is the home page's post: no other is marked.
    const news = join(content, "news");

    for (const f of readdirSync(news)) {
      const file = join(news, f);

      writeFileSync(file, readFileSync(file, "utf8")
        .replace(/^home: true\n/m, ""));
    }

    const day = new Date(Date.now() - 2 * 864e5).toISOString().slice(0, 10);
    const fixtures = {
      "fixture-short": post("Fixture Short", `date: ${day}\nhome: true\n`,
        [para(40), para(50)]),
      "fixture-marker": post("Fixture Marker", "date: 2020-01-01\n",
        [para(20), "<!--more-->", para(200), "## Later", para(200)]),
      "fixture-front": post("Fixture Front",
        "date: 2020-01-02\nexcerpt: later-2\n",
        [para(150), "## Later", para(30), para(150), para(150)]),
      "fixture-whole": post("Fixture Whole", "date: 2020-01-03\n" +
        "excerpt: whole\n", [para(200), "## Later", para(200)]),
      "fixture-colon": post("Fixture Colon", "date: 2020-01-04\n",
        [para(130, ":"), "- one\n- two\n- three", para(200), para(200)]),
      "fixture-heading": post("Fixture Heading", "date: 2020-01-05\n",
        [para(100), "## Next", para(100), "## After", para(200)]),
      // Counted as text, the empty embed would be the boundary nearest
      // 120 words, and the excerpt would end on it.
      "fixture-video": post("Fixture Video", "date: 2020-01-06\n",
        [para(100), "{{< youtube abc123 >}}", para(200)]),
      // Cuts the post sets in the wrong places: kept, with a warning.
      "fixture-set-heading": post("Fixture Set Heading",
        "date: 2020-01-07\nexcerpt: later-1\n",
        [para(150), "## Later", para(150), para(150)]),
      "fixture-set-picture": post("Fixture Set Picture", "date: 2020-01-08\n",
        [para(150), "{{< youtube abc123 >}}", "<!--more-->", para(200)]),
      "fixture-set-colon": post("Fixture Set Colon",
        "date: 2020-01-09\nexcerpt: later-2\n",
        [para(150), "## Later", para(150, ":"), para(150)]),
    };

    for (const [slug, text] of Object.entries(fixtures)) {
      writeFileSync(join(news, `${slug}.md`), text);
    }

    warnings = build(out, ["--contentDir", content]);
  });

  after(() => rmSync(join(out, ".."), { recursive: true, force: true }));

  const blocksOf = (slug) => prose(read(out, `news/${slug}`));

  it("shows a short post whole on the home page, with no link", () => {
    const home = card(read(out, ""));

    assert.match(home.html, /Fixture Short/);
    assert.equal(home.link, undefined);
    assert.equal(home.blocks.length, 2);
    assert.equal(cut(blocksOf("fixture-short")).at, -1);
  });

  it("lets the post's <!--more--> marker win", () => {
    const blocks = blocksOf("fixture-marker");
    const { at } = cut(blocks);

    assert.equal(at, 1);
    assert.equal(words(blocks[0]), 20);
    assert.doesNotMatch(read(out, "news/fixture-marker"), /<!--more-->/);
  });

  it("lets front matter name the block to stop before", () => {
    assert.deepEqual(cut(blocksOf("fixture-front")),
      { at: 3, anchor: "later-2" });
  });

  it("lets front matter show a long post whole", () => {
    assert.equal(cut(blocksOf("fixture-whole")).at, -1);
  });

  it("never ends on a colon, leaving its list behind", () => {
    const blocks = blocksOf("fixture-colon");
    const { at } = cut(blocks);

    assert.equal(at, 2);
    assert.match(blocks[at - 1], /^<ul/);
  });

  it("keeps a heading with the paragraph after it", () => {
    const blocks = blocksOf("fixture-heading");
    const { at, anchor } = cut(blocks);

    assert.equal(at, 3);
    assert.match(blocks[1], /^<h2 id="next"/);
    assert.equal(anchor, "after");
    assert.deepEqual(blocks.map(id),
      ["part-1", "next", "next-1", "after", "after-1"]);
  });

  it("never ends on an embed, which counts as a picture", () => {
    const blocks = blocksOf("fixture-video");
    const { at } = cut(blocks);

    assert.equal(at, 1);
    assert.match(blocks[at], /^\s*<div[^>]*class="ratio /);
  });

  it("warns when a cut the post sets ends on a heading, picture or colon",
    () => {
      for (const [slug, by, after] of [
        ["fixture-set-heading", "excerpt: later-1", "a heading"],
        ["fixture-set-picture", "<!--more-->", "a picture"],
        ["fixture-set-colon", "excerpt: later-2", "text ending in a colon"],
      ]) {
        assert.ok(cut(blocksOf(slug)).at > 0, `${slug}: the cut is kept`);
        assert.ok(warnings.includes(`news: ${by} ends the excerpt after ` +
          `${after} (news/${slug}.md)`), `${slug}: warned\n${warnings}`);
      }
      assert.doesNotMatch(warnings,
        /news: \S+ ends the excerpt after .*fixture-(?:front|marker)/);
    });
});
