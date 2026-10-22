// Hold the sitemap, llms.txt and the web app manifest to the site that
// was just built (#191). Hugo writes the sitemap and llms.txt in the
// same render as the pages, so none is a separate step to skip; what
// can go wrong is one missing, or not matching the pages beside it.
// Run it on a Hugo build:
//
//   bin/fresh/check.mjs public
//
// It prints one line per finding and exits 1 if there is any.
//
// F1  sitemap.xml exists and parses
// F2  every page search may index is in it, every address in it is a
//     built page, and each has a lastmod
// F3  llms.txt exists, every link in it is a built page or its
//     Markdown, every news post is listed, and its summary is the home
//     page's description
// F4  the manifest the home page links exists, with a name, id,
//     start_url and scope that agree, icons that exist, and the page's
//     theme color

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";

const LASTMOD = /^\d{4}-\d\d-\d\d(?:T[\d:.]+(?:Z|[+-]\d\d:\d\d))?$/;

const attr = (html, tag, key, match) => {
  const found = new RegExp(
    `<${tag}\\b[^>]*\\b${match}[^>]*>`, "i").exec(html);
  const value = found
    && new RegExp(`\\b${key}="?([^">\\s]+)"?`, "i").exec(found[0]);

  return value ? value[1] : null;
};

const text = (html, name) => {
  const found = new RegExp(
    `<meta name="?${name}"? content="([^"]*)"`, "i").exec(html);

  return found ? found[1] : null;
};

// The built page a URL names, relative to the build.
const pathOf = (url) => {
  const { pathname } = new URL(url);

  return pathname.endsWith("/") ? `${pathname.slice(1)}index.html`
    : pathname.slice(1);
};

function* htmlFiles(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);

    if (statSync(path).isDirectory()) yield* htmlFiles(path);
    else if (name === "index.html" || name === "404.html") yield path;
  }
}

// Check a build directory. -> [{ rule, message }].
export function check(dir) {
  const findings = [];
  const add = (rule, message) => findings.push({ rule, message });
  const read = (path) => readFileSync(join(dir, path), "utf8");
  const built = (path) => existsSync(join(dir, path));

  // The pages search may index: not a redirect, not noindex, not 404.
  const pages = new Map();

  for (const file of htmlFiles(dir)) {
    const path = relative(dir, file).split(sep).join("/");
    const html = readFileSync(file, "utf8");

    // Hugo lists a list once, not each of its pages.
    if (path === "404.html" || /\/page\/\d+\/index\.html$/.test(path)
      || /<meta http-equiv="?refresh/i.test(html)
      || /<meta name="?robots"? content="noindex/i.test(html)) continue;
    pages.set(path, html);
  }

  // F1, F2: the sitemap.
  if (!built("sitemap.xml")) {
    add("F1", "there is no sitemap.xml");
  } else {
    const entries = [...read("sitemap.xml")
      .matchAll(/<url>([\s\S]*?)<\/url>/g)].map((m) => ({
      loc: /<loc>([^<]+)<\/loc>/.exec(m[1])?.[1],
      lastmod: /<lastmod>([^<]+)<\/lastmod>/.exec(m[1])?.[1],
    }));

    if (!entries.length) add("F1", "sitemap.xml lists no pages");

    const listed = new Set();

    for (const { loc, lastmod } of entries) {
      if (!loc) {
        add("F1", "a sitemap entry has no <loc>");
        continue;
      }
      listed.add(pathOf(loc));
      if (!built(pathOf(loc))) add("F2", `${loc} is not a built page`);
      if (!lastmod || !LASTMOD.test(lastmod)) {
        add("F2", `${loc} has no usable lastmod`);
      }
    }
    for (const path of pages.keys()) {
      if (!listed.has(path)) add("F2", `${path} is not in sitemap.xml`);
    }
  }

  // F3: llms.txt.
  if (!built("llms.txt")) {
    add("F3", "there is no llms.txt");
  } else {
    const llms = read("llms.txt");
    const home = pages.get("index.html") || "";
    const summary = /^> (.+)$/m.exec(llms)?.[1];
    const description = text(home, "description");

    if (!summary || summary !== description) {
      add("F3", "the summary is not the home page's description");
    }
    for (const [, url] of llms.matchAll(/\]\((https:\/\/[^)\s]+)\)/g)) {
      if (!built(pathOf(url))) add("F3", `${url} is not built`);
    }
    for (const path of pages.keys()) {
      const post = /^news\/(?!page\/)([^/]+)\/index\.html$/.exec(path);

      if (post && !llms.includes(`/news/${post[1]}/`)) {
        add("F3", `the post ${post[1]} is not in llms.txt`);
      }
    }
  }

  // F4: the manifest.
  const home = pages.get("index.html") || "";
  const href = attr(home, "link", "href", "rel=\"?manifest\"?");

  if (!href) {
    add("F4", "the home page links no manifest");
  } else if (!built(pathOf(new URL(href, "https://x/").href))) {
    add("F4", `${href} is not built`);
  } else {
    const file = pathOf(new URL(href, "https://x/").href);
    let manifest;

    try {
      manifest = JSON.parse(read(file));
    } catch (error) {
      add("F4", `${file} does not parse: ${error.message}`);
    }
    if (manifest) {
      for (const key of ["name", "id", "start_url", "scope"]) {
        if (!manifest[key]) add("F4", `the manifest has no ${key}`);
      }
      if (manifest.start_url && manifest.scope
        && !manifest.start_url.startsWith(manifest.scope)) {
        add("F4", "start_url is outside scope");
      }
      if (manifest.theme_color !== text(home, "theme-color")) {
        add("F4", `theme_color ${manifest.theme_color} is not the page's ${
          text(home, "theme-color")}`);
      }
      for (const icon of manifest.icons || []) {
        if (!built(pathOf(new URL(icon.src, "https://x/").href))) {
          add("F4", `the icon ${icon.src} is not built`);
        }
      }
      if (!(manifest.icons || []).length) {
        add("F4", "the manifest has no icons");
      }
    }
  }

  return findings;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dir = process.argv[2] || "public";
  const findings = check(dir);

  for (const f of findings) console.log(`${f.rule}: ${f.message}`);
  console.log(`freshness check: ${findings.length} findings`);
  process.exitCode = findings.length ? 1 : 0;
}
