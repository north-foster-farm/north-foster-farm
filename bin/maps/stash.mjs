// Moves every source map out of the built site and into the `maps`
// Blobs store under the commit it was built from (#246; see
// netlify/functions/lib/sourcemaps.mjs). Netlify runs it from the
// local build plugin plugins/source-maps after the build, before the
// upload, where the Blobs context exists (the build command has none).
// Off Netlify, without a commit, or with a store that will not take
// them, the maps are only removed. Nothing here fails a deploy: every
// step is guarded, every map is removed whatever happened before, and
// the writes stop at a deadline.
//
//   node bin/maps/stash.mjs [dir]     dir defaults to public; removes
//                                     only, unless Blobs is configured

import { readdir, readFile, unlink } from "node:fs/promises";
import { join, relative, sep } from "node:path";

import { mapKey } from "../../netlify/functions/lib/sourcemaps.mjs";
import { stores as makeStores } from "../../netlify/functions/lib/store.mjs";

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

// The maps store, or null when there is none to write to.
const mapsStore = (env, stores, warn) => {
  try {
    const s = stores || makeStores(env);

    return s.persistent && s.maps ? s.maps : null;
  } catch (error) {
    warn(`[maps] No Blobs store: ${message(error)}`);

    return null;
  }
};

// -> { found, kept, removed, sha }. Never throws.
export const stash = async (dir, {
  env = process.env, stores, deadline = DEADLINE, warn = console.warn,
} = {}) => {
  const sha = env.COMMIT_REF || null;
  let files = [];

  try {
    files = await walk(dir);
  } catch (error) {
    warn(`[maps] Could not read ${dir}: ${message(error)}`);
  }

  const store = sha && files.length ? mapsStore(env, stores, warn) : null;
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
        store.set(mapKey(sha, path), map),
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

  return { found: files.length, kept, removed, sha };
};

export const summary = ({ found, kept, removed, sha }) =>
  `[maps] ${found} found, ${removed} removed from the site, ${kept} kept${
    sha ? ` for ${sha}` : " (no COMMIT_REF)"}.`;

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
