// Criteria tests for #991 (the duplication gate's seeded test fails
// pull requests that add clean tests), part of #782, written from the
// issue's words before any implementation exists.
//
// The issue splits the old test's two claims ("a seeded duplicate
// fails jscpd's ceiling, in every area", test/quality-analysis.test.mjs)
// into one test each, and keeps a third that holds today:
// 1. The gate works: a seed sized to the area's measured gap, so that
//    (D + d) / (L + 2d) > ceiling + 0.001, fails jscpd, and no amount
//    of clean lines added to the area changes that.
// 2. The ceiling stays honest: a ceiling more than 0.5 of a point
//    above the area's figure fails, naming the area, the figure and
//    the ceiling, and saying to lower it to the figure rounded up to
//    two places.
// 3. A ceiling set below the area's figure fails the jscpd script that
//    npm run lint reaches.
//
// Provisional: the 0.5 of a point is the analysis lane's
// recommendation, which the issue adopts as its proposal.
//
// D is an area's duplicated lines and L its total lines, read from the
// Total row of jscpd's console report. The seed writes d lines into
// each of two new files, so it adds 2d lines and d duplicated ones,
// as the issue's figures show (270 lines, 135 duplicated). Each area
// is the jscpd script that npm run lint reaches whose config is
// .jscpd/<area>.json, and its ceiling is that config's threshold.
// Seeds and config edits last one run and are put back after.
//
// Held out of runs as quality-ceilings.criteria.mjs until the
// implementer renames it to quality-ceilings.test.mjs. It runs jscpd
// many times, so like quality-analysis it belongs in test:analysis,
// not npm test.
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { root, tag, camel, seed, unseed, toolScripts } from
  "./quality-gate.mjs";

// The issue's margins, in points of a percent.
const PAST = 0.1;
const SLACK = 0.5;

// Per area: where the two duplicate copies and the clean file go, and a
// line of the area's language. `dup` lines repeat across the copies;
// `clean` lines are each unlike any other.
const hex = (i) => ((i + 1) * 2654435761 % 4294967296).toString(16);
const AREAS = {
  "source": {
    "copies": [`assets/scripts/${tag}-gap-a.js`,
      `netlify/functions/lib/${tag}-gap-b.mjs`],
    "clean": `bin/${tag}-clean.mjs`,
    "dup": (i) => `export const ${camel}Gap${i} = (row) => ` +
      `row.cell${i} * ${i + 3} - ${i};`,
    "fresh": (i) => `export const ${camel}Clean${i} = "${hex(i)}";`,
  },
  "tests": {
    "copies": [`test/${tag}-gap-a.mjs`, `e2e/support/${tag}-gap-b.mjs`],
    "clean": `test/${tag}-clean.mjs`,
    "dup": (i) => `export const ${camel}Gap${i} = (row) => ` +
      `row.cell${i} * ${i + 3} - ${i};`,
    "fresh": (i) => `export const ${camel}Clean${i} = "${hex(i)}";`,
  },
  "styles": {
    "copies": [`assets/styles/components/_${tag}-gap-a.scss`,
      `assets/styles/components/_${tag}-gap-b.scss`],
    "clean": `assets/styles/components/_${tag}-clean.scss`,
    "dup": (i) => `.zz-gap-${i} { margin: ${i + 1}px; ` +
      `border-width: ${i % 7}px; }`,
    "fresh": (i) => `.zz-clean-${hex(i)} { width: ${i}px; }`,
  },
  "templates": {
    "copies": [`layouts/partials/${tag}-gap-a.html`,
      `layouts/partials/${tag}-gap-b.html`],
    "clean": `layouts/partials/${tag}-clean.html`,
    "dup": (i) => `<span class="zz-gap-${i}">{{ .Title }} ${i + 1}</span>`,
    "fresh": (i) => `<i class="zz-clean-${hex(i)}">${i}</i>`,
  },
};

const scripts = () =>
  JSON.parse(readFileSync(join(root, "package.json"), "utf8")).scripts;

// The jscpd script lint reaches for an area, and the config it reads.
const areaScript = (area) => {
  const all = scripts();
  for (const name of toolScripts(["jscpd"])) {
    const config = all[name].match(/(?:-c|--config)[\s=]+(\S+)/)?.[1];
    if (config && config.endsWith(`/${area}.json`)) return { name, config };
  }
  return assert.fail(`no jscpd script npm run lint reaches reads ` +
    `.jscpd/${area}.json`);
};

const ceilingOf = (config) =>
  JSON.parse(readFileSync(join(root, config), "utf8")).threshold;

const ESC = String.fromCharCode(27);
const plain = (text) => text.replace(new RegExp(`${ESC}\\[[0-9;]*m`, "g"),
  "");

// Run the area's script once: its exit, and D and L from the Total row.
const measure = (area) => {
  const { name } = areaScript(area);
  const result = spawnSync("npm", ["run", "--silent", name], {
    "cwd": root,
    "encoding": "utf8",
    "env": { ...process.env, "npm_config_script_shell": "/bin/sh" },
    "maxBuffer": 64 * 1024 * 1024,
  });
  const out = plain(`${result.stdout}\n${result.stderr}`);
  const rows = out.split("\n").filter((row) => row.includes("│"))
    .map((row) => row.split("│").map((cell) => cell.trim()));
  const head = rows.find((row) => row.includes("Duplicated lines"));
  const total = rows.find((row) => row.some((c) => c.startsWith("Total:")));
  const log = `${name}: exit ${result.status}\n${out.slice(-3000)}`;
  assert.ok(head && total, `a Total row in jscpd's report\n${log}`);
  const lines = Number(total[head.indexOf("Total lines")]);
  const duplicated = parseInt(total[head.indexOf("Duplicated lines")], 10);
  assert.ok(lines > 0 && duplicated >= 0, `D and L read\n${log}`);
  return {
    "failed": result.status !== 0,
    lines,
    duplicated,
    "figure": 100 * duplicated / lines,
    log,
  };
};

