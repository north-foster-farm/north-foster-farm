// #899: a standing guard. A content page that shows a date saying when
// it was last changed must not show a date earlier than its newest
// change (James, 2026-11-22: every dated content page, deterministic).
// A criteria test, written by a test agent from the issue's "Done
// when" list before the change. One test per (test) box: the third,
// "A test fails when any such page shows a date earlier than its
// newest change, and names the page". The fourth box (no calendar
// date pinned, passes with full history, skips saying so without it)
// is how this test is built, and the fixture repositories below check
// it.
//
// Provisional, written to the issue's proposals, which James has not
// yet confirmed:
//
// - Which pages count: any page under content/ whose source shows a
//   "Last updated <Month D, YYYY>" line, or sets `lastmod` in its front
//   matter. Today that is content/privacy.md alone.
// - A news post's publication date (`date`) is left alone: a typo fix
//   does not re-date a post. A post that shows a "Last updated" line
//   counts like any page.
// - Only a change a reader can see moves the date. The source stands
//   in for the rendered text: front matter, HTML comments, shortcode
//   tags (with their arguments), the "Last updated" line itself and
//   whitespace are left out before two versions are compared.
//
// "Newest change" is the committer date, in the farm's time zone
// (America/New_York), of the newest commit whose reader text differs
// from its first parent's, or today in that zone while the working
// tree's reader text differs from HEAD's. Nothing here names a
// calendar date for the site: the fixtures carry their own history.
// In a shallow clone or where git is missing, the check of the site
// skips and says why.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { after, describe, it } from "node:test";

const root = join(import.meta.dirname, "..");
const ZONE = "America/New_York";
const MONTHS = ["january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december"];
const LAST_UPDATED =
  /^[^\n]*\blast updated\b[:\s]*([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})[^\n]*$/im;
const LAST_UPDATED_LINE = /^[^\n]*\blast updated\b[^\n]*$/gim;
const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

const git = (cwd, ...args) => spawnSync("git", args, {
  cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
  env: { ...process.env, TZ: ZONE },
});

const today = () => new Date().toLocaleDateString("en-CA",
  { timeZone: ZONE });

const pad = (n) => String(n).padStart(2, "0");

