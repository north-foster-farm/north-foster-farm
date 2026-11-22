// Criteria tests for #782 (quality gates in the build for new and
// changed code), step 8 of the proposal (issuecomment-7075114694),
// written before the implementation: "Knip, jscpd, dependency-cruiser".
//
// The proposal's settings (section 1):
// - Unused code: Knip, "Whole repository, after one cleanup", over
//   unused files, exports and dependencies.
// - Duplication: jscpd, "A ceiling per area at today's figure, which
//   can only fall", the areas being source, tests, styles and
//   templates.
// - Imports: dependency-cruiser, "Cycles, and which folders may import
//   which".
// And section 2: "Every new gate goes inside npm run lint".
//
// Each test checks the gate, not the fix. None of the three is
// installed on next, so nothing here imports them: the tests find the
// npm scripts that npm run lint reaches that run each tool, run them,
// and read their exit and output. Seeds are written beside the code
// for one run and removed after. Held out of runs as
// quality-analysis.criteria.mjs until the implementer renames it to
// quality-analysis.test.mjs.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const tag = `zz-criteria-${process.pid}`;
const camel = `zzCriteria${process.pid}`;

const tracked = () => execFileSync("git", ["ls-files", "-z"], {
  "cwd": root, "encoding": "utf8",
}).split("\0").filter((f) => f && existsSync(join(root, f)));

const seeds = [];
const seed = (path, text) => {
  const abs = join(root, path);
  writeFileSync(abs, text);
  seeds.push(abs);
  return abs;
};

// The package.json file is edited for one seed (an unused dependency) and put
// back byte for byte.
const packagePath = join(root, "package.json");
const packageText = readFileSync(packagePath, "utf8");
const unseed = () => {
  for (const abs of seeds.splice(0)) rmSync(abs, { "force": true });
  if (readFileSync(packagePath, "utf8") !== packageText) {
    writeFileSync(packagePath, packageText);
  }
};
process.on("exit", unseed);

// Run an npm script the way the hook and CI do. The script shell is
// plain sh so a nested run is not recorded as one of the Mac's own.
const npm = (args) => spawnSync("npm", args, {
  "cwd": root,
  "encoding": "utf8",
  "env": { ...process.env, "npm_config_script_shell": "/bin/sh" },
  "maxBuffer": 64 * 1024 * 1024,
});

const ran = (result) =>
  `exit ${result.status}\n${result.stdout}\n${result.stderr}`.slice(-4000);

const scripts = () => JSON.parse(packageText).scripts ?? {};

// The scripts `npm run lint` runs: lint itself and every script it
// reaches through `npm run NAME`.
const reachedFromLint = () => {
  const all = scripts();
  const seen = new Set();
  const todo = ["lint"];
  while (todo.length) {
    const name = todo.pop();
    if (seen.has(name) || !(name in all)) continue;
    seen.add(name);
    const calls = all[name].matchAll(
      /npm\s+run(?:-script)?\s+(?:--?[\w-]+\s+)*([\w:.-]+)/g);
    for (const [, called] of calls) todo.push(called);
  }
  return seen;
};

const invokes = (command, bins) => bins.some((bin) =>
  new RegExp(`(^|[\\s;&|(])(npx\\s+)?${bin}(\\s|$)`).test(command));

// The scripts lint reaches that run one of the tool's commands.
const toolScripts = (bins) => {
  const all = scripts();
  return [...reachedFromLint()].filter((name) => invokes(all[name], bins));
};

// Run every one of the tool's scripts; the gate holds when any fails.
const runTool = (bins) => {
  const names = toolScripts(bins);
  assert.ok(names.length > 0,
    `a script npm run lint reaches runs ${bins.join(" or ")}`);
  const runs = names.map((name) =>
    ({ name, "result": npm(["run", "--silent", name]) }));
  return {
    "failed": runs.some((r) => r.result.status !== 0),
    "said": runs.map((r) => `${r.result.stdout}\n${r.result.stderr}`)
      .join("\n"),
    "log": runs.map((r) => `${r.name}: ${ran(r.result)}`).join("\n"),
  };
};

const KNIP = ["knip"];
const JSCPD = ["jscpd"];
const CRUISER = ["depcruise", "dependency-cruiser", "dependency-cruise"];

