#!/usr/bin/env node
// Fails the deploy when two news posts share a title or a final URL.
// A post's URL is its `slug` front matter, else its title, never its
// file's date, so a reused title would quietly overwrite another
// post's page. Netlify runs it after Hugo in every build command.
//
//   node bin/check-news.mjs           checks content/news
//   node bin/check-news.mjs public    also holds each URL to the build,
//                                     skipping posts Hugo won't publish

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const field = (text, name) => {
  const head = text.match(/^---\n([\s\S]*?)\n---/);
  const line = head && head[1].match(new RegExp(`^${name}:\\s*(.+)$`, "m"));
  return line ? line[1].trim().replace(/^(["'])(.*)\1$/, "$2") : "";
};

// Hugo's urlize, for the titles the site uses: lowercase, punctuation
// dropped, runs of spaces and hyphens made one hyphen.
export const urlize = (text) => text.toLowerCase()
  .replace(/[^a-z0-9 _-]/g, "")
  .replace(/[\s_-]+/g, "-")
  .replace(/^-|-$/g, "");

// A post's address under /news/: its slug, else its title's.
export const urlOf = (text) =>
  `/news/${field(text, "slug") || urlize(field(text, "title"))}/`;

// Now as Hugo's timeZone (config/_default/hugo.toml) reads a date
// with no offset: "2026-11-16T09:30:00" on New York's clock.
const localNow = (now) => {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York", hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(now).map(({ type, value }) => [type, value]));
  return `${parts.year}-${parts.month}-${parts.day}T` +
    `${parts.hour}:${parts.minute}:${parts.second}`;
};

// Whether a front matter date is later than now. A bare date is that
// day's midnight in New York, as Hugo has it.
const after = (value, now) => {
  if (/(Z|[+-]\d\d:?\d\d)$/i.test(value)) return Date.parse(value) > now;
  const local = value.replace(" ", "T");
  const full = local.length === 10 ? `${local}T00:00:00` : local;
  return full.slice(0, 19) > localNow(now);
};

// Whether a production build publishes the post: not a draft, its
// publishDate (else its date) not yet to come, its expiryDate not
// passed. Deploy previews and staging build the rest too.
export const published = (text, now = new Date()) => {
  if (field(text, "draft") === "true") return false;
  const date = field(text, "publishDate") || field(text, "date");
  if (date && after(date, now)) return false;
  const expiry = field(text, "expiryDate");
  return !(expiry && !after(expiry, now));
};

// Takes [{ file, text }]; returns the problems, one line each. Drafts
// and future posts count too: they clash the day they go out.
export const checkPosts = (posts) => {
  const errors = [];
  const titles = new Map();
  const urls = new Map();
  for (const { file, text } of posts) {
    const title = field(text, "title");
    const url = urlOf(text);
    if (!title) errors.push(`${file}: no title`);
    for (const [seen, key, what] of [
      [titles, title.toLowerCase(), "title"], [urls, url, "URL"],
    ]) {
      if (key && seen.has(key)) {
        errors.push(`${file} and ${seen.get(key)} share the ${what} ` +
          `${what === "URL" ? url : `"${title}"`}`);
      }
      seen.set(key, file);
    }
  }
  return errors;
};

// The published posts whose page the build in `built` lacks; `has`
// says whether it holds a URL's page.
export const checkBuilt = (posts, built, has, now = new Date()) =>
  posts.filter(({ text }) => published(text, now) && !has(urlOf(text)))
    .map(({ text }) => `${urlOf(text)} is not in ${built}/`);

const main = () => {
  const dir = join(root, "content/news");
  const posts = readdirSync(dir)
    .filter((f) => f.endsWith(".md") && f !== "_index.md")
    .map((file) => ({ file, text: readFileSync(join(dir, file), "utf8") }));
  const errors = checkPosts(posts);

  const built = process.argv[2];
  if (built) {
    errors.push(...checkBuilt(posts, built,
      (url) => existsSync(join(root, built, url, "index.html"))));
  }

  if (errors.length) {
    console.error(`News posts: ${errors.length} problem${
      errors.length === 1 ? "" : "s"}.`);
    for (const error of errors) console.error(`  ${error}`);
    process.exit(1);
  }
  console.log(`News posts: ${posts.length} with their own title and URL.`);
};

if (process.argv[1] &&
    import.meta.url === pathToFileURL(process.argv[1]).href) main();
