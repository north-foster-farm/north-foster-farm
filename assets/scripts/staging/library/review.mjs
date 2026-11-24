// The reader's decisions (docs/refactors/staging-library.md, phase
// 3): which view to draw, the email's path, the link to it, its page
// made for the frame, and what a hash opens. Plain data in and out.

// The rewrite view only for an email James rewrote; HTML otherwise.
export const viewFor = (email, view) =>
  (view === "rewrite" && email.approval !== "rewritten" ? "html" : view);

export const emailPath = (id, view) =>
  `/api/staging/emails/${encodeURIComponent(id)}${
    view === "text" ? "?format=text" : ""}`;

// The link to hand James: #email=<id> on any page opens the library at
// that email.
export const linkTo = (origin, id) =>
  `${origin}/#email=${encodeURIComponent(id)}`;

// The email's own page, made to open its links outside the frame.
export const framed = (html) => html.replace(/<head>/i,
  '<head><base target="_blank">');

// { id } opens that email, { id: null } the shelf, null nothing.
export const hashTarget = (hash) => {
  const m = hash.match(/^#email=([^&]+)/);

  if (m) return { id: decodeURIComponent(m[1]) };

  return hash === "#emails" ? { id: null } : null;
};
