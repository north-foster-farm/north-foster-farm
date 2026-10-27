// `bin/nff env filled [--development|--staging|--production]`: does the
// real env file fill in every key its sample lists? It is the quick look
// before `env check`, which compares the file with Netlify too and needs
// the token. This reads the tracked sample and the ignored env file and
// nothing else, so it works offline, and it prints key NAMES and the
// sample's own comments on them, never a value.
//
// A key the file lacks or leaves empty is a problem, unless the sample
// marks it `Optional:` in its comment: an optional key may be left
// empty, or out of the file altogether. Keys marked `Local only:` are
// held to the same rule, since the file is where they live.
//
// `--append` adds the missing keys to the file as `KEY=`, each under
// its sample comment, and never writes a value (appendMissing).

import { appendFileSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  ENVIRONMENTS, parseSample, readValues, sampleFile,
} from "./sample.mjs";

// A parsed sample and an env file's values (a Map) -> { total, filled,
// missing, empty, optional }: the names the file lacks, the names it
// leaves empty, and the optional ones it leaves unset, which are no
// problem. Names only: no value is carried into the answer.
export const unfilled = (parsed, values) => {
  const answer = {
    total: parsed.entries.length, filled: 0,
    missing: [], empty: [], optional: [],
  };

  for (const entry of parsed.entries) {
    const value = values.get(entry.name);

    if (value) {
      answer.filled += 1;
    } else if (entry.optional) {
      answer.optional.push(entry.name);
    } else if (value === undefined) {
      answer.missing.push(entry.name);
    } else {
      answer.empty.push(entry.name);
    }
  }

  return answer;
};

// One environment's sample and env file under `root`. -> { env, file,
// summary, problems } with the problems as lines naming keys and line
// numbers. A missing file throws, naming it.
export const checkFilled = (root, env, {
  read = (path) => readFileSync(path, "utf8"),
} = {}) => {
  if (!ENVIRONMENTS.includes(env)) {
    throw new Error(`Say one of: ${ENVIRONMENTS.join(", ")}.`);
  }

  const file = `.env.${env}`;
  const sample = sampleFile(env);
  const text = (name) => {
    try {
      return read(join(root, name));
    } catch {
      throw new Error(`No ${name} in ${root}.`);
    }
  };
  const parsed = parseSample(text(sample));
  const local = readValues(text(file));
  const found = unfilled(parsed, local.values);
  const layout = [
    ...parsed.errors.map((e) => `Sample ${sample}: ${e}`),
    ...local.errors.map((e) => `${file}: ${e}`),
  ];
  const problems = [
    ...layout,
    ...found.missing.map((n) => `${n}: not in ${file}.`),
    ...found.empty.map((n) => `${n}: empty in ${file}.`),
  ];
  const left = found.optional.length
    ? ` Optional and left empty: ${found.optional.join(", ")}.` : "";
  const said = new Map(parsed.entries.map((e) => [e.name, e.purpose]));
  const section = (title, names) => (names.length ? [
    `${title} (${names.length}):`,
    ...names.flatMap((name) => [`  ${name}`,
      ...(said.get(name) || []).map((line) => (line ? `      ${line}` : ""))]),
    "",
  ] : []);

  return {
    env, file, problems, ...found,
    // The whole answer, for a person: the layout slips, then every
    // missing key and every empty one with the sample's own comment on
    // what it is. Names and comments only.
    report: [
      ...layout,
      ...section(`Missing from ${file}`, found.missing),
      ...section(`Empty in ${file}`, found.empty),
    ],
    summary: `${file} fills ${found.filled} of the ${found.total} keys in ${
      sample}.${left}`,
  };
};

// The text `--append` adds: a dated header, then each key's own
// comment from the sample and the key with no value. Never a value, and
// no line ends in a space.
export const missingBlock = (parsed, names, date) => {
  const said = new Map(parsed.entries.map((e) => [e.name, e.purpose]));
  const lines = [`# Added by bin/nff env filled --append, ${date}`];

  for (const name of names) {
    lines.push("", `# ${name}`,
      ...(said.get(name) || []).map((line) => (line ? `# ${line}` : "#")),
      `${name}=`);
  }

  return `${lines.join("\n")}\n`;
};

// "2026-10-26", the day on the machine running it.
const dayOf = (date) => date.toLocaleDateString("en-CA");

// Adds every key the file is MISSING (not the empty ones, which are
// there already, and not the optional ones, which need not be) to the
// end of the env file as `KEY=`, each under its sample comment and a
// dated header. It only appends: no existing byte is changed, and a
// file that is a symbolic link is refused, so it can never write
// through `.env` to somewhere else. -> { file, appended: [names] }.
export const appendMissing = (root, env, { now = new Date() } = {}) => {
  const found = checkFilled(root, env);

  if (!found.missing.length) return { file: found.file, appended: [] };

  const path = join(root, found.file);

  if (lstatSync(path).isSymbolicLink()) {
    throw new Error(`${found.file} is a symbolic link: name the file it `
      + "points to, and nothing was written.");
  }

  const text = readFileSync(path, "utf8");
  const parsed = parseSample(readFileSync(join(root, sampleFile(env)), "utf8"));
  // A blank line between what was there and the header.
  const lead = !text ? "" : text.endsWith("\n") ? "\n" : "\n\n";

  appendFileSync(path, lead + missingBlock(parsed, found.missing, dayOf(now)));

  return { file: found.file, appended: found.missing };
};
