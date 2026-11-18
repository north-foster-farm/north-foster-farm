// The Foster market's name as data/series.json gives it, for tests
// that check text built from the real series data. They expect the
// data's own spelling, so a change of spelling (#628) is the data's
// alone; test/foster-market.criteria.mjs pins which spelling it is.

import { readFileSync } from "node:fs";

const { series } = JSON.parse(readFileSync(
  new URL("../data/series.json", import.meta.url), "utf8"));

export const FOSTER_NAME = series.find((s) => s.code === "WAC5").name;

// The name as lib/pdf.mjs writes it in a PDF string: WinAnsi, a code
// above 126 as an octal escape (curly quotes are 0x91 to 0x94 there).
const WIN_ANSI = { "‘": 0x91, "’": 0x92, "“": 0x93,
  "”": 0x94 };

export const FOSTER_IN_PDF = [...FOSTER_NAME].map((ch) => {
  const code = WIN_ANSI[ch] ?? ch.codePointAt(0);

  return code > 126 ? `\\${code.toString(8).padStart(3, "0")}` : ch;
}).join("");
