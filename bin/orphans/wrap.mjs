// Keep the last two words of a prose element on one line, so no line
// ends a paragraph, heading or list item with a single word (#303).
// Run it on a Hugo build, before the checks that read it:
//
//   bin/orphans/wrap.mjs public
//
// It rewrites each HTML file in place and prints a count. The rules:
//
// - Only h1 to h6, p, li and the other prose elements in PROSE, and
//   none inside pre, code, svg, math, script, style or textarea.
// - Only when the element ends in plain text `word word`, a word being
//   any run of non-whitespace. b, strong, em and i may sit in or
//   around the words, and so may a text-nowrap span around a single
//   word (the footer's "in <span class="text-nowrap">Scituate</span>.",
//   which keeps a word whole but still leaves it alone on a line).
// - Nothing when the words are inside any other markup (a link, a
//   span, code), when the element holds only two words, or when either
//   word is a URL or an email address (://, www. or @) or longer than
//   14 characters.
//
// The two words go in <span class="text-nowrap">, Bootstrap's
// white-space: nowrap. When an em or the like starts before the first
// word and ends inside the pair, it is closed before the span and
// opened again inside it, so the markup stays well formed. A second
// run changes nothing: the pair then ends in a span with a space in
// it, which is markup the pass leaves alone.
//
// The HTML is read with a small tag scanner, as bin/grid/check.mjs
// reads it: Hugo's output closes its elements, and an element left
// open is skipped.

import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const PROSE = new Set([
  "h1", "h2", "h3", "h4", "h5", "h6", "p", "li", "dt", "dd",
  "blockquote", "figcaption", "caption", "summary", "legend", "label",
  "th", "td",
]);
const SKIP = new Set([
  "pre", "code", "svg", "math", "script", "style", "textarea",
]);
const RAW = new Set(["script", "style", "textarea", "title"]);
const VOID = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input", "link",
  "meta", "source", "track", "wbr",
]);
const INLINE = new Set(["b", "strong", "em", "i"]);
const MAX_WORD = 14;
const OPEN = '<span class="text-nowrap">';
const CLOSE = "</span>";

const TAG = new RegExp(
  "<!--[\\s\\S]*?-->|<![^>]*>|<\\?[^>]*>"
  + "|<(/?)([a-zA-Z][\\w:-]*)"
  + "((?:\\s+[^\\s=>/]+(?:\\s*=\\s*(?:\"[^\"]*\"|'[^']*'|[^\\s>]+))?)*)"
  + "\\s*(/?)>",
  "g");

// Split the document into text and tags, each with its place in the
// source. The body of a raw text element is one opaque token.
export function tokenize(html) {
  const tokens = [];
  let at = 0;
  const text = (end) => {
    if (end > at) {
      tokens.push({ type: "text", raw: html.slice(at, end), start: at });
    }
  };
  TAG.lastIndex = 0;
  for (let m; (m = TAG.exec(html));) {
    text(m.index);
    const raw = m[0];
    const start = m.index;
    at = TAG.lastIndex;
    if (!m[2]) {
      tokens.push({ type: "other", raw, start });
      continue;
    }
    const name = m[2].toLowerCase();
    const type = m[1] ? "close" : "open";
    const selfClosing = Boolean(m[4]) || (type === "open" && VOID.has(name));
    tokens.push({ type, name, raw, start, attrs: m[3], selfClosing });
    if (type === "open" && RAW.has(name)) {
      const end = html.toLowerCase().indexOf(`</${name}`, at);
      const stop = end === -1 ? html.length : end;
      if (stop > at) {
        tokens.push({ type: "other", raw: html.slice(at, stop), start: at });
      }
      at = stop;
      TAG.lastIndex = stop;
    }
  }
  text(html.length);
  return tokens;
}

// HTML's whitespace, which leaves out the no-break space: a word
// joined by one is one word.
const SPACE = /[ \t\n\r\f]/;
const isSpace = (c) => SPACE.test(c);

const NAMED = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'",
  nbsp: "\u00a0", commat: "@" };

// Entities count as the one character they stand for.
function decode(s) {
  return s.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (all, e) => {
    if (e[0] === "#") {
      const n = e[1] === "x" || e[1] === "X"
        ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return String.fromCodePoint(n);
    }
    return NAMED[e.toLowerCase()] ?? "?";
  });
}

