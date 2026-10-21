import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import config, {
  FEATURES, FLOAT_PRECISION, MULTIPASS, PRETTIFY, TRANSFORM_PRECISION,
} from "../svgo.config.mjs";
import {
  clean, corpus, guard, run, usePattern,
} from "../bin/svg/clean.mjs";
import { KEEP } from "../bin/svg/strip.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CLI = join(ROOT, "bin/svg/clean.mjs");

// James's ~/.bin/svgomg, its FEATURES as of 2026-10-21: [name, on,
// params]. P is { floatPrecision: 10 }; T adds transformPrecision 10.
// When he changes his settings, change this list and svgo.config.mjs
// together.
const P = { floatPrecision: 10 };
const T = { ...P, transformPrecision: 10 };
const REFERENCE = [
  ["removeDoctype", true], ["removeXMLProcInst", true],
  ["removeComments", true], ["removeMetadata", true],
  ["removeXMLNS", false], ["removeEditorsNSData", true],
  ["cleanupAttrs", true], ["mergeStyles", true], ["inlineStyles", true],
  ["minifyStyles", true], ["convertStyleToAttrs", false],
  ["cleanupIds", true], ["removeRasterImages", true],
  ["removeUselessDefs", true], ["cleanupNumericValues", true, P],
  ["cleanupListOfValues", true, P], ["convertColors", true],
  ["removeUnknownsAndDefaults", true],
  ["removeNonInheritableGroupAttrs", true],
  ["removeUselessStrokeAndFill", true], ["removeViewBox", false],
  ["cleanupEnableBackground", true], ["removeHiddenElems", true],
  ["removeEmptyText", true], ["convertShapeToPath", true, P],
  ["moveElemsAttrsToGroup", true], ["moveGroupAttrsToElems", true],
  ["collapseGroups", true], ["convertPathData", true, P],
  ["convertEllipseToCircle", true], ["convertTransform", true, T],
  ["removeEmptyAttrs", true], ["removeEmptyContainers", true],
  ["mergePaths", true, P], ["removeUnusedNS", true], ["reusePaths", true],
  ["sortAttrs", true], ["sortDefsChildren", true], ["removeTitle", true],
  ["removeDesc", true], ["removeDimensions", true],
  ["removeStyleElement", true], ["removeScripts", true],
  ["removeOffCanvasPaths", true], ["convertOneStopGradients", true],
  ["removeDeprecatedAttrs", true], ["removeXlink", false],
];

const DIRTY = '<svg xmlns="http://www.w3.org/2000/svg" ' +
  'class="lucide lucide-x" viewBox="0 0 24 24" width="24" height="24">' +
  '<title>x</title><path d="M18 6 6 18"/></svg>';

describe("svg: the config matches ~/.bin/svgomg", () => {
  it("lists the same features, in the same order, the same ones off", () => {
    assert.deepEqual(FEATURES, REFERENCE);
  });

  it("sets the same global options", () => {
    assert.equal(MULTIPASS, true);
    assert.equal(PRETTIFY, true);
    assert.equal(FLOAT_PRECISION, 10);
    assert.equal(TRANSFORM_PRECISION, 10);
    assert.equal(config.multipass, true);
    assert.equal(config.floatPrecision, 10);
    assert.deepEqual(config.js2svg,
      { pretty: true, indent: 2, eol: "lf", finalNewline: true });
  });

  it("runs the features that are on, in order, then the class strip", () => {
    const names = config.plugins.map((p) => p.name ?? p);

    assert.deepEqual(names, [
      ...REFERENCE.filter(([, on]) => on).map(([name]) => name),
      "stripUnusedClasses",
    ]);
    for (const [name, , params] of REFERENCE.filter(([, , p]) => p)) {
      assert.deepEqual(config.plugins.find((p) => p.name === name).params,
        params, name);
    }
  });
});

