// A page open since before a sign-in in another tab or window learns
// of it (#521): the stamp cookie (cache.js) is new when the customer
// comes back to the page (it shows again, takes focus, or comes back
// from the back/forward cache) or when another tab saves the draft
// under `key`. The page then asks /api/me again, which the new stamp
// makes fresh. A page that had a stamp and sees it go is told once, by
// `onSignOut`, so it can reload as the signed-out visitor it now is:
// the stamp it had is forgotten, so the same absence is never told
// twice, and a page that never had one is never told.

import { stampFrom } from "./cache.js";

export const watchSignIn = (onSignIn, {
  key = null, onSignOut = null,
} = {}) => {
  let seen = stampFrom(document.cookie);

  const check = () => {
    const stamp = stampFrom(document.cookie);

    if (stamp === seen) return;

    const had = seen;

    seen = stamp;
    if (stamp) onSignIn(stamp);
    else if (had && onSignOut) onSignOut();
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
