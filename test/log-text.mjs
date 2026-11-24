// What a log line says, for the log scrubbing tests (#999): a line the
// logger wrote, or a list of them as a shipped body holds, serialized
// again without the timestamp the logger wrote. A test asserting that
// a customer's text is gone reads this, not the raw line: the raw
// line's timestamp can hold the very digits the test looks for
// (2026-11-23, "_time":"...13:47:05.555Z" failed "no 555 left").
//
// Only a top-level `_time` that is a well-formed instant, as
// Date#toISOString() writes it (YYYY-MM-DDTHH:MM:SS.mmmZ, or a signed
// six-digit year), is left out. A caller's fields are spread after the
// logger's own `_time` (line() in lib/log.mjs), and log-fields writes
// customer text there, so any other `_time` value is read like every
// other field (2026-11-23, #1005's QA review: this said no test writes
// customer text there and dropped every `_time`). Every other field,
// at every depth, is kept as written, so nothing the scrub must remove
// can hide from the check. log-clock.test.mjs proves both halves.

const INSTANT = /^(?:\d{4}|[+-]\d{6})-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;

export const isInstant = (value) => typeof value === "string"
  && INSTANT.test(value);

const drop = (line) => Object.fromEntries(Object.entries(line)
  .filter(([key, value]) => key !== "_time" || !isInstant(value)));

export const logText = (raw) => {
  const parsed = JSON.parse(raw);

  return JSON.stringify(Array.isArray(parsed)
    ? parsed.map(drop) : drop(parsed));
};
