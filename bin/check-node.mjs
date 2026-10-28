#!/usr/bin/env node
// Fails unless this Node is exactly the one .nvmrc pins (#504). It runs
// first in `npm run check` (so the pre-commit hook and CI) and in every
// Netlify build command, beside check:env. `.nvmrc` is the only pin:
// GitHub's workflows, Netlify and mise on James's Mac all read it.

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

// "24.22.1" from the file's text, "v24.22.1" or "24.22.1" alike.
export const pinOf = (text) => String(text).trim().replace(/^v/, "");

// -> null when this Node matches the pin, else the message to print.
export const mismatch = (pin, version = process.version) => {
  const want = pinOf(pin);
  const have = pinOf(version);

  if (!want) return ".nvmrc is empty: it must name one exact Node version.";
  if (have === want) return null;

  return `Node ${have} is running, but .nvmrc pins ${want}. In this repo `
    + "mise gives the pinned Node (see CLAUDE.md, Node); on Netlify and in "
    + "GitHub Actions it comes from .nvmrc.";
};

const main = () => {
  const pin = readFileSync(new URL("../.nvmrc", import.meta.url), "utf8");
  const problem = mismatch(pin);

  if (problem) {
    console.error(problem);
    process.exit(1);
  }
  console.log(`Node ${pinOf(process.version)} matches .nvmrc.`);
};

if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
