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
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const tag = `zz-criteria-${process.pid}`;

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

const CRUISER = ["depcruise", "dependency-cruiser", "dependency-cruise"];

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
