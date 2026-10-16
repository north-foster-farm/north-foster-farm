import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, mkdir, readdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  formatMapped, frames, mapPath, mapStack, sourceName,
} from "../netlify/functions/lib/sourcemaps.mjs";
import { testStores } from "../netlify/functions/lib/store.mjs";
import { run, stash } from "../bin/maps/stash.mjs";

const HEX = "e11b50ad".repeat(16);
const BUNDLE = `https://www.northfosterfarm.com/scripts/order/main.${HEX}.js`;

// A minified line whose column 10 onward came from line 3, column 5
// of pay.js ("SAEI": nine columns on, two lines down, four across).
const MAP = {
  version: 3,
  sources: ["file:///opt/build/repo/assets/scripts/order/pay.js"],
  sourcesContent: [
    "// one\n// two\n    await this.card.attach(qs(this.root));\n",
  ],
  names: [],
  mappings: "AAAA,SAEI",
};

describe("private source maps", () => {
  it("finds a bundle's map whatever its fingerprint", () => {
    assert.equal(mapPath(BUNDLE), "scripts/order/main.js.map");
    assert.equal(mapPath("/scripts/report.js"), "scripts/report.js.map");
    assert.equal(mapPath("https://web.squarecdn.com/v1/square.js"),
      "v1/square.js.map");
    assert.equal(mapPath("https://x/order/"), null);
  });

  it("reads V8's frames and Safari's", () => {
    const f = frames([
      "TypeError: x is undefined",
      `    at Payment.initSquare (${BUNDLE}:1:12)`,
      `initSquare@${BUNDLE}:1:15`,
      "    at <anonymous>",
    ].join("\n"));

    assert.deepEqual(f.map((x) => [x.url, x.row, x.col]),
      [[BUNDLE, 1, 12], [BUNDLE, 1, 15]]);
  });

  it("maps a stack to the source file and line", async () => {
    const asked = [];
    const mapped = await mapStack(`Error: no\n    at f (${BUNDLE}:1:12)\n` +
      "    at g (https://x/scripts/other.js:1:1)", "abc123", async (key) => {
      asked.push(key);

      return key === "abc123/scripts/order/main.js.map" ? MAP : null;
    });

    assert.deepEqual(asked, ["abc123/scripts/order/main.js.map",
      "abc123/scripts/other.js.map"]);
    assert.equal(mapped[0].source, "assets/scripts/order/pay.js");
    assert.equal(mapped[0].row, 3);
    assert.equal(mapped[0].col, 5);
    assert.equal(mapped[0].text, "await this.card.attach(qs(this.root));");
    assert.match(mapped[1].missing, /no map abc123\/scripts\/other\.js\.map/);

    const lines = formatMapped(mapped);

    assert.equal(lines[0], "  assets/scripts/order/pay.js:3:5");
    assert.equal(lines[1].trim(), "await this.card.attach(qs(this.root));");
  });

  it("names a source by its place in the repo", () => {
    assert.equal(sourceName("file:///Users/j/site/node_modules/bootstrap/x.js"),
      "node_modules/bootstrap/x.js");
    assert.equal(sourceName("../../assets/scripts/report.js"),
      "assets/scripts/report.js");
  });

  it("moves every map out of the site and keeps it by commit",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "maps-"));

      await mkdir(join(dir, "scripts", "order"), { recursive: true });
      await writeFile(join(dir, "scripts", "order", "main.js.map"),
        JSON.stringify(MAP));
      await writeFile(join(dir, "scripts", "main.js.map"), "{}");
      await writeFile(join(dir, "scripts", "main.js"), "x");

      const stores = { ...testStores(), persistent: true };
      const r = await stash(dir, { env: { COMMIT_REF: "abc123" }, stores });

      assert.deepEqual(r, { found: 2, kept: 2, removed: 2, sha: "abc123" });
      assert.deepEqual(await readdir(join(dir, "scripts", "order")), []);
      assert.deepEqual(await readdir(join(dir, "scripts")),
        ["main.js", "order"]);
      assert.deepEqual(
        await stores.maps.get("abc123/scripts/order/main.js.map"), MAP);
    });

  it("only removes them off Netlify or without a commit", async () => {
    const dir = await mkdtemp(join(tmpdir(), "maps-"));

    await writeFile(join(dir, "a.js.map"), "{}");

    const stores = testStores();
    const r = await stash(dir, { env: { COMMIT_REF: "abc" }, stores });

    assert.deepEqual(r, { found: 1, kept: 0, removed: 1, sha: "abc" });
    assert.deepEqual(await readdir(dir), []);
    assert.deepEqual(await stores.maps.list(""), []);
  });

  // A site with two maps, and a warn that records.
  const site = async () => {
    const dir = await mkdtemp(join(tmpdir(), "maps-"));

    await writeFile(join(dir, "a.js.map"), "{}");
    await writeFile(join(dir, "b.js.map"), "{}");

    return dir;
  };
  const warnings = () => {
    const said = [];

    return { said, warn: (line) => said.push(line) };
  };

  it("removes every map when the store throws", async () => {
    const dir = await site();
    const { said, warn } = warnings();
    const stores = { persistent: true, maps: {
      set: async () => { throw new Error("MissingBlobsEnvironmentError"); },
    } };
    const r = await stash(dir, { env: { COMMIT_REF: "abc" }, stores, warn });

    assert.deepEqual(r, { found: 2, kept: 0, removed: 2, sha: "abc" });
    assert.deepEqual(await readdir(dir), []);
    assert.equal(said.length, 2);
  });

  it("removes every map when the store cannot even be made", async () => {
    const dir = await site();
    const { said, warn } = warnings();
    // A Blobs context with no site id or token: getStore() throws.
    const env = {
      COMMIT_REF: "abc",
      NETLIFY_BLOBS_CONTEXT: Buffer.from("{}").toString("base64"),
    };
    const r = await stash(dir, { env, warn });

    assert.equal(r.removed, 2);
    assert.equal(r.kept, 0);
    assert.deepEqual(await readdir(dir), []);
    assert.equal(said.length > 0, true);
  });

  it("stops writing at the deadline and still removes them", async () => {
    const dir = await site();
    const { said, warn } = warnings();
    const stores = { persistent: true, maps: {
      set: () => new Promise(() => {}),
    } };
    const r = await stash(dir, {
      env: { COMMIT_REF: "abc" }, stores, warn, deadline: 50,
    });

    assert.deepEqual(r, { found: 2, kept: 0, removed: 2, sha: "abc" });
    assert.match(said.join("\n"), /timed out/);
  });

  it("never throws, for a missing site or anything else", async () => {
    const { warn } = warnings();

    assert.match(await run(join(tmpdir(), "no-such-site-dir"), { warn }),
      /^\[maps\] 0 found, 0 removed/);
    assert.match(await run("x", { env: null }), /^\[maps\] Stash failed/);
  });

  it("runs as the build plugin, and a broken status does not fail it",
    async () => {
      const plugin = createRequire(import.meta.url)(
        "../plugins/source-maps/index.js");
      const dir = await site();
      const utils = {
        status: { show: () => { throw new Error("no status"); } },
        build: { failBuild: () => assert.fail("never fails the build") },
      };

      await plugin.onPostBuild({ constants: { PUBLISH_DIR: dir }, utils });
      assert.deepEqual(await readdir(dir), []);
    });

  it("still removes every map when the stash cannot load", async () => {
    const plugin = createRequire(import.meta.url)(
      "../plugins/source-maps/index.js");
    const dir = await site();
    const shown = [];

    await mkdir(join(dir, "scripts", "order"), { recursive: true });
    await writeFile(join(dir, "scripts", "order", "main.js.map"), "{}");
    await writeFile(join(dir, "scripts", "order", "main.js"), "x");
    await plugin.onPostBuild({
      constants: { PUBLISH_DIR: dir },
      utils: { status: { show: (s) => shown.push(s.summary) } },
    }, async () => { throw new Error("Cannot find module"); });

    assert.deepEqual(await readdir(dir), ["scripts"]);
    assert.deepEqual(await readdir(join(dir, "scripts", "order")),
      ["main.js"]);
    assert.match(shown[0], /Stash failed \(Cannot find module\); 3 removed/);
  });

  it("loads as Netlify loads it: a manifest and one event", () => {
    const plugin = createRequire(import.meta.url)(
      "../plugins/source-maps/index.js");
    const manifest = Object.fromEntries(readFileSync(new URL(
      "../plugins/source-maps/manifest.yml", import.meta.url), "utf8")
      .split("\n").filter((l) => l.trim() && !l.startsWith("#"))
      .map((l) => l.split(/:\s*/)));
    const toml = readFileSync(new URL("../netlify.toml", import.meta.url),
      "utf8");

    assert.deepEqual(manifest, { name: "source-maps" });
    assert.deepEqual(Object.keys(plugin), ["onPostBuild"]);
    assert.equal(typeof plugin.onPostBuild, "function");
    assert.match(toml,
      /\[\[plugins\]\]\npackage = "\.\/plugins\/source-maps"\n/);
  });
});
