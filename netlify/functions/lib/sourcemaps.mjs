// Private source maps (#246, option a). A production build minifies
// the scripts, so a stack from the browser points into one long line.
// The build writes each bundle's map beside it, and bin/maps/stash.mjs
// moves every map out of public/ into that deploy's own `maps` store,
// so no map is ever served. A build may write only to its deploy's
// stores (Netlify refuses a site-wide one with a 401), so the maps
// live as long as the deploy does. A report carries the commit
// (`build`); `bin/nff errors show` finds the deploy that built it,
// reads its maps and turns each frame into the original file and line,
// with Node's own module.SourceMap.
//
// Keys: the path as the site serves the script without its
// fingerprint, plus .map: scripts/order/main.js.map.

import { SourceMap } from "node:module";

import { getDeployStore } from "@netlify/blobs";

export const MAPS_STORE = "maps";

// A fingerprinted bundle is name.<sha512 hex>.js.
const FINGERPRINT = /\.[0-9a-f]{32,}(\.js)$/;

// "https://x/scripts/order/main.<hex>.js" -> "scripts/order/main.js.map"
export const mapPath = (url) => {
  let path = String(url || "");

  try {
    path = new URL(path, "https://x").pathname;
  } catch {
    return null;
  }
  path = path.replace(/^\/+/, "");
  if (!path.endsWith(".js")) return null;

  return `${path.replace(FINGERPRINT, "$1")}.map`;
};

// The parts of a build's Blobs context (NETLIFY_BLOBS_CONTEXT, base64
// JSON). -> an object, empty when there is none. Never throws.
export const blobsContext = (env = process.env) => {
  try {
    return env.NETLIFY_BLOBS_CONTEXT ? JSON.parse(Buffer.from(
      env.NETLIFY_BLOBS_CONTEXT, "base64").toString("utf8")) : {};
  } catch {
    return {};
  }
};

// One deploy's `maps` store, as { get, set } of JSON. Throws when an id
// or the token is missing.
export const deployMaps = ({ deployID, siteID, token, apiURL }) => {
  const store = getDeployStore({
    deployID, siteID, token, apiURL, name: MAPS_STORE,
  });

  return {
    get: (key) => store.get(key, { type: "json" }),
    set: (key, value) => store.setJSON(key, value),
  };
};

// The deploy that built `sha`: the newest ready one whose commit is
// it, on `branch` when one is given. Reads the Netlify API only.
// -> { id, branch, context, createdAt } or null.
export const findDeploy = async ({
  sha, siteID, token, branch = null, pages = 5,
  apiURL = "https://api.netlify.com", fetchImpl = globalThis.fetch,
}) => {
  const want = String(sha || "").toLowerCase();

  if (want.length < 7) throw new Error("A commit needs 7 characters.");

  const found = [];

  for (let page = 1; page <= pages; page += 1) {
    const url = new URL(`/api/v1/sites/${siteID}/deploys`, apiURL);

    url.searchParams.set("per_page", "100");
    url.searchParams.set("page", String(page));
    if (branch) url.searchParams.set("branch", branch);

    const res = await fetchImpl(url.toString(), {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!res.ok) throw new Error(`Netlify answered ${res.status}.`);

    const deploys = await res.json();

    for (const d of deploys) {
      const ref = String(d.commit_ref || "").toLowerCase();

      if (d.state === "ready" && ref && (ref.startsWith(want)
        || want.startsWith(ref))) {
        found.push(d);
      }
    }
    if (found.length || deploys.length < 100) break;
  }
  found.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));

  const d = found[0];

  return d ? {
    id: d.id, branch: d.branch, context: d.context, createdAt: d.created_at,
  } : null;
};

// Each frame of a stack that names a script and a place in it, in
// either V8's "at f (url:1:2)" or Safari's and Firefox's "f@url:1:2".
export const frames = (stack) => String(stack || "").split("\n")
  .map((line) => {
    const m = line.match(/((?:https?:\/\/|\/)[^\s()@]+?):(\d+):(\d+)/);

    return m ? {
      line: line.trim(), url: m[1], row: Number(m[2]), col: Number(m[3]),
    } : null;
  })
  .filter(Boolean);

// A source as the build saw it, from its absolute path on the build
// machine to its place in the repo.
export const sourceName = (source) => {
  const s = String(source || "").replace(/^file:\/\//, "");
  const m = s.match(/(?:^|\/)((?:assets|node_modules)\/.*)$/);

  return m ? m[1] : s;
};

// -> [{ frame, source, row, col, name, text } | { frame, missing }],
// one per frame. `load(key)` answers a map's JSON, or null.
export const mapStack = async (stack, load) => {
  const cache = new Map();
  const out = [];

  for (const frame of frames(stack)) {
    const path = mapPath(frame.url);

    if (!path) {
      out.push({ frame, missing: "not a script" });
      continue;
    }

    const key = path;

    if (!cache.has(key)) {
      const payload = await load(key);

      cache.set(key, payload ? new SourceMap(payload) : null);
    }

    const map = cache.get(key);

    if (!map) {
      out.push({ frame, missing: `no map ${key}` });
      continue;
    }

    const entry = map.findEntry(frame.row - 1, frame.col - 1);

    if (!entry || entry.originalSource === undefined
      || entry.generatedLine !== frame.row - 1) {
      out.push({ frame, missing: "not in the map" });
      continue;
    }

    const index = map.payload.sources.indexOf(entry.originalSource);
    const content = map.payload.sourcesContent
      && map.payload.sourcesContent[index];
    const text = content
      ? (content.split("\n")[entry.originalLine] || "").trim() : null;

    out.push({
      frame,
      source: sourceName(entry.originalSource),
      row: entry.originalLine + 1,
      col: entry.originalColumn + 1,
      name: entry.name || null,
      text,
    });
  }

  return out;
};

// The mapped stack as lines for a terminal.
export const formatMapped = (mapped) => mapped.flatMap((m) => {
  if (m.missing) return [`  ${m.frame.line}`, `      (${m.missing})`];

  return [
    `  ${m.source}:${m.row}:${m.col}${m.name ? `  (${m.name})` : ""}`,
    ...(m.text ? [`      ${m.text.slice(0, 120)}`] : []),
  ];
});
