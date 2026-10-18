#!/usr/bin/env node
// Fails the deploy when two news posts share a title or a final URL.
// A post's URL is its `slug` front matter, else its title, never its
// file's date, so a reused title would quietly overwrite another
// post's page. Netlify runs it after Hugo in every build command.
//
//   node bin/check-news.mjs           checks content/news
//   node bin/check-news.mjs public    also holds each URL to the build

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

// Takes [{ file, text }]; returns the problems, one line each.
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

const main = () => {
  const dir = join(root, "content/news");
  const posts = readdirSync(dir)
    .filter((f) => f.endsWith(".md") && f !== "_index.md")
    .map((file) => ({ file, text: readFileSync(join(dir, file), "utf8") }));
  const errors = checkPosts(posts);

  const built = process.argv[2];
  if (built) {
    for (const { text } of posts) {
      const url = urlOf(text);
      if (!existsSync(join(root, built, url, "index.html"))) {
        errors.push(`${url} is not in ${built}/`);
      }
    }
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
