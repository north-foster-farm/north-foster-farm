import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { optimize } from "svgo";

import config, {
  FEATURES, FLOAT_PRECISION, MULTIPASS, OVERRIDES, PRETTIFY,
  TRANSFORM_PRECISION, configFor, plugins,
} from "../svgo.config.mjs";
import {
  INLINE_ALLOWED, clean, corpus, guard, inlineSvgs, run, trackedSvgs,
  usePattern,
} from "../bin/svg/clean.mjs";

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
  const LOGO = '<svg xmlns="http://www.w3.org/2000/svg" ' +
    'viewBox="0 0 4 4"><path class="lucide black" d="M0 0h4v4H0z"/>' +
    '<path class="lucide-copy" d="M1 1h2v2H1z"/></svg>';

  it("drops Lucide's classes and keeps the file's own", () => {
    const out = clean(LOGO, "assets/images/logo.svg");

    assert.doesNotMatch(out, /lucide/);
    assert.match(out, /class="black"/);
    assert.equal(out.match(/class=/g).length, 1);
  });

  it("keeps a class only in the file whose override names it", () => {
    assert.doesNotMatch(clean(LOGO, "x.svg"), /class=/);
  });

  it("keeps only classes something in the project still uses", () => {
    const files = corpus();

    for (const [file, { classes = {} }] of Object.entries(OVERRIDES)) {
      for (const [name, why] of Object.entries(classes)) {
        const re = usePattern(name);

        assert.ok(files.some(({ text }) => re.test(text)),
          `${file} keeps "${name}" (${why}), and nothing uses it`);
      }
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

describe("svg: per-file overrides", () => {
  const tracked = new Set(trackedSvgs());
  const on = new Set(FEATURES.filter(([, isOn]) => isOn).map(([n]) => n));
  const read = (file) => readFileSync(join(ROOT, file), "utf8");

  it("names tracked files, features that are on, and a reason each", () => {
    for (const [file, { off = {}, classes = {} }] of
      Object.entries(OVERRIDES)) {
      assert.ok(tracked.has(file), `${file} is not a tracked SVG`);
      for (const name of Object.keys(off)) {
        assert.ok(on.has(name), `${file}: ${name} is not an SVGOMG feature`);
      }
      for (const why of [...Object.values(off), ...Object.values(classes)]) {
        assert.ok(typeof why === "string" && why.length > 20, file);
      }
    }
  });

  it("turns off only what the file needs", () => {
    for (const [file, override] of Object.entries(OVERRIDES)) {
      for (const name of Object.keys(override.off ?? {})) {
        const rest = Object.fromEntries(Object.entries(override.off)
          .filter(([key]) => key !== name));
        const out = optimize(read(file), {
          ...configFor(file), path: file,
          plugins: plugins({ ...override, off: rest }),
        }).data;

        assert.notEqual(out, read(file),
          `${file}: ${name} off changes nothing; drop the override`);
      }
    }
  });

  it("keeps each class its override names in that file", () => {
    for (const [file, { classes = {} }] of Object.entries(OVERRIDES)) {
      for (const name of Object.keys(classes)) {
        assert.match(read(file), usePattern(name), `${file}: ${name}`);
      }
    }
  });

  // The svg.html partial refuses to inline a file with ids unless it is
  // the once-a-page sprite: two copies of an id on one page are
  // invalid, and url(#id) finds only the first.
  it("leaves ids only in a file that keeps them on purpose", () => {
    for (const file of tracked) {
      if (!file.startsWith("assets/images/")) continue;
      const keeps = Object.hasOwn(OVERRIDES[file]?.off ?? {}, "cleanupIds");

      assert.equal(/\sid="/.test(read(file)), keeps, file);
    }
  });
});

describe("svg: none written by hand in templates", () => {
  it("finds an <svg> in a template or content, past comments", () => {
    const hits = inlineSvgs([
      { file: "layouts/a.html", text: "<p>\n  <svg viewBox=\"0 0 1 1\">" },
      { file: "layouts/b.html", text: "{{/* use <svg class=x> */}}\n<p>" },
      { file: "content/c.md", text: "x\n\n<SVG>" },
      { file: "assets/scripts/d.js", text: "<svg>" },
      { file: "layouts/partials/svg.html", text: "<svg>" },
    ]);

    assert.deepEqual(hits, [
      { file: "layouts/a.html", line: 2 },
      { file: "content/c.md", line: 3 },
    ]);
  });

  it("finds none in the project", () => {
    const files = execFileSync("git", ["ls-files", "layouts", "content"],
      { cwd: ROOT, encoding: "utf8" }).split("\n").filter(Boolean)
      .map((file) => ({ file, text: read(file) }));

    assert.deepEqual(inlineSvgs(files), []);
  });

  it("allows only files that exist, each with its reason", () => {
    for (const [file, why] of Object.entries(INLINE_ALLOWED)) {
      assert.match(read(file), /<svg[\s>]/, file);
      assert.ok(why.length > 20, file);
    }
  });

  const read = (file) => readFileSync(join(ROOT, file), "utf8");
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

  it("finds every tracked SVG already clean", () => {
    const dirty = run(trackedSvgs(), { check: true })
      .filter((r) => r.changed || r.blocked.length).map((r) => r.file);

    assert.deepEqual(dirty, []);
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
