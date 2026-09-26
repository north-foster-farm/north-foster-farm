// James's review of the email library on staging: an approval he gives
// from the browser, or a rewrite of an email he has not approved,
// kept in the deploy's `jobs` store under library/ until an agent
// ports it into the code (templates.mjs, library.mjs). Staging only:
// the endpoints that reach this are a 404 in production, and nothing
// here sends mail.
//
// Each counts only for the version it was given against, a hash of
// the email's subject and text as the code builds it today
// (versionFor). When the
// code changes (a rewrite lands, say), the old approval or rewrite no
// longer applies and the email is "to approve" again, showing the new
// text. `bin/nff library` lists what waits to be ported.
//
// A rewrite keeps the sample values (names, order numbers, dates,
// amounts, links) as tokens, so porting it knows which words are the
// template's placeholders: { version, subject, text }, the last two
// each a list of parts, { text } or { token }.

import { createHash } from "node:crypto";

import { SAMPLE_TEXT } from "./library.mjs";
import { mailLinks } from "./site.mjs";

export const REVIEW_PREFIX = "library/";
const key = (kind, id) => `${REVIEW_PREFIX}${kind}/${id}`;

export const versionOf = (m) => createHash("sha256")
  .update(`${m.subject}\n${m.text}`).digest("hex").slice(0, 12);

// A library email's version, built with the default links so that
// every deploy and the terminal agree on it whatever their SITE_URL.
export const versionFor = (e) => versionOf(e.build(mailLinks({})));

// --- Sample values as tokens ---------------------------------------

const MONTHS = "January|February|March|April|May|June|July|August|" +
  "September|October|November|December";
const DAYS = "Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday";
const literal = (s) => new RegExp(
  `(?<![\\w])${s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w])`, "g"
);

const RULES = [
  /https?:\/\/[^\s)]+/g,
  /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g,
  /NFF-\d{4}-[A-Z0-9]{4}/g,
  /[−-]?\$\d{1,3}(?:,\d{3})*(?:\.\d\d)?\+?/g,
  new RegExp(`(?:(?:${DAYS}), )?(?:${MONTHS}) \\d{1,2}(?:, \\d{4})?`, "g"),
  /\d{4}-\d\d-\d\d(?: \d\d:\d\d UTC)?/g,
  new RegExp("\\b\\d{1,2}(?::\\d\\d)?(?:\\s*(?:–|-|to|and)\\s*" +
    "\\d{1,2}(?::\\d\\d)?)?\\s?(?:AM|PM)\\b", "g"),
  /\b\d{1,2}:\d\d(?: to \d{1,2}:\d\d)?\b/g,
  /\(\d{3}\) \d{3}-\d{4}|\b\d{3}-\d{3}-\d{4}\b/g,
  new RegExp("\\b\\d+ [A-Z][A-Za-z ]+ (?:Rd|Road|Lane|Pike|St|Street|Ave)" +
    "\\b(?:, [A-Z][A-Za-z ]+)?(?:, [A-Z]{2})? \\d{5}", "g"),
  /\b\d+ ×/g,
  /\b[A-Z][a-z]+ ending \d{4}\b/g,
  ...SAMPLE_TEXT.map(literal),
];

// The text as parts, each sample value a token: at each place the
// earliest match wins, and of those the longest.
export const tokenize = (text) => {
  const found = [];

  for (const rule of RULES) {
    for (const m of text.matchAll(rule)) {
      found.push([m.index, m.index + m[0].length]);
    }
  }
  found.sort((a, b) => a[0] - b[0] || b[1] - a[1]);

  const parts = [];
  let at = 0;

  for (const [start, end] of found) {
    if (start < at) continue;
    if (start > at) parts.push({ text: text.slice(at, start) });
    parts.push({ token: text.slice(start, end) });
    at = end;
  }
  if (at < text.length) parts.push({ text: text.slice(at) });

  return parts;
};

export const joined = (parts) => parts
  .map((p) => (p.token === undefined ? p.text : p.token)).join("");

// A rewrite's parts, checked: text and tokens only, and every token
// one of the email's own sample values. Null when it will not do.
const MAX = 20000;

export const cleanParts = (parts, allowed) => {
  if (!Array.isArray(parts) || parts.length > 2000) return null;

  const out = [];

  for (const p of parts) {
    if (!p || typeof p !== "object") return null;
    if (typeof p.token === "string") {
      if (!allowed.has(p.token)) return null;
      out.push({ token: p.token });
    } else if (typeof p.text === "string") {
      if (!p.text) continue;

      const last = out.at(-1);

      if (last && last.text !== undefined) last.text += p.text;
      else out.push({ text: p.text });
    } else {
      return null;
    }
  }

  return joined(out).length > MAX ? null : out;
};

