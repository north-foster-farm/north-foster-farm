// Words that must not part at a line break, for text the browser
// writes (#593). bin/orphans/wrap.mjs keeps the last two words of the
// built pages' prose together (#303), but never sees a line set from
// a script, so the scripts set those lines through setKept.
//
// The words stay apart by an ordinary space, and a span with the
// text-nowrap class keeps them on one line, as wrap.mjs does (#598).
// A no-break space (U+00A0) did the joining before, but Aller's has an
// advance of 0, which Chromium and Firefox draw as no width (WebKit
// draws a space's), so "Family Fitness" read "FamilyFitness".
// No no-break space, nor ICU's narrow one (U+202F), is ever written:
// copied text carries ordinary spaces too.

// The longest word wrap.mjs and keepTogether will join. A longer one
// kept beside its neighbor could run past a phone's screen.
export const MAX_WORD = 14;

// The class that keeps a pair on one line: Bootstrap's, which the
// built pages use, so PurgeCSS keeps it.
export const NOWRAP = "text-nowrap";

// HTML's whitespace, and the two no-break spaces (U+00A0, U+202F),
// which become ordinary ones.
const GAP = /[ \t\n\r\f]+/;
const NO_BREAK = new RegExp(`[${String.fromCharCode(0xa0, 0x202f)}]`, "g");

// A word never joined to its neighbor: a URL, an email address, or a
// word over MAX_WORD characters. wrap.mjs reads the same rule.
export const unsafeWord = (word) => /:\/\/|www\.|@/i.test(word)
  || [...word].length > MAX_WORD;

// A time and its half of the day: ("8:30", "AM") -> "8:30 AM", with an
// ordinary space. keepTogether keeps the two on one line.
export const meridiem = (time, half) => `${time} ${half}`;

// The same on text that is already written, such as what
// toLocaleString gives: the narrow no-break space (U+202F) newer ICU
// puts before AM or PM, or any other space there, becomes one ordinary
// space, as does any other no-break space.
export const spaceMeridiem = (text) => String(text)
  .replace(NO_BREAK, " ")
  .replace(/(\d)[ \t\n\r\f]+([AP]M)\b/g, "$1 $2");

// A word that ends in a digit, then AM or PM as a word of its own.
const isTime = (word) => /\d$/.test(word);
const isHalf = (word) => /^[AP]M(?![A-Za-z0-9_])/.test(word);

// The line as runs, in order, each { text, nowrap }: a run with nowrap
// must stay on one line. Every time is held to its AM or PM, even one
// that arrived formatted with a plain space ("10 AM – 12 PM, at the
// market"), and the last two words are held together by wrap.mjs's
// rule: a word is any run of non-whitespace, a time and its AM or PM
// count as one, and the pair is left apart when either word is unsafe
// (above) or there is only one. Spaces stay where they were, ordinary,
// and a gap inside a kept run becomes one space.
export const keepTogether = (text) => {
  const s = String(text ?? "").replace(NO_BREAK, " ");
  const tokens = s.split(new RegExp(`(${GAP.source})`));
  // The tokens alternate word, gap, word ... and start and end with a
  // word, which is empty where the text starts or ends with a gap.
  const words = tokens.filter((_, i) => i % 2 === 0);
  const glued = words.map((w, i) => i + 1 < words.length && w !== ""
    && isTime(w) && isHalf(words[i + 1]));

  // Units: words chained by a time's glue, as [first, last] indexes.
  const units = [];

  words.forEach((w, i) => {
    if (w === "") return;
    if (i > 0 && glued[i - 1]) units.at(-1)[1] = i;
    else units.push([i, i]);
  });

  if (units.length >= 2) {
    const unit = ([a, b]) => words.slice(a, b + 1).join(" ");
    const [before, last] = units.slice(-2);

    if (!unsafeWord(unit(before)) && !unsafeWord(unit(last))) {
      glued[before[1]] = true;
    }
  }

  const runs = [];
  const add = (piece, nowrap) => {
    const end = runs.at(-1);

    if (end && !end.nowrap && !nowrap) end.text += piece;
    else runs.push({ text: piece, nowrap });
  };
  let held = null;

  words.forEach((w, i) => {
    if (held !== null) held += ` ${w}`;
    else if (glued[i]) held = w;
    else add(w, false);

    if (held !== null && !glued[i]) {
      add(held, true);
      held = null;
    }
    if (i + 1 < words.length && !glued[i]) add(tokens[i * 2 + 1], false);
  });

  return runs.filter((r) => r.text !== "");
};

// Set a node's text from keepTogether's runs, each kept run in a span
// with the text-nowrap class. Built with DOM APIs, never innerHTML, so
// nothing in the text becomes markup.
export const setKept = (node, text) => {
  const doc = node.ownerDocument;

  node.textContent = "";
  for (const run of keepTogether(text)) {
    if (!run.nowrap) {
      node.append(run.text);
      continue;
    }

    const span = doc.createElement("span");

    span.className = NOWRAP;
    span.textContent = run.text;
    node.append(span);
  }
};
