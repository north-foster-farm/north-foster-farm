// Words that must not part at a line break, for text the browser
// writes (#593). bin/orphans/wrap.mjs keeps the last two words of the
// built pages' prose together (#303), but never sees a line set from
// a script, so the scripts call these where they set the text.
//
// A no-break space (U+00A0) does the joining: it is not one of HTML's
// whitespace characters, so a line never breaks at one, and the words
// either side read as one word to wrap.mjs and to keepLastTwo.

export const NBSP = "\u00a0";

// The longest word wrap.mjs and keepLastTwo will join. A longer one
// kept beside its neighbor could run past a phone's screen.
export const MAX_WORD = 14;

// HTML's whitespace, which leaves out the no-break space.
const SPACE = /[ \t\n\r\f]/;
const isSpace = (c) => SPACE.test(c);

// A word never joined to its neighbor: a URL, an email address, or a
// word over MAX_WORD characters. wrap.mjs reads the same rule.
export const unsafeWord = (word) => /:\/\/|www\.|@/i.test(word)
  || [...word].length > MAX_WORD;

// A time and its half of the day: ("8:30", "AM") -> "8:30 AM", with a
// no-break space, so "AM" never starts a line alone.
export const meridiem = (time, half) => `${time}${NBSP}${half}`;

// The same join on text that is already written, such as what
// toLocaleString gives: "11:59 PM", with an ASCII space, or the narrow
// no-break space (U+202F) newer ICU puts there, takes a no-break space.
export const joinMeridiem = (text) => String(text)
  .replace(/(\d)[ \t\n\r\f\u202f]+([AP]M)\b/g, `$1${NBSP}$2`);

// The text with its last two words joined by a no-break space, by
// wrap.mjs's rule: a word is any run of non-whitespace, and nothing
// changes when either word is unsafe (above) or there is only one.
// "Sunday, November 22, 8:30 AM" keeps "22, 8:30 AM" on one line when
// its time came from meridiem.
export const keepLastTwo = (text) => {
  const s = String(text ?? "");
  let end = s.length;

  while (end > 0 && isSpace(s[end - 1])) end--;

  let second = end;

  while (second > 0 && !isSpace(s[second - 1])) second--;

  let gap = second;

  while (gap > 0 && isSpace(s[gap - 1])) gap--;
  if (gap === 0) return s;

  let first = gap;

  while (first > 0 && !isSpace(s[first - 1])) first--;
  if (unsafeWord(s.slice(first, gap)) || unsafeWord(s.slice(second, end))) {
    return s;
  }

  return `${s.slice(0, gap)}${NBSP}${s.slice(second)}`;
};

// A line as the browser should set it: every time held to its AM or
// PM, even one that arrived already formatted with a plain space ("10
// AM – 12 PM, at the market"), and the last two words kept together.
export const keepTogether = (text) => keepLastTwo(joinMeridiem(text ?? ""));
