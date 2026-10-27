#!/usr/bin/env node
// A reminder, never a gate (#467): lists each news post and each page
// with a "Last updated" line that a range of commits changed, with the
// date it carries now, so a reviewer confirms the date before it ships.
// The right date is often not the real created or updated one, so
// nothing here sets a date. CI prints the list as GitHub warnings and
// in the job summary.
//
//   node bin/dated-pages.mjs <base> [<head>]
//
// Head defaults to HEAD. It always exits 0: a failure to read the range
// prints a notice and nothing else. Page text is untrusted (a pull
// request can come from a fork), so everything printed is escaped for
// GitHub's workflow commands and for Markdown.

import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { resolveBase } from "./check-record-shape.mjs";

const git = (...args) => execFileSync("git", args, {
  encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
});

const NEWS = /^content\/news\/(?!_index\.md$).+\.md$/;
const PAGE = /^content\/.+\.md$/;
// Policy pages that always count, with or without a "Last updated" line.
export const POLICY_PAGES = [
  "content/privacy.md", "content/delivery-policy.md",
  "content/accessibility.md", "content/terms.md",
];
const LAST_UPDATED = /^.*\blast updated\b[:\s]*(.+?)\s*$/im;

// The `date` front matter value, or "".
export const frontMatterDate = (text) => {
  const head = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const line = head && head[1].match(/^date:\s*(.+?)\s*$/m);

  return line ? line[1].replace(/^(["'])(.*)\1$/, "$2") : "";
};

// The words after "Last updated" on the first line that has them, with
// the closing period dropped, or "".
export const lastUpdated = (text) => {
  const found = text.match(LAST_UPDATED);

  return found ? found[1].replace(/[.\s]+$/, "") : "";
};

// Takes the changed paths and a reader for a path's text; returns
// [{ file, kind, date }] for each dated page. A news post carries its
// front matter date. Any other page counts with a "Last updated" line,
// and carries that text, or when it is a listed policy page.
export const datedPages = (files, read) => {
  const found = [];

  for (const file of files) {
    if (!PAGE.test(file)) continue;
    const text = read(file);
    const news = NEWS.test(file);
    const stamped = lastUpdated(text);

    if (!news && !stamped && !POLICY_PAGES.includes(file)) continue;
    found.push({
      file,
      kind: news ? "news post" : "page",
      date: (news ? frontMatterDate(text) : stamped) || stamped
        || "(no date found)",
    });
  }
  return found;
};

const clip = (text) => text.length > 80 ? `${text.slice(0, 77)}...` : text;

// GitHub's escaping for a workflow command's message and properties.
const message = (text) => text
  .replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
const property = (text) => message(text)
  .replace(/:/g, "%3A").replace(/,/g, "%2C");

export const warnings = (pages) => pages.map(({ file, kind, date }) =>
  `::warning file=${property(file)},title=${property("Confirm the date")}` +
  `::${message(`${clip(date)}: confirm this ${kind}'s date before it ` +
    "ships (a reminder, not a gate)")}`);

const cell = (text) => clip(text).replace(/[\r\n]+/g, " ")
  .replace(/[\\`*_|<>[\]!]/g, "\\$&");

export const summary = (pages) => [
  "### Dates to confirm",
  "",
  "Dates on posts and policy pages are James's. Confirm each one below " +
    "before this ships. A reminder, never a gate.",
  "",
  "| File | Kind | Date it carries |",
  "| --- | --- | --- |",
  ...pages.map(({ file, kind, date }) =>
    `| ${cell(file)} | ${kind} | ${cell(date)} |`),
  "",
].join("\n");

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    const [arg, head = "HEAD"] = process.argv.slice(2);
    const exists = (sha) => {
      try {
        git("cat-file", "-e", `${sha}^{commit}`);
        return true;
      } catch {
        return false;
      }
    };
    const base = resolveBase(arg, exists);
    const files = git("diff", "--name-only", "-z", "--diff-filter=ACMR",
      `${base}...${head}`, "--", "content").split("\0").filter(Boolean);
    const pages = datedPages(files, (file) => git("show", `${head}:${file}`));

    if (pages.length) {
      console.log(warnings(pages).join("\n"));
      if (process.env.GITHUB_STEP_SUMMARY) {
        appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary(pages));
      }
    } else {
      console.log("No dated page changed.");
    }
  } catch (error) {
    console.log(`::notice::Date reminder skipped: ${message(error.message)}`);
  }
}
