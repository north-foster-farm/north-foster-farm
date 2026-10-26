// The Email badge (#303): how many of this session's emails arrived
// since the toolbar's Email section was last in view. The newest one
// seen then is kept in sessionStorage under SEEN_MAIL, so the count
// holds across the page loads an order or a sign-in makes.

export const SEEN_MAIL = "staging.seen-mail";

// `messages` newest first; `seen` the newest id seen, "" for an empty
// list, or null before the first look. -> the count of new ones.
export const unseen = (messages, seen) => {
  if (seen === null || seen === undefined) return 0;

  const at = messages.findIndex((m) => m.id === seen);

  return at === -1 ? messages.length : at;
};
