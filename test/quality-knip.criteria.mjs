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
import { spawnSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const tag = `zz-criteria-${process.pid}`;
const camel = `zzCriteria${process.pid}`;

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

after(unseed);