describe("svg: unused classes", () => {
  it("drops Lucide's classes and keeps the ones the site styles", () => {
    const out = clean('<svg xmlns="http://www.w3.org/2000/svg" ' +
      'viewBox="0 0 4 4"><path class="lucide black" d="M0 0h4v4H0z"/>' +
      '<path class="lucide-copy" d="M1 1h2v2H1z"/></svg>', "x.svg");

    assert.doesNotMatch(out, /lucide/);
    assert.match(out, /class="black"/);
    assert.equal(out.match(/class=/g).length, 1);
  });

  it("keeps only classes something in the project still uses", () => {
    const files = corpus();

    for (const [name, why] of Object.entries(KEEP)) {
      const re = usePattern(name);

      assert.ok(files.some(({ text }) => re.test(text)),
        `KEEP has "${name}" (${why}), and nothing uses it`);
    }
  });

  it("reads selectors and quoted names as uses, properties not", () => {
    const uses = (text) => usePattern("ring").test(text);

    assert.ok(uses("svg .ring { fill: red; }"));
    assert.ok(uses("#ring{}"));
    assert.ok(uses('el.querySelector(".ring")'));
    assert.ok(uses('el.classList.add("ring")'));
    assert.ok(uses('<g class="a ring b">'));
    assert.ok(uses("[class~=ring]"));
    assert.ok(!uses("expect(still.ring).toBe(1)"));
    assert.ok(!uses(".ringside {}"));
    assert.ok(!uses("a-ring"));
  });

  it("stops before dropping a class or id something names", () => {
    const before = '<svg viewBox="0 0 4 4"><path id="dot" ' +
      'class="lucide pin" d="M0 0h4v4H0z"/></svg>';
    const after = '<svg viewBox="0 0 4 4"><path d="M0 0h4v4H0z"/></svg>';
    const hits = guard(before, after, [
      { file: "assets/styles/x.scss", text: ".pin { fill: red; }" },
      { file: "assets/scripts/y.js", text: 'byId("dot")' },
    ]);

    assert.deepEqual(hits, [
      { kind: "class", name: "pin", files: ["assets/styles/x.scss"] },
      { kind: "id", name: "dot", files: ["assets/scripts/y.js"] },
    ]);
  });

  it("writes nothing for a file the guard stops", () => {
    let wrote = false;
    const [result] = run(["x.svg"], {
      read: () => '<svg xmlns="http://www.w3.org/2000/svg" ' +
        'viewBox="0 0 4 4"><path class="pin" d="M0 0h4v4H0z"/></svg>',
      write: () => { wrote = true; },
      corpus: [{ file: "a.scss", text: ".pin {}" }],
    });

    assert.equal(result.blocked.length, 1);
    assert.equal(wrote, false);
  });
});

describe("svg: the check", () => {
  const dir = () => mkdtempSync(join(tmpdir(), "svg-"));
  const check = (...files) => spawnSync(process.execPath,
    [CLI, "--check", ...files], { encoding: "utf8" });

  it("fails on an SVG the clean-up would change", () => {
    const file = join(dir(), "dirty.svg");

    writeFileSync(file, DIRTY);
    const result = check(file);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /not cleaned\. Run npm run svg:clean/);
    assert.equal(readFileSync(file, "utf8"), DIRTY, "the check wrote");
  });

  it("passes the same SVG once cleaned", () => {
    const file = join(dir(), "clean.svg");

    writeFileSync(file, clean(DIRTY, file));
    assert.equal(check(file).status, 0);
  });

  it("cleans to a fixed point: a cleaned file cleans to itself", () => {
    const once = clean(DIRTY, "x.svg");

    assert.equal(clean(once, "x.svg"), once);
  });
});

describe("svg: where the check runs", () => {
  it("is a step of CI's lint-and-test", () => {
    const ci = readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8");
    const job = ci.match(
      /\n {2}lint-and-test:\n([\s\S]*?)(?=\n {2}[\w-]+:\n|$)/)?.[1];

    assert.ok(job, "no lint-and-test job");
    assert.match(job, /run: env -i .* npm run check:svg\n/);
  });

  // The pre-commit hook, run as git runs it, in a repository with an
  // SVG staged. npm is a stand-in that runs check:svg for real and
  // passes the lint and tests, which have their own checks.
  const commit = (svg, name = "x.svg") => {
    const cwd = mkdtempSync(join(tmpdir(), "precommit-"));
    const bin = join(cwd, ".bin");
    const git = (...args) => execFileSync("git", args, { cwd });

    mkdirSync(bin);
    writeFileSync(join(bin, "npm"), [
      "#!/bin/sh",
      "# npm run --silent <script> [-- files]",
      `if [ "$3" = check:svg ]; then shift 4; exec "${process.execPath}" ` +
        `"${CLI}" --check "$@"; fi`,
      "exit 0",
      "",
    ].join("\n"));
    chmodSync(join(bin, "npm"), 0o755);
    git("init", "-q");
    mkdirSync(join(cwd, "icons"));
    writeFileSync(join(cwd, "icons", name), svg);
    git("add", "--", `icons/${name}`);

    return spawnSync("sh", [join(ROOT, ".githooks/pre-commit")], {
      cwd,
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    });
  };

  it("refuses a commit that stages an uncleaned SVG", () => {
    const result = commit(DIRTY);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /icons\/x\.svg: not cleaned/);
  });

  it("lets a cleaned SVG through", () => {
    assert.equal(commit(clean(DIRTY, "x.svg")).status, 0);
  });

  it("keeps a name with a space or a glob character whole", () => {
    const name = "a b*.svg";
    const refused = commit(DIRTY, name);

    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /icons\/a b\*\.svg: not cleaned/);
    assert.equal(commit(clean(DIRTY, "x.svg"), name).status, 0);
  });
});
