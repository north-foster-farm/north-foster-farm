// Calendar arithmetic in a named time zone without Temporal, which
// Node 26 does not ship. Calendar days are ISO strings (YYYY-MM-DD) so
// day arithmetic never touches an offset; only "now" and a cutoff are
// converted between a wall-clock time and an instant.

const formatters = new Map();

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const formatter = (timeZone) => {
  if (!formatters.has(timeZone)) {
    formatters.set(timeZone, new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      weekday: "short",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }));
  }

  return formatters.get(timeZone);
};

// The wall-clock parts of an instant in a zone.
export const parts = (date, timeZone) => {
  const out = {};

  for (const { type, value } of formatter(timeZone).formatToParts(date)) {
    if (type === "weekday") {
      out.weekday = WEEKDAYS.indexOf(value);
    } else if (type !== "literal") {
      out[type] = Number(value);
    }
  }

  return out;
};

const pad = (n) => String(n).padStart(2, "0");

export const isoDate = ({ year, month, day }) =>
  `${year}-${pad(month)}-${pad(day)}`;

export const today = (now, timeZone) => isoDate(parts(now, timeZone));

const split = (iso) => iso.split("-").map(Number);

const utcMidnight = (iso) => {
  const [y, m, d] = split(iso);

  return Date.UTC(y, m - 1, d);
};

export const addDays = (iso, n) => {
  const date = new Date(utcMidnight(iso) + n * 86_400_000);

  return isoDate({
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  });
};

// 0 = Sunday … 6 = Saturday.
export const weekday = (iso) => new Date(utcMidnight(iso)).getUTCDay();

const offsetMs = (date, timeZone) => {
  const p = parts(date, timeZone);
  const asUtc = Date.UTC(
    p.year, p.month - 1, p.day, p.hour, p.minute, p.second
  );

  return asUtc - date.getTime();
};

// The instant at which a zone's clocks read the given wall-clock time.
// Two passes handle the offset changing between the guess and the
// answer, which is what happens on a DST boundary.
export const instant = (iso, hour, minute, timeZone) => {
  const [y, m, d] = split(iso);
  const guess = Date.UTC(y, m - 1, d, hour, minute, 0);
  const first = guess - offsetMs(new Date(guess), timeZone);
  const second = guess - offsetMs(new Date(first), timeZone);

  return new Date(second);
};

const labelFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  weekday: "long",
  month: "long",
  day: "numeric",
});

// "Thursday, October 8" for an ISO date, independent of any zone.
export const label = (iso) => labelFormatter.format(new Date(utcMidnight(iso)));
