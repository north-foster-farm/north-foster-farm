// The library's search and its counts, pure (docs/refactors/
// staging-library.md, phase 1): which emails the search's words and
// the approval filter keep, grouped as the shelf shows them, and the
// lines that count them.

const GROUPS = [
  ["customer", "To the customer"],
  ["farm", "To the farm"],
  ["list", "Farm news"],
];

export const LABELS = { rewritten: "rewritten, to apply" };

// The search box's words, lower-cased.
export const wordsOf = (query) => query.toLowerCase().split(/\s+/)
  .filter(Boolean);

const haystack = (e) => [e.id, e.name, e.when, e.subject, e.text,
  e.approval, LABELS[e.approval], e.audience, ...(e.tags || [])]
  .join("\n").toLowerCase();

export const matches = (e, words, approval = "") => {
  const hay = haystack(e);

  return (!approval || e.approval === approval)
    && words.every((w) => hay.includes(w));
};

// A sent email, from /api/staging/sent: its subject and addresses.
export const sentMatches = (m, words) => {
  const hay = `${m.subject} ${[].concat(m.to).join(" ")}`.toLowerCase();

  return words.every((w) => hay.includes(w));
};

// The shelf's groups in order, each with what it shows; the sent
// mail last, James's alone (#294). An approval filter is about
// templates; sent mail has none.
export const grouped = ({ emails, sent, words, approval, canSeeSent }) => {
  const groups = GROUPS.map(([key, title]) => ({
    key, title,
    items: emails.filter((e) => e.audience === key
      && matches(e, words, approval)),
  })).filter((g) => g.items.length);
  const mail = sent.filter((m) => sentMatches(m, words));

  if (mail.length && !approval && canSeeSent) {
    groups.push({ key: "sent", title: "Sent, every session", items: mail });
  }

  return groups;
};

export const summaryLine = (emails) => {
  const waiting = emails.filter((e) => e.approval === "to approve").length;
  const redone = emails.filter((e) => e.approval === "rewritten").length;

  return `${emails.length}, ${waiting} to approve${
    redone ? `, ${redone} rewritten` : ""}`;
};

// The toolbar's line on the library (#303). Feedback given is a
// rewrite waiting to be ported; updated, an email whose wording the
// code has changed since James approved or rewrote it
// (lib/review.mjs, standing).
export const tally = (emails) => {
  const n = (test) => emails.filter(test).length;

  return [
    `Total emails: ${emails.length}`,
    `To approve: ${n((e) => e.approval === "to approve")}`,
    `Feedback given: ${n((e) => e.approval === "rewritten")}`,
    `Updated: ${n((e) => e.updated)}`,
  ].join(" · ");
};
