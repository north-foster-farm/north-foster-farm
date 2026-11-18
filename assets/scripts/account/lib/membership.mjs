// The Membership tab's words (#495, #602), kept apart from the page so
// the tests can hold them. The pills Open and Next and the two lines
// under them follow James's sketch (#602); the rest is a draft for
// him. Spaces here are ordinary; main.js keeps each time with its AM
// or PM, and each line's last two words, together where it sets the
// text (#593, #598).

import { meridiem, spaceMeridiem } from "../../utils/keep-together.mjs";

// How a member came to the group, as the host's list says it.
export const JOIN_WAYS = {
  code: "by code",
  link: "by link",
  qr: "by QR code",
  "walk-in": "at a pickup",
  farm: "added by the farm",
  host: "added by you",
  invite: "by invitation",
  // Older records' paths: a code, typed or on an order.
  account: "by code",
  order: "by code",
};

// The host's join link (#579): what its Copy says, for COPIED_MS.
export const COPIED_MS = 1600;
export const LINK_COPIED = "Link copied";
export const LINK_NOT_COPIED =
  "Copying failed. The link is selected, so copy it yourself.";

// "08:30" -> "8:30 AM".
export const clock = (hhmm) => {
  const [h, m] = String(hhmm).split(":").map(Number);

  return meridiem(`${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")}`,
    h < 12 ? "AM" : "PM");
};

// A pickup window as James's sketch writes it (#602), an en dash
// between its ends: "8:30 – 9:00 AM", or "11:30 AM – 12:30 PM" across
// noon.
export const hours = (from, to) => {
  const a = clock(from);
  const b = clock(to);

  return a.slice(-2) === b.slice(-2)
    ? `${a.slice(0, -3)} – ${b}` : `${a} – ${b}`;
};

// A pickup day, the weekday in full and the month short: "Sunday,
// Nov 22".
export const pickupDay = (date) => new Date(`${date}T12:00:00Z`)
  .toLocaleDateString("en-US", {
    weekday: "long", month: "short", day: "numeric", timeZone: "UTC",
  });

// An instant's day in the farm's zone, both short: "Sat, Nov 21".
export const shortDay = (iso, timeZone) => new Date(iso)
  .toLocaleDateString("en-US", {
    timeZone, weekday: "short", month: "short", day: "numeric",
  });

// An instant's time in the farm's zone: "11:59 PM", ICU's narrow
// no-break space before the PM made ordinary (#598).
export const timeOf = (iso, timeZone) => spaceMeridiem(new Date(iso)
  .toLocaleTimeString("en-US", {
    timeZone, hour: "numeric", minute: "2-digit",
  }));

// The pills, in the order the rounds are listed. Open and Next are
// James's words; Closed is a draft he accepted (2026-11-18).
export const PILLS = { closed: "Closed", open: "Open", next: "Next" };

// The rounds the tab lists (#602), in order: the one whose ordering
// has closed and whose pickup is still to come (#600), the one open,
// and the next. Each is two lines: the pickup's `date` and `window`
// ("" when the series names no hours), then, after the pill, `line`.
// Only the open round takes orders. None: [].
export const rounds = (r, timeZone) => {
  if (!r) return [];

  const window = r.opens && r.closes ? hours(r.opens, r.closes) : "";
  const round = (state, date, line) => ({
    state, pill: PILLS[state], date: pickupDay(date), window, line,
    order: state === "open",
  });
  // The next round opens as this one closes, at 11:59 PM, so the day
  // it is open from is the day after: a minute on.
  const opensOn = (iso) => shortDay(
    new Date(new Date(iso).getTime() + 60000).toISOString(), timeZone
  );

  return [
    r.closed && round("closed", r.closed.date,
      `Next pickup is ${pickupDay(r.closed.date)}`),
    r.current && round("open", r.current.date,
      `Closes at ${timeOf(r.current.closesAt, timeZone)} on ${
        shortDay(r.current.closesAt, timeZone)}`),
    r.next && round("next", r.next.date,
      `Opens on ${opensOn(r.next.opensAt)}`),
  ].filter(Boolean);
};

// The pickup place as one line under the group's name (#602): the
// street, then the city, state and ZIP. The place's own name leads
// only when it is not the group's, which the heading already says.
// None: "".
export const addressLine = (p, groupName = "") => (p ? [
  p.name === groupName ? "" : p.name, p.street,
  [p.city, [p.state, p.zip].filter(Boolean).join(" ")]
    .filter(Boolean).join(", "),
].filter(Boolean).join(", ") : "");

// "Joined Nov 2, 2026, by QR code".
export const joinedLine = (m, placed) => [
  m.joinedAt ? `Joined ${placed(m.joinedAt)}` : "",
  JOIN_WAYS[m.via] || "",
].filter(Boolean).join(", ");
