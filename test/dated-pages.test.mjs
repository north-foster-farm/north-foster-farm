import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  datedPages, frontMatterDate, lastUpdated, summary, warnings,
} from "../bin/dated-pages.mjs";

describe("dated pages: reading a date", () => {
  it("reads the front matter date, quoted or not", () => {
    assert.equal(frontMatterDate("---\ntitle: x\ndate: 2026-10-18\n---\n"),
      "2026-10-18");
    assert.equal(frontMatterDate('---\ndate: "2026-10-18"\n---\n'),
      "2026-10-18");
    assert.equal(frontMatterDate("no front matter"), "");
  });

  it("reads the Last updated line without its period", () => {
    assert.equal(lastUpdated("Intro.\n\nLast updated October 24, 2026.\n"),
      "October 24, 2026");
    assert.equal(lastUpdated("Nothing here."), "");
  });
});

describe("dated pages: which files count", () => {
  const texts = {
    "content/news/a.md": "---\ndate: 2026-10-18\n---\nBody",
    "content/news/_index.md": "---\ntitle: News\n---\n",
    "content/privacy.md": "---\ntitle: P\n---\nLast updated May 1, 2026.\n",
    "content/about.md": "---\ntitle: A\n---\nNo date.\n",
    "layouts/index.html": "Last updated today",
  };
  const read = (file) => texts[file];

  it("keeps posts and Last updated pages, drops the rest", () => {
    assert.deepEqual(datedPages(Object.keys(texts), read), [
      { file: "content/news/a.md", kind: "news post", date: "2026-10-18" },
      { file: "content/privacy.md", kind: "page", date: "May 1, 2026" },
    ]);
  });

  it("always counts a listed policy page, dated or not", () => {
    assert.deepEqual(
      datedPages(["content/delivery-policy.md", "content/terms.md"],
        () => "---\ntitle: D\n---\nNo date line.\n"),
      [
        { file: "content/delivery-policy.md", kind: "page",
          date: "(no date found)" },
        { file: "content/terms.md", kind: "page",
          date: "(no date found)" },
      ]);
  });

  it("says so when a post has no date", () => {
    assert.equal(datedPages(["content/news/b.md"], () => "Body")[0].date,
      "(no date found)");
  });
});

describe("dated pages: output", () => {
  const pages = [{ file: "content/news/a,b%.md", kind: "news post",
    date: "x\n::error::boom" }];

  it("escapes what a page could use to forge a command", () => {
    const [line] = warnings(pages);

    assert.match(line, /^::warning file=content\/news\/a%2Cb%25\.md,/);
    assert.equal(line.split("\n").length, 1);
    assert.match(line, /x%0A::error::boom/);
  });

  it("escapes Markdown in the summary table", () => {
    const text = summary([{ file: "content/a|b.md", kind: "page",
      date: "<b>1</b>" }]);

    assert.match(text, /a\\\|b\.md/);
    assert.doesNotMatch(text, /<b>/);
  });
});

describe("dated pages: the script", () => {
  const script = fileURLToPath(
    new URL("../bin/dated-pages.mjs", import.meta.url));

  it("lists a changed post and exits 0 either way", () => {
    const dir = mkdtempSync(join(tmpdir(), "dated-"));
    const git = (...args) => execFileSync("git", args, { cwd: dir,
      encoding: "utf8" });

    git("init", "-q");
    git("config", "user.email", "t@example.com");
    git("config", "user.name", "t");
    git("config", "commit.gpgsign", "false");
    mkdirSync(join(dir, "content/news"), { recursive: true });
    writeFileSync(join(dir, "README.md"), "x\n");
    git("add", ".");
    git("commit", "-qm", "base");
    const base = git("rev-parse", "HEAD").trim();

    writeFileSync(join(dir, "content/news/a.md"),
      "---\ndate: 2026-10-18\n---\nBody\n");
    git("add", ".");
    git("commit", "-qm", "post");

    const run = (...args) => spawnSync("node", [script, ...args],
      { cwd: dir, encoding: "utf8" });
    const hit = run(base);

    assert.equal(hit.status, 0);
    assert.match(hit.stdout, /::warning file=content\/news\/a\.md/);
    assert.match(hit.stdout, /2026-10-18/);

    const none = run("HEAD");

    assert.equal(none.status, 0);
    assert.match(none.stdout, /No dated page changed/);

    const bad = run(base, "no-such-ref");

    assert.equal(bad.status, 0);
    assert.match(bad.stdout, /::notice::Date reminder skipped/);
  });
});
