// The site's source maps, kept private (#246). After the build and
// before the upload, every map moves out of the publish directory into
// the `maps` Blobs store under the commit (bin/maps/stash.mjs). A
// plugin, not a build-command step: only plugins get the Blobs
// context. Whatever goes wrong is a warning; this never fails a build.
// If the stash itself cannot even load, the maps are still removed
// here with nothing but the file system, so none is ever published.

const fs = require("node:fs");
const path = require("node:path");

// Every *.js.map under `dir`, removed. -> how many. Never throws.
const removeMaps = (dir) => {
  let removed = 0;
  const walk = (d) => {
    let entries;

    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);

      if (e.isDirectory()) {
        walk(p);
      } else if (e.name.endsWith(".js.map")) {
        try {
          fs.unlinkSync(p);
          removed += 1;
        } catch {
          // One left behind is better than a failed build.
        }
      }
    }
  };

  walk(dir);

  return removed;
};

const loadStash = () => import("../../bin/maps/stash.mjs");

const onPostBuild = async ({ constants, utils }, load = loadStash) => {
  let line;

  try {
    const { run } = await load();

    line = await run(constants.PUBLISH_DIR);
  } catch (error) {
    line = `[maps] Stash failed (${(error && error.message) || error}); ` +
      `${removeMaps(constants.PUBLISH_DIR)} removed from the site, 0 kept.`;
  }
  console.log(line);
  try {
    utils.status.show({ title: "Source maps", summary: line });
  } catch {
    // The log line is enough.
  }
};

// Netlify takes every export as an event, so only the event goes out.
module.exports = { onPostBuild };
