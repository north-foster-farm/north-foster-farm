// Exclusions in the linters' configs, for check:exceptions (#782 step
// 3). An exclusion leaves source files out of a rule: an ignores entry
// that names files, or a block that sets rules for named files. Each
// needs a citation beside it, on its line or in the comment just above:
// #<issue> c<comment id>, its #791 entry or the ruling that set it.
// An ignored folder that holds no tracked script or stylesheet (build
// output, run output, untracked notes) leaves out no source and needs
// none. The JSON configs (.jscpd/) cannot hold a comment; their one
// exclusion is set out in .jscpd/README.md.
import { readFileSync } from "node:fs";
import { join } from "node:path";

const CONFIGS = ["eslint.config.js", "stylelint.config.js"];
const CITED = /#\d+ c\d+/;
const SOURCE = /\.(?:js|mjs|cjs|scss|css)$/;
const COMMENT = /^\s*(?:\/\/|\/\*|\*)/;

// The comment lines just above line i, through an opening brace.
const above = (lines, i) => {
  const out = [];
  let n = i - 1;
  if (n >= 0 && /^\s*[{(]?\s*$|\(\{\s*$/.test(lines[n])) n -= 1;
  for (; n >= 0 && COMMENT.test(lines[n]); n -= 1) out.push(lines[n]);
  return out;
};

const cited = (lines, i, more = []) =>
  [lines[i], ...more, ...above(lines, i)].some((l) => CITED.test(l));

// The string items of the array that opens on line i, with their lines.
const items = (lines, i) => {
  const found = [];
  for (let n = i; n < lines.length; n += 1) {
    const text = n === i ? lines[n].slice(lines[n].indexOf("[")) : lines[n];
    for (const m of text.matchAll(/"([^"]*)"|'([^']*)'/g)) {
      found.push({ "value": m[1] ?? m[2], "line": lines[n] });
    }
    if (lines[n].includes("]")) break;
  }
  return found;
};

const holdsSource = (folder, tracked) => {
  const prefix = folder.replace(/\*\*$/, "");
  return tracked.some((path) => path.startsWith(prefix) && SOURCE.test(path));
};

const leavesOut = (value, tracked) =>
  !/\/(?:\*\*)?$/.test(value) || holdsSource(value, tracked);

const ignoreFaults = (config, lines, tracked) => lines.flatMap((line, i) => {
  if (!/"?\bignore(?:s|Files)"?\s*:\s*\[/.test(line)) return [];
  return items(lines, i)
    .filter((item) => leavesOut(item.value, tracked))
    .filter((item) => !cited(lines, i, [item.line]))
    .map((item) => `${config}:${i + 1}: ignores ${item.value} with no ` +
      "citation beside it (#<issue> c<comment id>)");
});

// Whether the block whose "files" key is on line i sets rules.
const setsRules = (lines, i) => {
  const indent = lines[i].search(/\S/);
  for (let n = i + 1; n < lines.length; n += 1) {
    if (lines[n].trim() && lines[n].search(/\S/) < indent) return false;
    if (/"?\brules"?\s*:/.test(lines[n])) return true;
  }
  return false;
};

const blockFaults = (config, lines) => lines.flatMap((line, i) => {
  if (!/"?\bfiles"?\s*:/.test(line) || !setsRules(lines, i)) return [];
  if (cited(lines, i)) return [];
  return [`${config}:${i + 1}: a block sets rules for named files with ` +
    "no citation beside it (#<issue> c<comment id>)"];
});

export const configFaults = (root, tracked) => CONFIGS.flatMap((config) => {
  const lines = readFileSync(join(root, config), "utf8").split("\n");
  return [...ignoreFaults(config, lines, tracked),
    ...blockFaults(config, lines)];
});