const isNowrapSpan = (t) => t.type === "open" && t.name === "span"
  && /\bclass\s*=\s*(["'])[^"']*\btext-nowrap\b[^"']*\1/.test(t.attrs);

// From the element's close tag back, the tokens the last words may
// span: text, b, strong, em and i, and a text-nowrap span around one
// word. Returns their indexes in document order, and whether the walk
// reached the element's own start tag.
function tail(tokens, open, close) {
  const seq = [];
  let i = close - 1;
  while (i > open) {
    const t = tokens[i];
    if (t.type === "text") {
      seq.push(i--);
      continue;
    }
    if ((t.type === "open" || t.type === "close") && INLINE.has(t.name)
      && !t.selfClosing) {
      seq.push(i--);
      continue;
    }
    if (t.type === "close" && t.name === "span") {
      const run = oneWordSpan(tokens, open, i);
      if (run) {
        for (let k = i; k >= run; k--) seq.push(k);
        i = run - 1;
        continue;
      }
    }
    break;
  }
  return { seq: seq.reverse(), whole: i === open };
}

// A text-nowrap span holding one word and only text or inline tags:
// the index of its start tag, or 0 when the span is anything else.
function oneWordSpan(tokens, open, close) {
  let depth = 0;
  for (let k = close - 1; k > open; k--) {
    const t = tokens[k];
    if (t.type === "text") {
      if (SPACE.test(t.raw)) return 0;
    } else if (t.type === "close" && t.name === "span") {
      depth++;
    } else if (t.type === "open" && t.name === "span") {
      if (depth) {
        depth--;
        continue;
      }
      return isNowrapSpan(t) ? k : 0;
    } else if (!INLINE.has(t.name)) {
      return 0;
    }
  }
  return 0;
}

const unsafe = (word) => /:\/\/|www\.|@/i.test(word)
  || [...word].length > MAX_WORD;

// The edit for one element, or null to leave it as it is.
function plan(tokens, open, close) {
  const { seq, whole } = tail(tokens, open, close);
  // The text of the tail, and where each character sits in the source.
  let text = "";
  const where = [];
  for (const i of seq) {
    const t = tokens[i];
    if (t.type !== "text") continue;
    const parts = t.raw.split(/(&(?:#x[\da-f]+|#\d+|[a-z]+);)/i);
    let off = 0;
    for (const part of parts) {
      if (!part) continue;
      const isEntity = part[0] === "&" && part.endsWith(";");
      const chars = isEntity ? [decode(part)] : [...part];
      for (const c of chars) {
        text += c;
        where.push({ i, off });
        if (!isEntity) off += c.length;
      }
      if (isEntity) off += part.length;
    }
  }

  const chars = [...text];
  let end = chars.length - 1;
  while (end >= 0 && isSpace(chars[end])) end--;
  if (end < 0) return null;
  let k = end;
  while (k >= 0 && !isSpace(chars[k])) k--;
  if (k < 0) return null;
  const second = chars.slice(k + 1, end + 1).join("");
  while (k >= 0 && isSpace(chars[k])) k--;
  if (k < 0) return null;
  const firstEnd = k;
  while (k >= 0 && !isSpace(chars[k])) k--;
  // No space before the first word: the element holds only these two
  // words, or the first word runs on into markup the pass leaves alone.
  if (k < 0) return null;
  // Only space before it, back to the element's start: two words.
  let lead = k;
  while (lead >= 0 && isSpace(chars[lead])) lead--;
  if (lead < 0 && whole) return null;
  const first = chars.slice(k + 1, firstEnd + 1).join("");
  if (unsafe(first) || unsafe(second)) return null;

  // Start the span at the first word. At the very start of a text
  // token, take in the start tags just before it as well.
  const from = where[k + 1];
  let pos = seq.indexOf(from.i);
  let at = tokens[from.i].start + from.off;
  if (from.off === 0) {
    while (pos > 0 && tokens[seq[pos - 1]].type === "open") {
      pos--;
      at = tokens[seq[pos]].start;
    }
  }

  // A close tag in the pair whose start tag sits before it is closed
  // ahead of the span and opened again inside.
  const stack = [];
  const strays = [];
  for (const i of seq.slice(pos)) {
    const t = tokens[i];
    if (t.type === "open") stack.push(t.name);
    else if (t.type === "close") {
      if (stack.length && stack.at(-1) === t.name) stack.pop();
      else strays.push(t.name);
    }
  }
  const reopen = [];
  let need = [...strays];
  let depth = 0;
  for (let s = pos - 1; s >= 0 && need.length; s--) {
    const t = tokens[seq[s]];
    if (t.type === "close") depth++;
    else if (t.type === "open" && depth) depth--;
    else if (t.type === "open") {
      if (t.name !== need[0] || /\bid\s*=/.test(t.attrs)) return null;
      reopen.unshift(t.raw);
      need = need.slice(1);
    }
  }
  if (need.length) return null;

  const before = strays.map((n) => `</${n}>`).join("") + OPEN
    + reopen.join("");
  return [
    { at, insert: before },
    { at: tokens[close].start, insert: CLOSE },
  ];
}

// The document with every prose element's last two words kept
// together, and how many were.
export function wrapLastWords(html) {
  const tokens = tokenize(html);
  const stack = [];
  const edits = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type === "open" && !t.selfClosing) {
      stack.push({ name: t.name, i });
    } else if (t.type === "close") {
      const found = stack.findLastIndex((e) => e.name === t.name);
      if (found === -1) continue;
      const { i: open } = stack[found];
      stack.length = found;
      if (!PROSE.has(t.name)) continue;
      if (stack.some((e) => SKIP.has(e.name))) continue;
      const edit = plan(tokens, open, i);
      if (edit) edits.push(...edit);
    }
  }
  edits.sort((a, b) => b.at - a.at);
  let out = html;
  for (const { at, insert } of edits) {
    out = out.slice(0, at) + insert + out.slice(at);
  }
  return { html: out, count: edits.length / 2 };
}

function* htmlFiles(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* htmlFiles(path);
    else if (name.endsWith(".html")) yield path;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dir = process.argv[2] || "public";
  let total = 0;
  let files = 0;
  for (const file of htmlFiles(dir)) {
    const { html, count } = wrapLastWords(readFileSync(file, "utf8"));
    if (!count) continue;
    writeFileSync(file, html);
    total += count;
    files++;
  }
  console.log(`orphans: kept ${total} last pairs together in ${files} files`);
}