// Knip: an export no one imports, in a page script, a server library
// and an e2e support module, each imported by a file Knip starts from
// (a unit test or a spec); a file nothing imports; and a devDependency
// nothing uses. No test helper: Knip's node test runner plugin starts
// from every file in test/, and it never reports an entry's exports.
const unusedExport = (area) => `${camel}Unused${area}`;
const usedExport = (area) => `${camel}Used${area}`;
const exportsModule = (area) =>
  `export const ${usedExport(area)} = 1;\n` +
  `export const ${unusedExport(area)} = 2;\n`;
const KNIP_AREAS = {
  "Page": `assets/scripts/${tag}-knip.js`,
  "Server": `netlify/functions/lib/${tag}-knip.mjs`,
  "Support": `e2e/support/${tag}-knip.mjs`,
};
const KNIP_TEST = `test/${tag}-knip.test.mjs`;
const KNIP_SPEC = `e2e/${tag}-knip.spec.mjs`;
const KNIP_ORPHAN = `netlify/functions/lib/${tag}-orphan.mjs`;
const KNIP_DEPENDENCY = `${tag}-unused-dependency`;

const seedKnip = () => {
  for (const [area, path] of Object.entries(KNIP_AREAS)) {
    seed(path, exportsModule(area));
  }
  const from = (area, dir) => {
    const path = KNIP_AREAS[area];
    const rel = path.startsWith(`${dir}/`)
      ? `./${path.slice(dir.length + 1)}`
      : `../${path}`;
    return `import { ${usedExport(area)} } from "${rel}";\n`;
  };
  const imports = ["Page", "Server"]
    .map((area) => from(area, "test")).join("");
  const used = ["Page", "Server"].map(usedExport).join(", ");
  seed(KNIP_TEST, `import { it } from "node:test";\n${imports}\n` +
    `it("zz criteria seed", () => [${used}]);\n`);
  seed(KNIP_SPEC, `import { test } from "@playwright/test";\n` +
    `${from("Support", "e2e")}\n` +
    `test("zz criteria seed", () => ${usedExport("Support")});\n`);
  seed(KNIP_ORPHAN, `export const ${camel}Orphan = 1;\n`);
  const pkg = JSON.parse(packageText);
  pkg.devDependencies = { ...pkg.devDependencies,
    [KNIP_DEPENDENCY]: "1.0.0" };
  writeFileSync(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);
};

// For jscpd, the areas the proposal measured, by folder and kind, with
// the lines each holds today.
const AREAS = {
  "source": {
    "folders": /^(assets\/scripts|netlify|bin|plugins)\//,
    "kinds": /\.(js|mjs|cjs)$/,
    "copies": [`assets/scripts/${tag}-dup-a.js`,
      `netlify/functions/lib/${tag}-dup-b.mjs`],
    "line": (i) => `export const ${camel}Dup${i} = (value) => ` +
      `value.field${i} + ${i} * 2;`,
  },
  "tests": {
    "folders": /^(test|e2e)\//,
    "kinds": /\.(js|mjs|cjs)$/,
    "copies": [`test/${tag}-dup-a.mjs`, `e2e/support/${tag}-dup-b.mjs`],
    "line": (i) => `export const ${camel}Dup${i} = (value) => ` +
      `value.field${i} + ${i} * 2;`,
  },
  "styles": {
    "folders": /^assets\/styles\//,
    "kinds": /\.(scss|css)$/,
    "copies": [`assets/styles/components/_${tag}-dup-a.scss`,
      `assets/styles/components/_${tag}-dup-b.scss`],
    "line": (i) => `.zz-criteria-dup-${i} { margin: ${i}px; ` +
      `padding: ${i * 2}px; }`,
  },
  "templates": {
    "folders": /^layouts\//,
    "kinds": /\.html$/,
    "copies": [`layouts/partials/${tag}-dup-a.html`,
      `layouts/partials/${tag}-dup-b.html`],
    "line": (i) => `<p class="zz-criteria-dup-${i}">{{ .Title }} ` +
      `${i}</p>`,
  },
};

const areaLines = (area) => tracked()
  .filter((f) => area.folders.test(f) && area.kinds.test(f))
  .reduce((sum, f) =>
    sum + readFileSync(join(root, f), "utf8").split("\n").length, 0);