// The date the page shows, as YYYY-MM-DD, "" when it shows none, or
// null when it shows one that does not read as a date.
const shownDate = (text) => {
  const head = text.match(FRONT_MATTER);
  const lastmod = head && head[1].match(/^lastmod:\s*["']?(\S+?)["']?\s*$/m);

  if (lastmod) {
    const day = lastmod[1].match(/^(\d{4})-(\d\d)-(\d\d)/);

    return day ? `${day[1]}-${day[2]}-${day[3]}` : null;
  }

  const line = text.slice(head ? head[0].length : 0).match(LAST_UPDATED);

  if (!line) {
    return /\blast updated\b/i.test(text.slice(head ? head[0].length : 0))
      ? null : "";
  }
  const month = MONTHS.indexOf(line[1].toLowerCase());
  const day = Number(line[2]);

  if (month < 0 || day < 1 || day > 31) return null;
  return `${line[3]}-${pad(month + 1)}-${pad(day)}`;
};

// What a reader sees of a version, for comparing two of them.
const readerText = (text) => (text ?? "")
  .replace(FRONT_MATTER, "")
  .replace(/<!--[\s\S]*?-->/g, "")
  .replace(/\{\{[<%][\s\S]*?[%>]\}\}/g, "")
  .replace(LAST_UPDATED_LINE, "")
  .replace(/\s+/g, " ")
  .trim();

const markdownFiles = (dir) => {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => join(entry.parentPath, entry.name));
};

// Every content page that shows a last-changed date: [{ file, shown }].
const datedPages = (repo) => markdownFiles(join(repo, "content"))
  .map((path) => ({
    file: relative(repo, path).split("\\").join("/"),
    shown: shownDate(readFileSync(path, "utf8")),
  }))
  .filter(({ shown }) => shown !== "")
  .sort((a, b) => a.file.localeCompare(b.file));

const show = (repo, rev, file) => {
  const run = git(repo, "show", `${rev}:${file}`);

  return run.status === 0 ? run.stdout : null;
};

// The day of the page's newest change a reader can see, or "" when
// git has no commit that changed it.
const newestChange = (repo, file) => {
  const working = readFileSync(join(repo, file), "utf8");

  if (readerText(working) !== readerText(show(repo, "HEAD", file))) {
    return today();
  }

  const log = git(repo, "log", "--first-parent",
    "--format=%H %P%x09%cd", "--date=format-local:%Y-%m-%d", "--", file);

  for (const line of log.stdout.split("\n").filter(Boolean)) {
    const [shas, day] = line.split("\t");
    const [sha, parent] = shas.split(" ");
    const before = parent ? show(repo, parent, file) : null;

    if (readerText(show(repo, sha, file)) !== readerText(before)) return day;
  }
  return "";
};

// Why the site's history can't be read, or "".
const noHistory = (repo) => {
  const shallow = git(repo, "rev-parse", "--is-shallow-repository");

  if (shallow.error || shallow.status !== 0) {
    return "no git history here (git missing or not a repository)";
  }
  if (shallow.stdout.trim() === "true") {
    return "a shallow clone: the page's newest change needs full history";
  }
  return "";
};

// Each dated page that shows a date earlier than its newest change,
// or no readable date, as one line naming the page.
const stalePages = (repo) => {
  const found = [];

  for (const { file, shown } of datedPages(repo)) {
    if (shown === null) {
      found.push(`${file}: its last-changed date does not read as a date`);
      continue;
    }
    const changed = newestChange(repo, file);

    if (changed && shown < changed) {
      found.push(`${file}: shows ${shown}, but changed on ${changed}`);
    }
  }
  return found;
};

// A scratch repository with a dated page and a history of its own.
const scratch = [];

after(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

const fixture = () => {
  const dir = mkdtempSync(join(tmpdir(), "dated-guard-"));

  scratch.push(dir);
  mkdirSync(join(dir, "content/news"), { recursive: true });
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "t@example.com");
  git(dir, "config", "user.name", "t");
  git(dir, "config", "commit.gpgsign", "false");

  const commit = (day, files) => {
    for (const [file, text] of Object.entries(files)) {
      writeFileSync(join(dir, file), text);
    }
    git(dir, "add", "-A");
    const stamp = `${day}T12:00:00-05:00`;
    const run = spawnSync("git", ["commit", "-qm", `at ${day}`], {
      cwd: dir, encoding: "utf8",
      env: { ...process.env, GIT_AUTHOR_DATE: stamp,
        GIT_COMMITTER_DATE: stamp },
    });

    assert.equal(run.status, 0, run.stderr);
  };

  return { dir, commit };
};

const policy = (dated, body = "We keep your email address private.") =>
  `---\ntitle: Privacy\n---\n\n${body}\n\nLast updated ${dated}.\n`;

const POST = "---\ntitle: News\ndate: 2025-01-02\n---\n\nA post.\n";

describe("#899 A test fails when any such page shows a date earlier " +
  "than its newest change, and names the page", () => {
  const why = noHistory(root);

  it("holds every dated content page on the site to its newest change",
    { skip: why || false }, () => {
      const pages = datedPages(root);

      assert.ok(pages.length > 0, "content/ has a dated page");
      assert.deepEqual(stalePages(root), [],
        "these pages show a date earlier than their newest change");
    });

  it("counts content/privacy.md, whose Last updated line is a date", () => {
    const privacy = datedPages(root)
      .find(({ file }) => file === "content/privacy.md");

    assert.ok(privacy, "content/privacy.md is a dated page");
    assert.match(privacy.shown ?? "", /^\d{4}-\d\d-\d\d$/);
  });

  it("leaves a news post's publication date alone", () => {
    const posts = datedPages(root)
      .filter(({ file }) => file.startsWith("content/news/"));

    assert.deepEqual(posts, [], "no post shows a last-changed date");
  });

  it("fails a page edited after its date, naming the page", () => {
    const { dir, commit } = fixture();

    commit("2025-03-01", { "content/privacy.md": policy("March 1, 2025") });
    commit("2025-03-09", { "content/privacy.md":
      policy("March 1, 2025", "We keep your pick-up time private.") });

    assert.deepEqual(stalePages(dir),
      ["content/privacy.md: shows 2025-03-01, but changed on 2025-03-09"]);
  });

  it("passes a page dated the day of its newest change", () => {
    const { dir, commit } = fixture();

    commit("2025-03-01", { "content/privacy.md": policy("March 1, 2025") });
    commit("2025-03-09", { "content/privacy.md":
      policy("March 9, 2025", "We keep your pick-up time private.") });

    assert.deepEqual(stalePages(dir), []);
  });

  it("lets a change no reader sees leave the date", () => {
    const { dir, commit } = fixture();
    const body = "We keep your email address private.";

    commit("2025-03-01", { "content/privacy.md": policy("March 1, 2025",
      `${body}\n\n{{< contact-link kind="email" >}}`) });
    const quiet = policy("March 1, 2025",
      `${body}\n\n{{< contact-link kind="sales" >}}`)
      .replace("title: Privacy", "title: Privacy policy")
      .replace(body, "We keep your email\naddress   private.");

    commit("2025-03-09", { "content/privacy.md":
      `${quiet}\n<!-- a note for editors -->\n` });

    assert.deepEqual(stalePages(dir), []);
  });

  it("dates an uncommitted edit today, in the farm's time zone", () => {
    const { dir, commit } = fixture();

    commit("2025-03-01", { "content/privacy.md": policy("March 1, 2025") });
    writeFileSync(join(dir, "content/privacy.md"),
      policy("March 1, 2025", "We keep your pick-up time private."));

    assert.deepEqual(stalePages(dir),
      [`content/privacy.md: shows 2025-03-01, but changed on ${today()}`]);
  });

  it("holds a page with a lastmod in its front matter", () => {
    const { dir, commit } = fixture();
    const page = (lastmod, body) =>
      `---\ntitle: Terms\nlastmod: ${lastmod}\n---\n\n${body}\n`;

    commit("2025-03-01", { "content/terms.md": page("2025-03-01", "One.") });
    commit("2025-03-09", { "content/terms.md": page("2025-03-01", "Two.") });

    assert.deepEqual(stalePages(dir),
      ["content/terms.md: shows 2025-03-01, but changed on 2025-03-09"]);
  });

  it("ignores a news post edited after its publication date", () => {
    const { dir, commit } = fixture();

    commit("2025-01-02", { "content/news/a.md": POST });
    commit("2025-03-09", { "content/news/a.md":
      POST.replace("A post.", "A post, with a typo fixed.") });

    assert.deepEqual(datedPages(dir), []);
    assert.deepEqual(stalePages(dir), []);
  });

  it("names a page whose date does not read as one", () => {
    const { dir, commit } = fixture();

    commit("2025-03-01", { "content/privacy.md": policy("Smarch 1, 2025") });

    assert.deepEqual(stalePages(dir), ["content/privacy.md: its " +
      "last-changed date does not read as a date"]);
  });

  it("says why it skips where there is no history", () => {
    const { dir, commit } = fixture();

    commit("2025-03-01", { "content/privacy.md": policy("March 1, 2025") });
    commit("2025-03-09", { "content/privacy.md":
      policy("March 9, 2025", "Two.") });

    const copy = mkdtempSync(join(tmpdir(), "dated-guard-shallow-"));

    scratch.push(copy);
    const clone = git(tmpdir(), "clone", "-q", "--depth=1",
      `file://${dir}`, copy);

    assert.equal(clone.status, 0, clone.stderr);
    assert.match(noHistory(copy), /shallow clone/);
    const bare = mkdtempSync(join(tmpdir(), "dated-guard-none-"));

    scratch.push(bare);
    assert.match(noHistory(bare), /no git history/);
    assert.equal(noHistory(dir), "");
  });
});
