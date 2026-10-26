// Farm news sign-up forms, hidden from people already on the list
// (#267). A signed-in customer follows the server: opted in hides the
// forms, not opted in shows them. Anyone else follows a flag this
// browser sets after a sign-up here (never the address), which the
// unsubscribe page clears. The flag only saves a request: without it
// the forms show, and signing up again is harmless.

import { me } from "../session/session.js";
import { stampFrom } from "../session/cache.js";

const KEY = "nff-news";
const JOINED = "joined";

export const remembered = () => {
  try {
    return localStorage.getItem(KEY) === JOINED;
  } catch {
    return false;
  }
};

export const remember = () => {
  try {
    localStorage.setItem(KEY, JOINED);
  } catch {
    // A convenience only.
  }
};

export const forgetJoined = () => {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // Nothing to forget.
  }
};

// -> whether the sign-up forms show, given /api/me's answer.
export const showForms = (who, joined) => (who && who.signedIn
  ? !(who.customer && who.customer.marketing === true)
  : !joined);

// Hides each block (heading and form together) that is not wanted.
// With a sign-in stamp the answer comes from the server, so the
// blocks keep their space, unseen, until it arrives: a form that
// stays never jumps, and one that goes collapses once.
export const wireNewsHiding = async () => {
  const blocks = [...document.querySelectorAll("[data-farm-list-block]")];

  if (!blocks.length) return;

  const apply = (shown) => {
    for (const block of blocks) {
      block.hidden = !shown;
      block.style.visibility = "";
    }
  };

  if (!stampFrom(document.cookie)) {
    apply(showForms(null, remembered()));

    return;
  }

  for (const block of blocks) block.style.visibility = "hidden";

  const who = await me();
  const shown = showForms(who, remembered());

  if (who.signedIn && shown) forgetJoined();
  apply(shown);
};