// A block, copied into two new files of the area, of a tenth of a
// percent of the area's lines (at least ten): enough to cross a
// ceiling set at today's figure.
const seedDuplicate = (area) => {
  const count = Math.max(10, Math.ceil(areaLines(area) / 1000));
  const block = Array.from({ "length": count }, (_, i) => area.line(i));
  for (const path of area.copies) seed(path, `${block.join("\n")}\n`);
};

// For dependency-cruiser, two modules that import each other, in the page
// scripts and in the server's libraries.
const CYCLES = {
  "page": [`assets/scripts/${tag}-cycle-a.js`,
    `assets/scripts/${tag}-cycle-b.js`],
  "server": [`netlify/functions/lib/${tag}-cycle-a.mjs`,
    `netlify/functions/lib/${tag}-cycle-b.mjs`],
};
const seedCycles = () => {
  for (const [a, b] of Object.values(CYCLES)) {
    const name = (path) => path.split("/").pop();
    seed(a, `import { b } from "./${name(b)}";\nexport const a = () => b;\n`);
    seed(b, `import { a } from "./${name(a)}";\nexport const b = () => a;\n`);
  }
};

describe("#782 step 8: Knip", () => {
  let knip;

  before(() => {
    if (!toolScripts(KNIP).length) return;
    seedKnip();
    try {
      knip = runTool(KNIP);
    } finally {
      unseed();
    }
  });

  it("Knip runs in npm run lint", () => {
    assert.notDeepEqual(toolScripts(KNIP), [],
      "no script that npm run lint reaches runs knip");
  });

  it("a seeded unused export fails Knip, in every area", () => {
    assert.ok(knip, "Knip ran");
    assert.ok(knip.failed, `Knip fails\n${knip.log}`);
    const unnamed = Object.keys(KNIP_AREAS).map(unusedExport)
      .filter((name) => !knip.said.includes(name));
    assert.deepEqual(unnamed, [],
      `seeded unused exports Knip does not report\n${knip.log}`);
  });

  it("a seeded unused file fails Knip", () => {
    assert.ok(knip, "Knip ran");
    assert.ok(knip.failed, `Knip fails\n${knip.log}`);
    assert.ok(knip.said.includes(KNIP_ORPHAN),
      `Knip reports the seeded unused file\n${knip.log}`);
  });

  it("a seeded unused dependency fails Knip", () => {
    assert.ok(knip, "Knip ran");
    assert.ok(knip.failed, `Knip fails\n${knip.log}`);
    assert.ok(knip.said.includes(KNIP_DEPENDENCY),
      `Knip reports the seeded unused devDependency\n${knip.log}`);
  });
});

describe("#782 step 8: jscpd", () => {
  it("jscpd runs in npm run lint", () => {
    assert.notDeepEqual(toolScripts(JSCPD), [],
      "no script that npm run lint reaches runs jscpd");
  });

  it("a seeded duplicate fails jscpd's ceiling, in every area", () => {
    const clean = runTool(JSCPD);
    assert.ok(!clean.failed,
      `jscpd passes before any seed, under today's ceilings\n${clean.log}`);
    const passed = [];
    for (const [name, area] of Object.entries(AREAS)) {
      seedDuplicate(area);
      let run;
      try {
        run = runTool(JSCPD);
      } finally {
        unseed();
      }
      if (!run.failed) passed.push(`${name}\n${run.log}`);
    }
    assert.deepEqual(passed, [],
      "areas where a seeded duplicate does not fail jscpd");
  });
});

describe("#782 step 8: dependency-cruiser", () => {
  it("dependency-cruiser runs in npm run lint", () => {
    assert.notDeepEqual(toolScripts(CRUISER), [],
      "no script that npm run lint reaches runs dependency-cruiser");
  });

  it("a seeded import cycle fails dependency-cruiser, in page and " +
    "server code", () => {
    seedCycles();
    let run;
    try {
      run = runTool(CRUISER);
    } finally {
      unseed();
    }
    assert.ok(run.failed, `dependency-cruiser fails\n${run.log}`);
    const unnamed = Object.values(CYCLES).flat()
      .filter((path) => !run.said.includes(path));
    assert.deepEqual(unnamed, [],
      `seeded cycle files dependency-cruiser does not report\n${run.log}`);
  });
});

after(unseed);
