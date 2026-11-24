// Helpers the #782 step 8 tests share (quality-analysis, -knip,
// -cycles and #991's -ceilings): moved here verbatim from the test
// agent's file so each test file holds only its own seeds and tests.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
export const tag = `zz-criteria-${process.pid}`;
export const camel = `zzCriteria${process.pid}`;

const seeds = [];
export const seed = (path, text) => {
  const abs = join(root, path);
  writeFileSync(abs, text);
  seeds.push(abs);
  return abs;
};

// The package.json file is edited for one seed (an unused dependency) and put
// back byte for byte.
export const packagePath = join(root, "package.json");
export const packageText = readFileSync(packagePath, "utf8");
export const unseed = () => {
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
export const toolScripts = (bins) => {
  const all = scripts();
  return [...reachedFromLint()].filter((name) => invokes(all[name], bins));
};

// Run every one of the tool's scripts; the gate holds when any fails.
export const runTool = (bins) => {
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
