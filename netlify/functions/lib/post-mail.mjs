// A news post as a Farm News email (#483), built from the Markdown
// Hugo writes for it (layouts/news/single.markdown.md, public/news/
// <post>/index.md) and set in the list template. The site's footer is
// not in that Markdown, so it is not in the email. The post's photos
// are JPEGs at fixed addresses under /mail/ (figure.markdown.md), the
// only addresses mail can rely on. The Markdown a post may use is the
// part the email can show; anything else throws, so a post never goes
// out with a list or a table flattened into a paragraph.

import { readFileSync } from "node:fs";
import { listBlocks as b, listMail } from "./templates.mjs";

// What Resend fills in, per reader, when a broadcast goes out.
export const RESEND_UNSUBSCRIBE = "{{{RESEND_UNSUBSCRIBE_URL}}}";

const ROOT = new URL("../../../", import.meta.url);

// The build is in public/ unless NEWS_BUILD_DIR says where Hugo wrote
// it (`hugo -d .ignored/build`).
export const postFile = (slug, env = process.env) => {
  if (!/^[a-z0-9-]+$/.test(slug)) throw new Error(`post mail: ${slug}`);

  const dir = (env.NEWS_BUILD_DIR || "public").replace(/\/+$/, "");

  return new URL(`${dir}/news/${slug}/index.md`, ROOT);
};

// A link in the post is an address on the site, a web address or a
// mail address; the email needs each in full.
const absolute = (url, site) => {
  if (/^(https?:|mailto:)/i.test(url)) return url;
  if (url.startsWith("/")) return `${site}${url}`;
  throw new Error(`post mail: a link to ${url}`);
};

const MARKS = /\[([^\]]+)\]\(([^)\s]+)\)|\*\*(.+?)\*\*|\*(.+?)\*/g;

// Inline Markdown -> parts for listBlocks.rich: links, **bold** and
// *italic*, nested.
const parts = (text, site, flags = {}) => {
  const out = [];
  let at = 0;
  const plain = (s) => {
    if (s) out.push({ ...flags, text: s });
  };

  for (const m of text.matchAll(MARKS)) {
    plain(text.slice(at, m.index));
    at = m.index + m[0].length;
    if (m[1] !== undefined) {
      out.push(...parts(m[1], site, { ...flags, url: absolute(m[2], site) }));
    } else if (m[3] !== undefined) {
      out.push(...parts(m[3], site, { ...flags, strong: true }));
    } else {
      out.push(...parts(m[4], site, { ...flags, em: true }));
    }
  }
  plain(text.slice(at));

  return out;
};

const IMAGE = /^!\[([^\]]*)\]\(([^)\s]+)\)$/;
const CAPTION = /^\*([^*].*)\*$/;
const DINKUS = /^(?:[*_-]\s*){3,}$/;
const DATE = /^[A-Z][a-z]+ \d{1,2}, \d{4}$/;
// A line the email has no block for: a list, a quote, code, a table,
// a lower heading or markup.
const UNSUPPORTED = /^(?:[-+*] |\d+[.)] |> |```|\||<|# |#{3,} )/m;

// A photo's address: always /mail/, so never one of Hugo's
// fingerprinted files, which change with every build.
const photo = (url, site) => {
  const { pathname } = new URL(url, site);

  if (!pathname.startsWith("/mail/")) {
    throw new Error(`post mail: a photo not at a fixed address: ${url}`);
  }

  return `${site}${pathname}`;
};

// -> { title, blocks } from a post's Markdown.
export const postBlocks = (markdown, site) => {
  const chunks = markdown.trim().split(/\n{2,}/).map((c) => c.trim());
  const first = chunks.shift();

  if (!first.startsWith("# ")) throw new Error("post mail: no title");

  const title = first.slice(2).trim();
  const blocks = [b.title(title)];

  if (DATE.test(chunks[0])) chunks.shift();

  while (chunks.length) {
    const chunk = chunks.shift();
    const image = chunk.match(IMAGE);

    if (image) {
      const caption = CAPTION.test(chunks[0] || "")
        ? chunks.shift().slice(1, -1)
        : "";

      blocks.push(b.image(photo(image[2], site), image[1], caption));
    } else if (DINKUS.test(chunk)) {
      blocks.push(b.dinkus());
    } else if (chunk.startsWith("## ")) {
      blocks.push(b.heading(chunk.slice(3).trim()));
    } else if (UNSUPPORTED.test(chunk) || chunk.includes("![")) {
      throw new Error(`post mail: no email form for "${
        chunk.split("\n")[0]}"`);
    } else if (chunk.startsWith("— ")) {
      blocks.push(b.signature(chunk.slice(2).trim()));
    } else {
      blocks.push(b.rich(parts(chunk.replace(/\s*\n\s*/g, " "), site)));
    }
  }

  return { title, blocks };
};

// The post as a list email: { subject, text, html }. `preview` is the
// inbox's line after the subject. A broadcast cannot say why each
// reader gets it, so the reason is the list's own, and the unsubscribe
// link is the one Resend inserts for each.
export const postMail = (markdown, {
  links, preview = "", reason = "you joined our Farm News list",
  unsubscribeUrl = RESEND_UNSUBSCRIBE,
} = {}) => {
  const { title, blocks } = postBlocks(markdown, links.site);

  return listMail(title, { preview, blocks, reason, unsubscribeUrl, links });
};

// A post from the build in public/ (run Hugo first).
export const postMailFromBuild = (slug, options) =>
  postMail(readFileSync(postFile(slug), "utf8"), options);
