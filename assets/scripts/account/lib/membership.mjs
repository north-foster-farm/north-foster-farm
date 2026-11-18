// The Membership tab's words (#495), kept apart from the page so the
// tests can hold them. Every line is a draft for James. A time keeps
// its AM or PM here; main.js keeps each line's last two words together
// where it sets the text (#593).

import { joinMeridiem, meridiem } from "../../utils/keep-together.mjs";

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

// "08:30" -> "8:30 AM", the half of the day joined to the time by a
// no-break space (#593).
export const clock = (hhmm) => {
  const [h, m] = String(hhmm).split(":").map(Number);

  return meridiem(`${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")}`,
    h < 12 ? "AM" : "PM");
};

const weekday = (iso) => new Date(`${iso}T12:00:00Z`)
  .toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" });

// "8:30 to 9:00 AM", or "11:30 AM to 12:30 PM" across noon.
export const hours = (from, to) => {
  const a = clock(from);
  const b = clock(to);

  return a.slice(-2) === b.slice(-2)
    ? `${a.slice(0, -3)} to ${b}` : `${a} to ${b}`;
};

// "Every 2 weeks, on Sundays, 8:30 to 9:00 AM".
export const roundsLine = (r) => {
  const every = r.every === 1 ? "Every week" : `Every ${r.every} weeks`;
  const time = r.opens && r.closes ? `, ${hours(r.opens, r.closes)}` : "";

  return `${every}, on ${weekday(r.current.date)}s${time}`;
};

// An instant in the farm's zone: "Saturday, November 7, 11:59 PM",
// the time and its PM joined (#593).
export const moment = (iso, timeZone) => joinMeridiem(new Date(iso)
  .toLocaleString("en-US", {
    timeZone, weekday: "long", month: "long", day: "numeric",
    hour: "numeric", minute: "2-digit",
  }).replace(" at ", ", "));

// A pickup day at its window's start, as the round rows read it
// (#579): "Sunday, November 22, 8:30 AM". The day alone when the
// series names no hours.
export const pickupMoment = (date, opens) => {
  const day = new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", {
    weekday: "long", month: "long", day: "numeric", timeZone: "UTC",
  });

  return opens ? `${day}, ${clock(opens)}` : day;
};

// The four round rows (#579), each a label's value: this round's
// close and pickup, the next one's opening and pickup. A row the data
// can't fill is "" and the page leaves it out.
export const roundRows = (r, timeZone) => ({
  closes: r ? moment(r.current.closesAt, timeZone) : "",
  pickup: r ? pickupMoment(r.current.date, r.opens) : "",
  opens: r && r.next ? moment(r.next.opensAt, timeZone) : "",
  "next-pickup": r && r.next ? pickupMoment(r.next.date, r.opens) : "",
});

// Which round each row sits under (#597): the page's This round and
// Next round subheadings, in order.
export const ROUND_GROUPS = {
  this: ["closes", "pickup"],
  next: ["opens", "next-pickup"],
};

// The rows by round (#597): { this: [[row, value], ...], next: ... },
// with only the rows the data fills. A round with none is left out,
// its subheading with it.
export const roundGroups = (r, timeZone) => {
  const rows = roundRows(r, timeZone);

  return Object.fromEntries(Object.entries(ROUND_GROUPS)
    .map(([round, names]) => [round,
      names.filter((name) => rows[name]).map((name) => [name, rows[name]])])
    .filter(([, filled]) => filled.length));
};

// The pickup place on three lines (#579): its name, the street, then
// the city, state and ZIP. None: no lines.
export const placeLines = (p) => (p ? [
  p.name, p.street, [p.city, [p.state, p.zip].filter(Boolean).join(" ")]
    .filter(Boolean).join(", "),
].filter(Boolean) : []);

// "Joined Nov 2, 2026, by QR code".
export const joinedLine = (m, placed) => [
  m.joinedAt ? `Joined ${placed(m.joinedAt)}` : "",
  JOIN_WAYS[m.via] || "",
].filter(Boolean).join(", ");
