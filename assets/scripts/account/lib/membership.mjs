// The Membership tab's words (#495), kept apart from the page so the
// tests can hold them. Every line is a draft for James.

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

// "08:30" -> "8:30 AM".
export const clock = (hhmm) => {
  const [h, m] = String(hhmm).split(":").map(Number);

  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")} ${
    h < 12 ? "AM" : "PM"}`;
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

// An instant in the farm's zone: "Saturday, November 7, 11:59 PM".
export const moment = (iso, timeZone) => new Date(iso)
  .toLocaleString("en-US", {
    timeZone, weekday: "long", month: "long", day: "numeric",
    hour: "numeric", minute: "2-digit",
  }).replace(" at ", ", ");

// "Joined Nov 2, 2026, by QR code".
export const joinedLine = (m, placed) => [
  m.joinedAt ? `Joined ${placed(m.joinedAt)}` : "",
  JOIN_WAYS[m.via] || "",
].filter(Boolean).join(", ");
