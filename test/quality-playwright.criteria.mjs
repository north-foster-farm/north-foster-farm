// Criteria tests for #782 (quality gates in the build for new and
// changed code), step 6 of the proposal (issuecomment-7075114694),
// written before the implementation: "The Playwright plugin and the
// e2e/support/ rule".
//
// The proposal's setting (section 1, "e2e specs"): "Its recommended
// set on e2e/, with the custom rule from #786 (the tools approved on
// Nov 19) that specs reach the page only through e2e/support/". #786:
// "Custom ESLint rules kept in this repo (no package), starting with:
// specs reach the page only through e2e/support/", and the plugin
// "banning one-shot reads and raw page calls in specs". Section 2:
// "Every new gate goes inside npm run lint".
//
// Each test checks the gate, not the fix. The plugin is not installed
// on next, so nothing here imports it: ESLint loads it through the
// repository's own config. Seeds are written beside the code for one
// run and removed after. Held out of runs as
// quality-playwright.criteria.mjs until the implementer renames it to
// quality-playwright.test.mjs.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync }
  from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const tag = `zz-criteria-${process.pid}`;

// eslint-plugin-playwright 2.12.2's recommended rules (its
// configs["flat/recommended"], read from a scratch install on
// 2026-11-22). The proposal sets them on e2e/; a gate is an error,
// so the ones the plugin ships as warnings are errors here too.
const RECOMMENDED = [
  "consistent-spacing-between-blocks",
  "expect-expect",
  "max-nested-describe",
  "missing-playwright-await",
  "no-conditional-expect",
  "no-conditional-in-test",
  "no-duplicate-hooks",
  "no-duplicate-slow",
  "no-element-handle",
  "no-eval",
  "no-focused-test",
  "no-force-option",
  "no-identical-title",
  "no-nested-step",
  "no-networkidle",
  "no-page-pause",
  "no-skipped-test",
  "no-standalone-expect",
  "no-unnecessary-assertions",
  "no-unsafe-references",
  "no-unused-locators",
  "no-useless-await",
  "no-useless-not",
  "no-wait-for-navigation",
  "no-wait-for-selector",
  "no-wait-for-timeout",
  "prefer-hooks-in-order",
  "prefer-hooks-on-top",
  "prefer-locator",
  "prefer-to-have-count",
  "prefer-to-have-length",
  "prefer-web-first-assertions",
  "valid-describe-callback",
  "valid-expect",
  "valid-expect-in-promise",
  "valid-test-tags",
  "valid-title",
].map((name) => `playwright/${name}`);

// A spec that reaches the page itself: a one-shot read (line 4) and a
// raw page call (line 5), and a fixed wait (line 7), which the plugin
// ships as a warning.
const RAW_SPEC = `import { expect, test } from "@playwright/test";

test("zz criteria seed reads the page itself", async ({ page }) => {
  const heading = await page.locator("h1").textContent();
  const title = await page.evaluate(() => document.title);
  expect(heading).toBe(title);
  await page.waitForTimeout(10);
});
`;
const ONE_SHOT_LINE = 4;
const RAW_CALL_LINE = 5;

// The same reads, kept in e2e/support/, and a spec that reaches the
// page only through them.
const SUPPORT = `export const heading = (page) =>
  page.locator("h1").textContent();

export const title = (page) => page.evaluate(() => document.title);
`;
const CLEAN_SPEC = (support) => `import { expect, test } from \
"@playwright/test";
import { heading, title } from "./support/${support}";

test("zz criteria seed reads through support", async ({ page }) => {
  expect(await heading(page)).toBe(await title(page));
});
`;

const tracked = () => execFileSync("git", ["ls-files", "-z"], {
  "cwd": root, "encoding": "utf8",
}).split("\0").filter((f) => f && existsSync(join(root, f)));

const e2eScripts = () => tracked()
  .filter((f) => /^e2e\/.*\.(js|mjs|cjs)$/.test(f));

