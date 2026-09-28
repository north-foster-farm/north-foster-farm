// Check the JSON-LD in built HTML (#191). Run it on a Hugo build:
//
//   bin/schema/check.mjs public
//
// It prints one line per finding and exits 1 if there is any. The
// graph comes from layouts/partials/head/schema.html, and these are the
// rules it keeps, after schema.org and Google's structured data
// guidelines:
//
// S1  every page but a redirect has one JSON-LD block, and it parses
// S2  the block is {"@context": "https://schema.org", "@graph": [...]}
// S3  every node in the graph has a known @type and a unique @id
// S4  every {"@id": ...} reference names a node in the same graph
// S5  every URL is absolute https
// S6  each type has what it needs (REQUIRED below); a PostalAddress is
//     complete, GeoCoordinates are numbers, a date has a time and an
//     offset, and nothing ends before it starts
// S7  a BreadcrumbList counts from 1, and links every item but the last
// S8  a news post carries a BlogPosting, and the home page the farm's
//     address

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";

const PAGES = ["WebPage", "ContactPage", "AboutPage", "CollectionPage"];

const REQUIRED = {
  LocalBusiness: ["name", "url", "logo"],
  WebSite: ["name", "url", "publisher"],
  BreadcrumbList: ["itemListElement"],
  BlogPosting: [
    "headline", "url", "image", "datePublished", "dateModified", "author",
    "publisher", "mainEntityOfPage",
  ],
  Event: [
    "name", "startDate", "endDate", "location", "eventStatus",
    "eventAttendanceMode", "organizer",
  ],
  ...Object.fromEntries(PAGES.map((t) => [t, ["url", "name", "isPartOf"]])),
};

// Nested types, which carry no @id of their own.
const NESTED = {
  ImageObject: ["url"],
  PostalAddress: [
    "streetAddress", "addressLocality", "addressRegion", "postalCode",
    "addressCountry",
  ],
  GeoCoordinates: ["latitude", "longitude"],
  Place: ["name", "address"],
  City: ["name"],
  ListItem: ["position", "name"],
};

const URL_KEYS = new Set([
  "url", "item", "image", "hasMap", "sameAs", "eventStatus",
  "eventAttendanceMode",
]);
const DATE_KEYS = new Set([
  "datePublished", "dateModified", "startDate", "endDate",
]);
const DATE = /^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d)?(?:Z|[+-]\d\d:\d\d)$/;
const HEADLINE_MAX = 110;

