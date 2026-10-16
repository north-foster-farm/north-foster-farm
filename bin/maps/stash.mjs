// Moves every source map out of the built site and into this deploy's
// own `maps` Blobs store, keyed by the map's path (#246; see
// netlify/functions/lib/sourcemaps.mjs). A build may write only to
// its deploy's stores. Netlify runs it from the local build plugin
// plugins/source-maps after the build, before the upload, where the
// Blobs context exists (the build command has none).
// Off Netlify, without a commit, or with a store that will not take
// them, the maps are only removed. Nothing here fails a deploy: every
// step is guarded, every map is removed whatever happened before, and
// the writes stop at a deadline.
//
//   node bin/maps/stash.mjs [dir]     dir defaults to public; removes
//                                     only, unless Blobs is configured

import { readdir, readFile, unlink } from "node:fs/promises";
import { join, relative, sep } from "node:path";

import {
  MAPS_STORE, blobsContext, deployMaps,
} from "../../netlify/functions/lib/sourcemaps.mjs";

export const DEADLINE = 60_000;

const walk = async (dir) => {
  const out = [];

  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);

    if (entry.isDirectory()) {
      out.push(...await walk(path));
    } else if (entry.name.endsWith(".js.map")) {
      out.push(path);
    }
  }

  return out;
};

const message = (error) => (error && error.message) || String(error);

// What the run could see of its environment, for the deploy log: which
// variables are set and which parts the Blobs context names, never a
// value. -> a plain object. Never throws.
export const diagnose = (env = process.env) => {
  const out = { event: "maps.env" };

  try {
    let parts = null;

    if (env.NETLIFY_BLOBS_CONTEXT) {
      const context = blobsContext(env);

      parts = Object.keys(context).length
        ? Object.keys(context).filter((k) => !!context[k]).sort()
        : "unreadable";
    }
    Object.assign(out, {
      blobsContext: !!env.NETLIFY_BLOBS_CONTEXT,
      blobsContextParts: parts,
      commitRef: !!env.COMMIT_REF,
      context: env.CONTEXT || null,
      siteContext: env.SITE_CONTEXT || null,
      store: `deploy:${MAPS_STORE}`,
    });
  } catch (error) {
    out.error = message(error);
  }

  return out;
};

// This deploy's maps store, from the build's Blobs context, or null
// and why there is none to write to.
const mapsStore = (env) => {
  try {
    const context = blobsContext(env);

    if (!context.deployID) {
      return { store: null, reason: "no Blobs context, so none kept" };
    }

    return { store: deployMaps(context), reason: null };
  } catch (error) {
    return { store: null, reason: `no Blobs store: ${message(error)}` };
  }
};

// -> { found, kept, removed, sha, reason }, the reason being the
// first thing that cost any map, or null. `store` stands in for the
// deploy's (tests). Never throws.
export const stash = async (dir, {
  env = process.env, store: given, deadline = DEADLINE,
  warn: say = console.warn,
} = {}) => {
  const sha = env.COMMIT_REF || null;
  let reason = null;
  const warn = (line) => {
    if (!reason) reason = line.replace(/^\[maps\] /, "");
    say(line);
  };
  let files = [];

  try {
    files = await walk(dir);
  } catch (error) {
    warn(`[maps] Could not read ${dir}: ${message(error)}`);
  }

  let store = null;

  if (!sha) {
    if (files.length) reason = "no COMMIT_REF, so none kept";
  } else if (files.length) {
    const found = given === undefined ? mapsStore(env)
      : { store: given, reason: given ? null : "no store, so none kept" };

    store = found.store;
    if (found.reason) warn(`[maps] ${found.reason}`);
  }
  const stop = Date.now() + deadline;
  let kept = 0;

  for (const file of store ? files : []) {
    const path = relative(dir, file).split(sep).join("/");
    const left = stop - Date.now();
    let timer;

    if (left <= 0) {
      warn(`[maps] Out of time: ${files.length - kept} not kept.`);
      break;
    }
    try {
      const map = JSON.parse(await readFile(file, "utf8"));

      await Promise.race([
        store.set(path, map),
        new Promise((resolve, reject) => {
          timer = setTimeout(() => reject(new Error("timed out")), left);
        }),
      ]);
      kept += 1;
    } catch (error) {
      warn(`[maps] Could not keep ${path}: ${message(error)}`);
      if (Date.now() >= stop) break;
    } finally {
      clearTimeout(timer);
    }
  }

  let removed = 0;

  for (const file of files) {
    try {
      await unlink(file);
      removed += 1;
    } catch (error) {
      warn(`[maps] Could not remove ${file}: ${message(error)}`);
    }
  }

  return { found: files.length, kept, removed, sha, reason };
};

export const summary = ({ found, kept, removed, sha, reason }) =>
  `[maps] ${found} found, ${removed} removed from the site, ${kept} kept${
    sha ? ` for ${sha}` : " (no COMMIT_REF)"}.${reason ? ` ${reason}` : ""}`;

// The whole run, guarded: -> the line to print. Never throws.
export const run = async (dir, options = {}) => {
  try {
    return summary(await stash(dir, options));
  } catch (error) {
    return `[maps] Stash failed: ${message(error)}`;
  }
};

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    console.log(await run(process.argv[2] || "public"));
  } catch {
    // Never the deploy's problem.
  }
  process.exitCode = 0;
}
