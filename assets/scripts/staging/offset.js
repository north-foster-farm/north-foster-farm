// The toolbar's clock offset, kept in this browser (localStorage) when
// the clock is drawn, so the next page load can move the date-bound
// blocks (expiry.js) at once, not after the info fetch (#385). Cleared
// at offset 0.

export const OFFSET_KEY = "staging.clock-offset";

// -> the value to keep, or null to clear it.
export const keepOffset = (offset) =>
  Number.isFinite(offset) && offset !== 0 ? String(offset) : null;

// -> milliseconds from the kept value, 0 when nothing usable is kept.
export const savedOffset = (raw) => {
  const offset = Number(raw);

  return raw && Number.isFinite(offset) ? offset : 0;
};
