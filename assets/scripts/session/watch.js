// A page open since before a sign-in in another tab or window learns
// of it (#521): the stamp cookie (cache.js) is new when the customer
// comes back to the page (it shows again, takes focus, or comes back
// from the back/forward cache) or when another tab saves the draft
// under `key`. The page then asks /api/me again, which the new stamp
// makes fresh. Only a sign-in is told: a page that saw the stamp go
// leaves that to the server, which prices from the session.

import { stampFrom } from "./cache.js";

export const watchSignIn = (onSignIn, { key = null } = {}) => {
  let seen = stampFrom(document.cookie);

  const check = () => {
    const stamp = stampFrom(document.cookie);

    if (stamp === seen) return;
    seen = stamp;
    if (stamp) onSignIn(stamp);
  };

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") check();
  });
  window.addEventListener("focus", check);
  window.addEventListener("pageshow", check);
  window.addEventListener("storage", (e) => {
    if (!key || e.key === key) check();
  });

  return check;
};
