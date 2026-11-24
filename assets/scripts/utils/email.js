// The one email rule (#678), for the browser's forms and the server
// alike: the order gate, sign-in, the access gate and the group log
// all import it.
//
// Normalizing drops trailing periods and spaces together, trims and
// lowercases, so "Pat@Example.com." and "pat@example.com" are the
// same address. It runs in linear time on any input, and normalizing
// twice gives what normalizing once did.
// Validating takes at most 254 characters: anything without spaces
// before the @, and after it a domain of labels of letters, digits
// and hyphens joined by single periods, no hyphen at either end of a
// label, and a final label of at least two letters. That is stricter
// than type="email", which lets "you@farm" through, and refuses what
// Square refuses, such as "name@example..com".

const LABEL = "[a-z0-9](?:[a-z0-9-]*[a-z0-9])?";
const ADDRESS = new RegExp(`^[^\\s@]+@(?:${LABEL}\\.)+[a-z]{2,}$`, "i");
const MAX = 254;
const SPACE = /\s/;

// Whether `c` is a period or a space of any kind, the commonest first.
const trailing = (c) => c === "." || c === " " || SPACE.test(c);

export const normalizeEmail = (value) => {
  const s = String(value || "");
  let end = s.length;

  while (end > 0 && trailing(s[end - 1])) end -= 1;

  return s.slice(0, end).trim().toLowerCase();
};

export const looksLikeEmail = (value) => {
  const address = normalizeEmail(value);

  return address.length <= MAX && ADDRESS.test(address);
};

// A control character: C0, DEL or C1.
const control = (s) => [...s].some((c) => {
  const code = c.codePointAt(0);

  return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
});
const ESCAPE = /%[0-9a-f]{2}/i;

// An address as a function or the CLI receives it (#758): decoded
// once, then normalized and validated -> the address, or null when it
// fails. A value that is not a string, holds a control character, has
// a malformed escape, or still holds an escape after one decode (an
// address encoded twice) fails. Only for input: a stored address is
// already decoded, and decoding it again could change it.
export const receivedEmail = (value) => {
  if (typeof value !== "string") return null;

  let decoded;

  try {
    decoded = decodeURIComponent(value);
  } catch {
    return null;
  }
  if (control(decoded) || ESCAPE.test(decoded)) return null;

  const address = normalizeEmail(decoded);

  return looksLikeEmail(address) ? address : null;
};

// Whether a whole value may be an address, valid or not: one "@" and
// no space once trimmed. For masking, where missing an address the
// rule refuses would leave it in full.
export const mayBeEmail = (value) => {
  const s = String(value || "").trim();
  const at = s.indexOf("@");

  return at >= 0 && at === s.lastIndexOf("@") && !/\s/.test(s);
};
