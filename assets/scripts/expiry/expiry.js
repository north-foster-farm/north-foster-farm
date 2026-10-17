// A note that stops being true on a date, such as "Starting October
// 17", carries that moment in data-hide-from. The build leaves it out
// once the moment has passed; this hides it in a page built before.
// Its counterpart, data-show-from, marks something the build leaves
// hidden until its moment, such as the off-season band under the
// market band's last day; this shows it in a page built before.

export const expired = (from, now = Date.now()) => {
  const at = Date.parse(from);

  return Number.isFinite(at) && now >= at;
};

export const hideExpired = (root = document, now = Date.now()) => {
  for (const el of root.querySelectorAll("[data-hide-from]")) {
    if (expired(el.dataset.hideFrom, now)) el.hidden = true;
  }
  for (const el of root.querySelectorAll("[data-show-from]")) {
    if (expired(el.dataset.showFrom, now)) el.hidden = false;
  }
};
