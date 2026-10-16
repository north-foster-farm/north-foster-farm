// Private source maps (#246, option a). A production build minifies
// the scripts, so a stack from the browser points into one long line.
// The build writes each bundle's map beside it, and bin/maps/stash.mjs
// moves every map out of public/ into the `maps` store under the
// commit it was built from, so no map is ever served. A report
// carries that commit (`build`); `bin/nff errors show` reads the maps
// back and turns each frame into the original file and line, with
// Node's own module.SourceMap.
//
// Keys: `<sha>/<path>.map`, the path as the site serves the script
// without its fingerprint: scripts/order/main.js.map.

import { SourceMap } from "node:module";

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

export const mapKey = (sha, path) => `${sha}/${path}`;

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
export const mapStack = async (stack, sha, load) => {
  const cache = new Map();
  const out = [];

  for (const frame of frames(stack)) {
    const path = mapPath(frame.url);

    if (!path) {
      out.push({ frame, missing: "not a script" });
      continue;
    }

    const key = mapKey(sha, path);

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
