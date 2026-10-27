// What `bin/nff events` prints: every series by code with its name,
// location and season, and its occurrences in the coverage window with
// the schedule line each has (or the lack of one).

import { seriesDates } from "../../../assets/scripts/order/lib/events.mjs";
import { coverage } from "../../../assets/scripts/order/lib/schedule.mjs";
import { label } from "../../../assets/scripts/order/lib/zoned.mjs";

const season = (s) => (s.end === s.start ? s.start
  : `${s.start} to ${s.end || "until further notice"}`);

const lineText = (l) => (l
  ? `${l.action}${l.from ? ` ${l.from}-${l.to}` : ""}`
  : "NO LINE (not offered; check:schedule fails the deploy)");

// -> [string], one per line to print.
export const listEvents = (terms, schedule, now) => {
  const { model } = terms;
  const { first, last } = coverage(now, terms.timeZone);
  const lines = schedule.lines || [];
  const out = [];

  for (const s of model.series) {
    const loc = model.location(s.location);

    out.push(`${s.code}  ${s.name}${s.archived ? " (archived)" : ""}`);
    out.push(`      ${s.kind}, at ${loc ? loc.name : s.location} (${
      s.location}), ${season(s)}, ${s.window}`);
    if (s.archived) continue;
    for (const date of seriesDates(s, first, last)) {
      const line = lines.find((l) => l.date === date && l.code === s.code);

      out.push(`      ${s.code}-${date.slice(2, 4)}${date.slice(5, 7)}${
        date.slice(8, 10)}  ${label(date)}: ${lineText(line)}`);
    }
  }

  return out;
};