// Check one parsed JSON-LD block. Returns [{rule, message}].
export function checkGraph(data) {
  const findings = [];
  const add = (rule, message) => findings.push({ rule, message });

  if (data?.["@context"] !== "https://schema.org"
    || !Array.isArray(data["@graph"])) {
    add("S2", "not a schema.org @graph");
    return findings;
  }

  const graph = data["@graph"];
  const ids = new Map();
  for (const node of graph) {
    const id = node["@id"];
    if (!REQUIRED[node["@type"]]) {
      add("S3", `unknown node type ${JSON.stringify(node["@type"])}`);
    }
    if (typeof id !== "string") add("S3", `${node["@type"]} has no @id`);
    else if (ids.has(id)) add("S3", `${id} appears twice`);
    else ids.set(id, node);
  }

  const has = (where, obj, keys) => {
    for (const key of keys) {
      const v = obj[key];
      if (v === undefined || v === null || v === ""
        || (Array.isArray(v) && !v.length)) {
        add("S6", `${where} has no ${key}`);
      }
    }
  };

  const fields = (obj, where) => {
    for (const [k, v] of Object.entries(obj)) {
      if (!k.startsWith("@")) walk(v, `${where}.${k}`, k);
    }
  };
  const walk = (value, where, key) => {
    if (Array.isArray(value)) {
      value.forEach((v, i) => walk(v, `${where}[${i}]`, key));
      return;
    }
    if (value && typeof value === "object") {
      const keys = Object.keys(value);
      if (keys.length === 1 && keys[0] === "@id") {
        if (!ids.has(value["@id"])) {
          add("S4", `${where} points at ${value["@id"]}, not in the graph`);
        }
        return;
      }
      const type = value["@type"];
      if (NESTED[type]) has(`${where} (${type})`, value, NESTED[type]);
      else add("S3", `${where} has unknown type ${JSON.stringify(type)}`);
      if (type === "GeoCoordinates"
        && !(Number.isFinite(value.latitude)
          && Number.isFinite(value.longitude))) {
        add("S6", `${where}: coordinates are not numbers`);
      }
      fields(value, where);
      return;
    }
    if (URL_KEYS.has(key) && !/^https:\/\/[^\s]+$/.test(String(value))) {
      add("S5", `${where} is not an absolute https URL: ${value}`);
    }
    if (DATE_KEYS.has(key) && !DATE.test(String(value))) {
      add("S6", `${where} is not a date with a time and offset: ${value}`);
    }
  };

  for (const node of graph) {
    const type = node["@type"];
    const where = node["@id"] || type;
    if (REQUIRED[type]) has(where, node, REQUIRED[type]);
    fields(node, where);

    if (type === "LocalBusiness" && node.address
      && node.address["@type"] !== "PostalAddress") {
      add("S6", `${where}: address is not a PostalAddress`);
    }
    if (type === "Event" && node.location?.["@type"] !== "Place") {
      add("S6", `${where}: location is not a Place`);
    }
    if (type === "BlogPosting"
      && String(node.headline).length > HEADLINE_MAX) {
      add("S6", `${where}: headline over ${HEADLINE_MAX} characters`);
    }
    const [from, to] = type === "Event"
      ? [node.startDate, node.endDate]
      : [node.datePublished, node.dateModified];
    if (DATE.test(from) && DATE.test(to) && new Date(to) < new Date(from)) {
      add("S6", `${where}: ends before it starts`);
    }

    if (type === "BreadcrumbList") {
      const items = node.itemListElement || [];
      items.forEach((item, i) => {
        if (item.position !== i + 1) {
          add("S7", `${where}: item ${i + 1} has position ${item.position}`);
        }
        if (i < items.length - 1 && !item.item) {
          add("S7", `${where}: item ${i + 1} has no link`);
        }
      });
    }
  }
  return findings;
}

const BLOCK = /<script type="?application\/ld\+json"?>([\s\S]*?)<\/script>/g;

// Check one built page. `path` is relative to the build, with forward
// slashes ("news/some-post/index.html"), for S8.
export function checkHtml(html, path = "") {
  if (/<meta http-equiv="?refresh/i.test(html)) return [];
  const blocks = [...html.matchAll(BLOCK)].map((m) => m[1]);
  if (blocks.length !== 1) {
    return [{ rule: "S1", message: `${blocks.length} JSON-LD blocks` }];
  }
  let data;
  try {
    data = JSON.parse(blocks[0]);
  } catch (e) {
    return [{ rule: "S1", message: `JSON-LD does not parse: ${e.message}` }];
  }

  const findings = checkGraph(data);
  const types = (data["@graph"] || []).map((n) => n["@type"]);
  if (/^news\/(?!page\/)[^/]+\/index\.html$/.test(path)
    && !types.includes("BlogPosting")) {
    findings.push({ rule: "S8", message: "a news post with no BlogPosting" });
  }
  const farm = (data["@graph"] || []).find(
    (n) => n["@type"] === "LocalBusiness");
  if (path === "index.html" && !farm?.address) {
    findings.push({ rule: "S8", message: "the home page has no address" });
  }
  return findings;
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
  let count = 0;
  for (const file of htmlFiles(dir)) {
    const path = relative(dir, file).split(sep).join("/");
    for (const f of checkHtml(readFileSync(file, "utf8"), path)) {
      count++;
      console.log(`${path} ${f.rule}: ${f.message}`);
    }
  }
  console.log(`schema check: ${count} findings`);
  process.exitCode = count ? 1 : 0;
}
