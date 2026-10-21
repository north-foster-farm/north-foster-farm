import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { registryFacts } from "../bin/supply/check.mjs";
import {
  newlyUnattested, resolvedPackages, tooNew,
} from "../bin/supply/lockfile.mjs";

const lock = {
  packages: {
    "": { name: "site", dependencies: { a: "1.0.0" } },
    "node_modules/a": { version: "1.0.0", resolved: "https://r/a-1.0.0.tgz" },
    "node_modules/a/node_modules/b": {
      version: "2.0.0", resolved: "https://r/b-2.0.0.tgz",
    },
    "node_modules/b": { version: "2.0.0", resolved: "https://r/b-2.0.0.tgz" },
    "node_modules/@s/c": { version: "3.0.0", resolved: "https://r/c.tgz" },
    "node_modules/w": { resolved: "workspace", link: true },
    "node_modules/g": { version: "1.0.0", resolved: "git+ssh://x/g.git" },
    "node_modules/x-cjs": {
      name: "x", version: "4.0.0", resolved: "https://r/x-4.0.0.tgz",
    },
  },
};

const NOW = Date.parse("2026-10-18T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const ago = (days) => new Date(NOW - days * DAY).toISOString();

describe("resolvedPackages", () => {
  it("lists registry packages once, resolving aliases", () => {
    const keys = resolvedPackages(lock).map((p) => `${p.name}@${p.version}`);

    assert.deepEqual(keys, ["a@1.0.0", "b@2.0.0", "@s/c@3.0.0", "x@4.0.0"]);
  });
});

describe("tooNew", () => {
  const pkgs = [
    { name: "a", version: "1.0.0" },
    { name: "b", version: "2.0.0" },
  ];

  it("flags a version under 7 days old and passes an older one", () => {
    const published = { "a@1.0.0": ago(6.9), "b@2.0.0": ago(7.1) };

    assert.deepEqual(tooNew(pkgs, published, NOW, 7),
      { young: ["a@1.0.0"], unknown: [] });
  });

  it("returns a package with no publish date as unknown", () => {
    assert.deepEqual(tooNew(pkgs, { "a@1.0.0": ago(30) }, NOW, 7),
      { young: [], unknown: ["b@2.0.0"] });
  });

  it("lets a waiver pass that exact version only", () => {
    const published = { "a@1.0.0": ago(1), "b@2.0.0": ago(1) };
    const waivers = [{ package: "a", version: "1.0.0" }];

    assert.deepEqual(tooNew(pkgs, published, NOW, 7, waivers),
      { young: ["b@2.0.0"], unknown: [] });
    assert.deepEqual(
      tooNew(pkgs, published, NOW, 7, [{ package: "a", version: "1.0.1" }])
        .young,
      ["a@1.0.0", "b@2.0.0"],
    );
  });
});

describe("newlyUnattested", () => {
  const pkgs = [
    { name: "a", version: "1.0.0" },
    { name: "a", version: "1.1.0" },
    { name: "b", version: "2.0.0" },
    { name: "c", version: "3.0.0" },
  ];
  const attested = {
    "a@1.0.0": false, "a@1.1.0": false, "b@2.0.0": false, "c@3.0.0": true,
  };

  it("names each unattested package once, minus the baseline", () => {
    assert.deepEqual(newlyUnattested(pkgs, attested, []), ["a", "b"]);
    assert.deepEqual(newlyUnattested(pkgs, attested, ["a"]), ["b"]);
  });

  it("approves only the pinned version of a name@version entry", () => {
    assert.deepEqual(
      newlyUnattested(pkgs, attested, ["a@1.0.0", "b"]), ["a"],
    );
    assert.deepEqual(
      newlyUnattested(pkgs, attested, ["a@1.0.0", "a@1.1.0", "b"]), [],
    );
  });

  it("reads a scoped name with and without a pinned version", () => {
    const scoped = [
      { name: "@s/c", version: "3.0.0" },
      { name: "@s/c", version: "3.1.0" },
    ];
    const none = { "@s/c@3.0.0": false, "@s/c@3.1.0": false };

    assert.deepEqual(newlyUnattested(scoped, none, ["@s/c"]), []);
    assert.deepEqual(
      newlyUnattested(scoped, none, ["@s/c@3.0.0"]), ["@s/c"],
    );
    assert.deepEqual(
      newlyUnattested(scoped, none, ["@s/c@3.0.0", "@s/c@3.1.0"]), [],
    );
  });
});

describe("registryFacts", () => {
  it("reads publish dates and attestations from the registry", async () => {
    const records = {
      a: {
        time: { "1.0.0": "2026-01-01T00:00:00Z" },
        versions: { "1.0.0": { dist: { attestations: { url: "u" } } } },
      },
      "@s/c": {
        time: { "3.0.0": "2026-02-01T00:00:00Z" },
        versions: { "3.0.0": { dist: {} } },
      },
    };
    const urls = [];
    const fetchImpl = async (url) => {
      urls.push(url);

      const name = decodeURIComponent(url.split("registry.npmjs.org/")[1]);

      return { ok: true, json: async () => records[name] };
    };
    const pkgs = [
      { name: "a", version: "1.0.0" },
      { name: "@s/c", version: "3.0.0" },
    ];
    const facts = await registryFacts(pkgs, fetchImpl);

    assert.deepEqual(facts.published, {
      "a@1.0.0": "2026-01-01T00:00:00Z",
      "@s/c@3.0.0": "2026-02-01T00:00:00Z",
    });
    assert.deepEqual(facts.attested, { "a@1.0.0": true, "@s/c@3.0.0": false });
    assert.ok(urls.includes("https://registry.npmjs.org/@s%2Fc"));
  });

  it("gives up after three failed tries", async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls++;

      return { ok: false, status: 503 };
    };

    await assert.rejects(
      registryFacts([{ name: "a", version: "1.0.0" }], fetchImpl),
      /registry answered 503/,
    );
    assert.equal(calls, 3);
  });
});