// Files the whole-file frame of step 3 lists as not yet brought up to
// this gate (quality/legacy/<gate>.txt, one path per line, with an
// optional "# stall ..." marker). Only a list for this gate counts.
const legacy = () => {
  const dir = join(root, "quality/legacy");
  if (!existsSync(dir)) return new Set();
  const listed = new Set();
  for (const name of readdirSync(dir)) {
    if (!/playwright|e2e/.test(name) || !name.endsWith(".txt")) continue;
    for (const line of readFileSync(join(dir, name), "utf8").split("\n")) {
      const path = line.replace(/#.*/, "").trim();
      if (path) listed.add(path);
    }
  }
  return listed;
};

const seeds = [];
const seed = (path, text) => {
  const abs = join(root, path);
  writeFileSync(abs, text);
  seeds.push(abs);
  return abs;
};
const unseed = () => {
  for (const abs of seeds.splice(0)) rmSync(abs, { "force": true });
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

const severity = (value) => {
  const level = Array.isArray(value) ? value[0] : value;
  return { "off": 0, "warn": 1, "error": 2 }[level] ?? level ?? 0;
};

const seedAll = () => {
  const support = `${tag}.mjs`;
  return {
    "raw": seed(`e2e/${tag}.spec.mjs`, RAW_SPEC),
    "support": seed(`e2e/support/${support}`, SUPPORT),
    "clean": seed(`e2e/${tag}-clean.spec.mjs`, CLEAN_SPEC(support)),
  };
};

// The rules, outside the plugin, that report the seeded spec's
// one-shot read and raw page call: the e2e/support/ rule.
const boundaryRules = (messages) => {
  const on = (line) => new Set(messages
    .filter((m) => m.line === line && m.severity === 2 && m.ruleId &&
      !m.ruleId.startsWith("playwright/"))
    .map((m) => m.ruleId));
  const read = on(ONE_SHOT_LINE);
  return [...on(RAW_CALL_LINE)].filter((id) => read.has(id));
};

describe("#782 step 6: the Playwright plugin and the e2e/support/ rule",
  () => {
    let lint;

    before(async () => {
      const files = seedAll();
      try {
        const eslint = new ESLint({ "cwd": root });
        const results = await eslint.lintFiles(Object.values(files));
        const of = (abs) =>
          results.find((r) => r.filePath === abs)?.messages ?? [];
        lint = Object.fromEntries(Object.entries(files)
          .map(([key, abs]) => [key, of(abs)]));
      } finally {
        unseed();
      }
    });

    it("the plugin's recommended rules are errors for every e2e file",
      async () => {
        const eslint = new ESLint({ "cwd": root });
        const held = legacy();
        const misses = [];
        for (const file of e2eScripts()) {
          if (held.has(file)) continue;
          const config =
            await eslint.calculateConfigForFile(join(root, file));
          const off = RECOMMENDED
            .filter((name) => severity(config?.rules?.[name]) !== 2);
          if (off.length) misses.push(`${file}: ${off.length} not errors`);
        }
        assert.deepEqual(misses.slice(0, 20), [],
          `e2e files where a recommended rule is not an error ` +
          `(${misses.length})`);
        const wait = lint.raw.find((m) =>
          m.ruleId === "playwright/no-wait-for-timeout");
        assert.equal(wait?.severity, 2,
          "the seeded fixed wait, a warning in the plugin, is an error");
      });

    it("specs reach the page only through e2e/support/", () => {
      const rules = boundaryRules(lint.raw);
      const seen = JSON.stringify(lint.raw, null, 1).slice(0, 3000);
      assert.notDeepEqual(rules, [], "a rule outside the plugin reports " +
        "the seeded spec's one-shot read and raw page call as errors\n" +
        `${seen}`);
      for (const key of ["support", "clean"]) {
        const hits = lint[key].filter((m) => rules.includes(m.ruleId));
        assert.deepEqual(hits, [], `the rule reports nothing in the ${key} ` +
          "seed, which reaches the page through e2e/support/");
      }
    });

    it("a seeded violation of each fails npm run lint", () => {
      seedAll();
      let run;
      try {
        run = npm(["run", "--silent", "lint"]);
      } finally {
        unseed();
      }
      const said = `${run.stdout}${run.stderr}`;
      assert.notEqual(run.status, 0, `the run fails\n${ran(run)}`);
      assert.match(said, new RegExp(`${tag}\\.spec\\.mjs`),
        `the run names the seeded spec\n${ran(run)}`);
      assert.match(said, /playwright\/no-wait-for-timeout/,
        `the run reports the plugin's rule\n${ran(run)}`);
      const rules = boundaryRules(lint.raw);
      assert.ok(rules.some((id) => said.includes(id)),
        `the run reports the e2e/support/ rule\n${ran(run)}`);
    });
  });

after(unseed);