// The seed the issue sizes: the least d, ten at least, with
// (D + d) / (L + 2d) > ceiling + 0.001.
const gapSeed = (ceiling, { duplicated, lines }) => {
  const target = (ceiling + PAST) / 100;
  let d = Math.max(10,
    Math.floor((target * lines - duplicated) / (1 - 2 * target)));
  while ((duplicated + d) / (lines + 2 * d) <= target) d += 1;
  return d;
};

const seedGap = (area, d) => {
  const block = Array.from({ "length": d }, (_, i) => AREAS[area].dup(i));
  for (const path of AREAS[area].copies) seed(path, `${block.join("\n")}\n`);
};

const seedClean = (area, count) => {
  const block = Array.from({ "length": count },
    (_, i) => AREAS[area].fresh(i));
  seed(AREAS[area].clean, `${block.join("\n")}\n`);
};

const up2 = (figure) => Math.ceil(figure * 100 - 1e-9) / 100;
const pct = (n) => `${n.toFixed(3)}%`;

// The honesty check's verdict for one area: null, or what to do.
const tooHigh = (area, figure, ceiling) => figure + SLACK < ceiling
  ? `${area}: ceiling ${ceiling}% sits more than ${SLACK} of a point ` +
    `above the measured figure ${pct(figure)}; lower the ceiling to ` +
    `${up2(figure)}%, the figure rounded up to two places`
  : null;

// Config files edited for one run are put back byte for byte.
const edited = new Map();
const restore = () => {
  for (const [abs, text] of edited) writeFileSync(abs, text);
  edited.clear();
};
process.on("exit", restore);

describe("#991: the duplication gate's two claims", () => {
  it("the gate works: for every area, a seed sized to the measured " +
    "gap fails jscpd", () => {
    const missed = [];
    for (const area of Object.keys(AREAS)) {
      const ceiling = ceilingOf(areaScript(area).config);
      try {
        const before = measure(area);
        assert.ok(!before.failed,
          `${area} passes jscpd before any seed\n${before.log}`);

        // Sized to today's gap.
        const d = gapSeed(ceiling, before);
        seedGap(area, d);
        const seeded = measure(area);
        unseed();
        if (!seeded.failed || seeded.figure <= ceiling + PAST) {
          missed.push(`${area}: seed of ${d} lines, figure ` +
            `${pct(before.figure)} -> ${pct(seeded.figure)}, ceiling ` +
            `${ceiling}%\n${seeded.log}`);
        }

        // Clean lines first pull the figure down, as drift does; the
        // seed, sized to the new gap, still fails. A tenth more lines
        // is far past the 53 that beat the old seed in the tests area.
        seedClean(area, Math.max(200, Math.ceil(before.lines / 10)));
        const drifted = measure(area);
        assert.ok(!drifted.failed && drifted.figure < before.figure,
          `${area}: clean lines lower the figure and pass\n` +
          `${drifted.log}`);
        const later = gapSeed(ceiling, drifted);
        seedGap(area, later);
        const reseeded = measure(area);
        if (!reseeded.failed || reseeded.figure <= ceiling + PAST) {
          missed.push(`${area} after clean lines: seed of ${later} ` +
            `lines, figure ${pct(drifted.figure)} -> ` +
            `${pct(reseeded.figure)}, ceiling ${ceiling}%\n` +
            `${reseeded.log}`);
        }
      } finally {
        unseed();
      }
    }
    assert.deepEqual(missed, [],
      "areas where a seed sized to the gap does not fail jscpd");
  });

  it("the ceiling stays honest: no area's ceiling sits more than 0.5 " +
    "of a point above its measured figure", () => {
    // The check itself, on a ceiling left too high and one in reach.
    const said = tooHigh("tests", 3.2512, 3.85);
    for (const part of ["tests", "3.251%", "3.85%", "lower the ceiling",
      "3.26%", "rounded up to two places"]) {
      assert.ok(said?.includes(part), `the message says ${part}: ${said}`);
    }
    assert.equal(tooHigh("tests", 3.7557, 3.85), null);

    const stale = [];
    for (const area of Object.keys(AREAS)) {
      const ceiling = ceilingOf(areaScript(area).config);
      const now = measure(area);
      assert.ok(!now.failed, `${area} passes jscpd\n${now.log}`);
      const verdict = tooHigh(area, now.figure, ceiling);
      if (verdict) stale.push(verdict);
    }
    assert.deepEqual(stale, [], "ceilings to lower");
  });

  it("a ceiling set below the area's measured figure still fails " +
    "npm run lint", () => {
    const passed = [];
    for (const area of Object.keys(AREAS)) {
      const { config } = areaScript(area);
      const abs = join(root, config);
      const text = readFileSync(abs, "utf8");
      const now = measure(area);
      const below = Math.floor((now.figure - 0.01) * 100) / 100;
      assert.ok(below >= 0 && below < now.figure,
        `${area}: a ceiling below ${pct(now.figure)}`);
      edited.set(abs, text);
      let run;
      try {
        writeFileSync(abs, JSON.stringify(
          { ...JSON.parse(text), "threshold": below }, null, 2));
        run = measure(area);
      } finally {
        restore();
      }
      if (!run.failed) {
        passed.push(`${area}: ceiling ${below}% under figure ` +
          `${pct(now.figure)}\n${run.log}`);
      }
    }
    assert.deepEqual(passed, [],
      "areas whose jscpd passes with a ceiling below the figure");
  });
});

after(() => {
  unseed();
  restore();
});
