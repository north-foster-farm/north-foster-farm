import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, mkdir, readdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  findDeploy, formatMapped, frames, mapPath, mapStack, sourceName,
} from "../netlify/functions/lib/sourcemaps.mjs";
import { memoryStore } from "../netlify/functions/lib/store.mjs";
import { diagnose, run, stash, summary } from "../bin/maps/stash.mjs";

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
      "    at g (https://x/scripts/other.js:1:1)", async (key) => {
      asked.push(key);

      return key === "scripts/order/main.js.map" ? MAP : null;
    });

    assert.deepEqual(asked, ["scripts/order/main.js.map",
      "scripts/other.js.map"]);
    assert.equal(mapped[0].source, "assets/scripts/order/pay.js");
    assert.equal(mapped[0].row, 3);
    assert.equal(mapped[0].col, 5);
    assert.equal(mapped[0].text, "await this.card.attach(qs(this.root));");
    assert.match(mapped[1].missing, /no map scripts\/other\.js\.map/);

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

      const store = memoryStore();
      const r = await stash(dir, { env: { COMMIT_REF: "abc123" }, store });

      assert.deepEqual(r, {
        found: 2, kept: 2, removed: 2, sha: "abc123", reason: null,
      });
      assert.deepEqual(await readdir(join(dir, "scripts", "order")), []);
      assert.deepEqual(await readdir(join(dir, "scripts")),
        ["main.js", "order"]);
      assert.deepEqual(
        await store.get("scripts/order/main.js.map"), MAP);
    });

  it("only removes them off Netlify or without a commit", async () => {
    const dir = await mkdtemp(join(tmpdir(), "maps-"));

    await writeFile(join(dir, "a.js.map"), "{}");

    const r = await stash(dir, { env: { COMMIT_REF: "abc" } });

    assert.deepEqual(r, {
      found: 1, kept: 0, removed: 1, sha: "abc",
      reason: "no Blobs context, so none kept",
    });
    assert.match(summary(r), /0 kept for abc\. no Blobs context/);
    assert.deepEqual(await readdir(dir), []);
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
    const store = {
      set: async () => { throw new Error("MissingBlobsEnvironmentError"); },
    };
    const r = await stash(dir, { env: { COMMIT_REF: "abc" }, store, warn });

    assert.deepEqual(r, {
      found: 2, kept: 0, removed: 2, sha: "abc",
      reason: "Could not keep a.js.map: MissingBlobsEnvironmentError",
    });
    assert.deepEqual(await readdir(dir), []);
    assert.equal(said.length, 2);
  });

  it("removes every map when the store cannot even be made", async () => {
    const dir = await site();
    const { said, warn } = warnings();
    // A Blobs context with a deploy but no site id or token:
    // getDeployStore() throws.
    const env = {
      COMMIT_REF: "abc",
      NETLIFY_BLOBS_CONTEXT: Buffer.from(JSON.stringify({ deployID: "d1" }))
        .toString("base64"),
    };
    const r = await stash(dir, { env, warn });

    assert.equal(r.removed, 2);
    assert.equal(r.kept, 0);
    assert.deepEqual(await readdir(dir), []);
    assert.match(r.reason, /^no Blobs store: /);
    assert.equal(said.length > 0, true);
  });

  it("stops writing at the deadline and still removes them", async () => {
    const dir = await site();
    const { said, warn } = warnings();
    const store = { set: () => new Promise(() => {}) };
    const r = await stash(dir, {
      env: { COMMIT_REF: "abc" }, store, warn, deadline: 50,
    });

    assert.deepEqual(r, {
      found: 2, kept: 0, removed: 2, sha: "abc",
      reason: "Could not keep a.js.map: timed out",
    });
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

  it("says what it could see of the build, and no value", () => {
    const secret = "tok-SECRET-123";
    const context = Buffer.from(JSON.stringify({
      apiURL: "https://api.netlify.com", deployID: "d1", siteID: "s1",
      token: secret, edgeURL: "",
    })).toString("base64");
    const d = diagnose({
      NETLIFY_BLOBS_CONTEXT: context, COMMIT_REF: "abc", CONTEXT:
        "branch-deploy",
    });

    assert.deepEqual(d, {
      event: "maps.env", blobsContext: true,
      blobsContextParts: ["apiURL", "deployID", "siteID", "token"],
      commitRef: true, context: "branch-deploy", siteContext: null,
      store: "deploy:maps",
    });
    assert.equal(JSON.stringify(d).includes(secret), false);
    assert.equal(JSON.stringify(d).includes("s1"), false);
    assert.equal(diagnose({ NETLIFY_BLOBS_CONTEXT: "%%%" })
      .blobsContextParts, "unreadable");
    assert.equal(diagnose({}).blobsContext, false);
    assert.equal(diagnose(null).error.length > 0, true);
  });

  it("writes to this deploy's own maps store, as a build must",
    async () => {
      const seen = [];
      const server = createServer((req, res) => {
        req.resume();
        req.on("end", () => {
          seen.push(`${req.method} ${req.url}`);
          res.setHeader("content-type", "application/json");
          res.end(req.url.startsWith("/api/") ? JSON.stringify({
            url: `http://127.0.0.1:${server.address().port}/signed`,
          }) : "");
        });
      });

      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      try {
        const dir = await site();
        const env = {
          COMMIT_REF: "abc1234",
          NETLIFY_BLOBS_CONTEXT: Buffer.from(JSON.stringify({
            apiURL: `http://127.0.0.1:${server.address().port}`,
            deployID: "d1", siteID: "s1", token: "t",
          })).toString("base64"),
        };
        const r = await stash(dir, { env, warn: () => {} });

        assert.equal(r.kept, 2, r.reason);
        assert.deepEqual(seen.filter((l) => l.startsWith("PUT /api")), [
          "PUT /api/v1/blobs/s1/deploy:d1:maps/a.js.map?region=auto",
          "PUT /api/v1/blobs/s1/deploy:d1:maps/b.js.map?region=auto",
        ]);
      } finally {
        server.close();
      }
    });

  // The Netlify API's deploy list, as the fake answers it.
  const deploysApi = (deploys) => {
    const asked = [];
    const fetchImpl = async (url, init) => {
      asked.push({ url: new URL(url), auth: init.headers.Authorization });

      const page = Number(new URL(url).searchParams.get("page"));

      return {
        ok: true, status: 200,
        json: async () => deploys.slice((page - 1) * 100, page * 100),
      };
    };

    return { asked, fetchImpl };
  };

  it("finds the newest ready deploy that built the commit", async () => {
    const sha = "e006a11b2c3d4e5f60718293a4b5c6d7e8f90123";
    const { asked, fetchImpl } = deploysApi([
      { id: "new-fail", state: "error", commit_ref: sha,
        created_at: "2026-10-16T12:00:00Z" },
      { id: "older", state: "ready", commit_ref: sha, branch: "staging",
        context: "branch-deploy", created_at: "2026-10-16T10:00:00Z" },
      { id: "newer", state: "ready", commit_ref: sha, branch: "staging",
        context: "branch-deploy", created_at: "2026-10-16T11:00:00Z" },
      { id: "other", state: "ready", commit_ref: "d3946ad0000",
        created_at: "2026-10-16T13:00:00Z" },
    ]);
    const d = await findDeploy({
      sha: "e006a11", siteID: "s1", token: "t", branch: "staging",
      fetchImpl,
    });

    assert.deepEqual(d, {
      id: "newer", branch: "staging", context: "branch-deploy",
      createdAt: "2026-10-16T11:00:00Z",
    });
    assert.equal(asked[0].url.pathname, "/api/v1/sites/s1/deploys");
    assert.equal(asked[0].url.searchParams.get("branch"), "staging");
    assert.equal(asked[0].auth, "Bearer t");
  });

  it("pages through the list, and says when no deploy built it",
    async () => {
      const filler = Array.from({ length: 150 }, (_, i) => ({
        id: `f${i}`, state: "ready", commit_ref: "1111111aaaa",
        created_at: "2026-10-01T00:00:00Z",
      }));
      const late = { id: "late", state: "ready", commit_ref: "abcdef12",
        created_at: "2026-09-30T00:00:00Z" };
      const { asked, fetchImpl } = deploysApi([...filler, late]);

      assert.equal((await findDeploy({
        sha: "abcdef12", siteID: "s", token: "t", fetchImpl,
      })).id, "late");
      assert.equal(asked.length, 2);
      assert.equal(await findDeploy({
        sha: "9999999", siteID: "s", token: "t", fetchImpl,
      }), null);
      await assert.rejects(findDeploy({
        sha: "abc", siteID: "s", token: "t", fetchImpl,
      }), /7 characters/);
      await assert.rejects(findDeploy({
        sha: "abcdef12", siteID: "s", token: "t",
        fetchImpl: async () => ({ ok: false, status: 401 }),
      }), /401/);
    });
});
