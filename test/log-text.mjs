// What a log line says, for the log scrubbing tests (#999): a line the
// logger wrote, or a list of them as a shipped body holds, serialized
// again with every field but `_time`. The logger sets `_time` itself
// and no test writes customer text there, so a test asserting that a
// customer's text is gone reads this, not the raw line: the raw line's
// timestamp can hold the very digits the test looks for (2026-11-23,
// "_time":"...13:47:05.555Z" failed "no 555 left"). Every other field,
// at every depth, is kept as written, so nothing the scrub must remove
// can hide from the check.

const drop = (line) => Object.fromEntries(Object.entries(line)
  .filter(([key]) => key !== "_time"));

export const logText = (raw) => {
  const parsed = JSON.parse(raw);

  return JSON.stringify(Array.isArray(parsed)
    ? parsed.map(drop) : drop(parsed));
};
