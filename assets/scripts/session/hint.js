// The header's account slot from the first paint (#565). Loaded in
// <head>, not deferred (partials/head/session-hint.html), so it runs
// before the page is drawn: a page carrying the stamp cookie (see
// cache.js) is marked signed in, and the header keeps the Account
// button's place, unseen, for session.js to fill. Without the stamp
// the Sign in link the page drew shows at once.

import { stampFrom } from "./cache.js";

// -> whether the cookies say signed in, as far as a page can tell.
export const markSession = (doc) => {
  const signedIn = Boolean(stampFrom(doc.cookie));

  if (signedIn) doc.documentElement.dataset.session = "in";

  return signedIn;
};

if (typeof document !== "undefined") markSession(document);
