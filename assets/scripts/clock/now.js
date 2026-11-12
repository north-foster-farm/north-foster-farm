// What the site's scripts mean by "now" (#568): the real time, except
// on staging with the toolbar's clock set, where it is the time the
// tester set. The functions read the same offset from the nff_clock
// cookie (netlify/functions/lib/clock.mjs); in the page it is the copy
// the toolbar keeps in this browser (staging/offset.js), read only
// where the toolbar is in the page. Production markup never carries
// the toolbar (layouts/partials/staging-toolbar.html), so there this
// is always Date.now().
//
// Durations (a cache's age, a spinner's hold, a draft's savedAt) keep
// Date.now(): they measure real time passing, not the date.

import { OFFSET_KEY, savedOffset } from "../staging/offset.js";

const kept = () => {
  try {
    return window.localStorage.getItem(OFFSET_KEY);
  } catch {
    // Storage may be off: the toolbar's first pass then runs at the
    // real time, and its info fetch moves the page after.
    return null;
  }
};

// -> the offset in ms: the kept one where the toolbar is in `doc`,
// else 0.
export const clockOffset = (doc = globalThis.document, read = kept) =>
  doc && doc.getElementById && doc.getElementById("staging")
    ? savedOffset(read()) : 0;

export const siteNow = (doc = globalThis.document, read = kept) =>
  Date.now() + clockOffset(doc, read);
