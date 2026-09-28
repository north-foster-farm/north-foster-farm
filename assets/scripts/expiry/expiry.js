// A note that stops being true on a date, such as "Starting October
// 17", carries that moment in data-hide-from. The build leaves it out
// once the moment has passed; this hides it in a page built before.

export const expired = (from, now = Date.now()) => {
  const at = Date.parse(from);

  return Number.isFinite(at) && now >= at;
};

export const hideExpired = (root = document) => {
  for (const el of root.querySelectorAll("[data-hide-from]")) {
    if (expired(el.dataset.hideFrom)) el.hidden = true;
  }
};
