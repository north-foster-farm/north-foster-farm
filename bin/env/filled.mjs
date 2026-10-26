// `bin/nff env filled [--development|--staging|--production]`: does the
// real env file fill in every key its sample lists? It is the quick look
// before `env check`, which compares the file with Netlify too and needs
// the token. This reads the tracked sample and the ignored env file and
// nothing else, so it works offline, and it prints key NAMES only,
// never a value.
//
// A key the file lacks or leaves empty is a problem, unless the sample
// marks it `Optional:` in its comment: an optional key may be left
// empty, or out of the file altogether. Keys marked `Local only:` are
// held to the same rule, since the file is where they live.

import { readFileSync } from "node:fs";
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
  const problems = [
    ...parsed.errors.map((e) => `Sample ${sample}: ${e}`),
    ...local.errors.map((e) => `${file}: ${e}`),
    ...found.missing.map((n) => `${n}: not in ${file}.`),
    ...found.empty.map((n) => `${n}: empty in ${file}.`),
  ];
  const left = found.optional.length
    ? ` Optional and left empty: ${found.optional.join(", ")}.` : "";

  return {
    env, file, problems, ...found,
    summary: `${file} fills ${found.filled} of the ${found.total} keys in ${
      sample}.${left}`,
  };
};