// --- The store -----------------------------------------------------

// Every approval and rewrite saved, by email id.
export const reviews = async (stores) => {
  const out = {};

  for (const { key: k } of await stores.jobs.list(REVIEW_PREFIX)) {
    const [, kind, id] = k.split("/");
    const value = await stores.jobs.get(k);

    if (value && (kind === "approval" || kind === "rewrite")) {
      out[id] = { ...out[id], [kind]: value };
    }
  }

  return out;
};

export const saveApproval = (stores, id, version, now = new Date()) =>
  stores.jobs.delete(key("rewrite", id)).then(() => stores.jobs.set(
    key("approval", id), { version, at: now.toISOString() }
  ));

export const withdrawApproval = (stores, id) =>
  stores.jobs.delete(key("approval", id));

export const saveRewrite = (stores, id, rewrite, now = new Date()) =>
  stores.jobs.delete(key("approval", id)).then(() => stores.jobs.set(
    key("rewrite", id), { ...rewrite, at: now.toISOString() }
  ));

export const revert = (stores, id) => stores.jobs.delete(key("rewrite", id));

// Both of an email's records gone, once they are in the code.
export const clear = async (stores, id) => {
  await revert(stores, id);
  await withdrawApproval(stores, id);
};

// --- What waits to be ported --------------------------------------

// Parts as text, the tokens marked, for reading in a terminal.
export const marked = (parts) => parts
  .map((p) => (p.token === undefined ? p.text : `⟦${p.token}⟧`)).join("");

// A line diff, "  " kept, "- " the code's, "+ " the rewrite's.
export const diffLines = (a, b) => {
  const x = a.split("\n");
  const y = b.split("\n");
  const n = x.length;
  const m = y.length;
  const lcs = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));

  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      lcs[i][j] = x[i] === y[j]
        ? lcs[i + 1][j + 1] + 1
        : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  const out = [];
  let i = 0;
  let j = 0;

  while (i < n || j < m) {
    if (i < n && j < m && x[i] === y[j]) {
      out.push(`  ${x[i]}`);
      i += 1;
      j += 1;
    } else if (j < m && (i === n || lcs[i][j + 1] >= lcs[i + 1][j])) {
      out.push(`+ ${y[j]}`);
      j += 1;
    } else {
      out.push(`- ${x[i]}`);
      i += 1;
    }
  }

  return out;
};

// Every saved approval and rewrite, and whether it still applies:
// "port" (approve it in library.mjs, or apply the rewrite), "stale"
// (made against an earlier version; clear it) or "code" (approved in
// the code since; clear it). A rewrite carries a diff against the
// email as `links` build it.
export const pending = async (stores, library, links) => {
  const saved = await reviews(stores);
  const out = [];

  for (const [id, records] of Object.entries(saved)) {
    const e = library.find((x) => x.id === id);

    for (const kind of ["approval", "rewrite"]) {
      const r = records[kind];

      if (!r) continue;

      const item = { id, kind, at: r.at, name: e ? e.name : null };

      if (!e || r.version !== versionFor(e)) {
        out.push({ ...item, state: "stale" });
      } else if (e.approval === "approved") {
        out.push({ ...item, state: "code" });
      } else if (kind === "approval") {
        out.push({ ...item, state: "port" });
      } else {
        const m = e.build(links);
        const now = `Subject: ${marked(tokenize(m.subject))}\n\n${
          marked(tokenize(m.text))}`;
        const next = `Subject: ${marked(r.subject)}\n\n${marked(r.text)}`;

        out.push({ ...item, state: "port", diff: diffLines(now, next) });
      }
    }
  }

  return out;
};

// Where an email stands: approved in the code, rewritten, approved on
// staging, or to approve. Records made against another version of it
// do not count.
export const standing = (e, version, saved = {}) => {
  const { approval, rewrite } = saved;

  if (e.approval === "approved") {
    return { version, approval: "approved", approvedBy: "code" };
  }
  if (rewrite && rewrite.version === version) {
    return { version, approval: "rewritten", rewrite };
  }
  if (approval && approval.version === version) {
    return {
      version, approval: "approved", approvedBy: "staging",
      approvedAt: approval.at,
    };
  }

  return { version, approval: "to approve" };
};
