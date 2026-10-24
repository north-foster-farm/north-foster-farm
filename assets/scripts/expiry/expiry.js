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

// A moment that cannot be read leaves the block as built. Both ways are
// set, not just forward, so the staging toolbar's clock (#385), which
// can sit before the real time, brings back what the real time hid.
// Only what this hid comes back: data-expiry marks it, so a block
// another rule hid (a skipped market, a place's badge) stays hidden.
// Content the build left out cannot come back by moving the clock.
const hold = (el, hide) => {
  if (hide) {
    if (!el.hidden) {
      el.hidden = true;
      el.dataset.expiry = "hid";
    }
  } else if (el.dataset.expiry === "hid") {
    el.hidden = false;
    delete el.dataset.expiry;
  }
};

export const hideExpired = (root = document, now = Date.now()) => {
  for (const el of root.querySelectorAll("[data-hide-from]")) {
    if (Number.isFinite(Date.parse(el.dataset.hideFrom))) {
      hold(el, expired(el.dataset.hideFrom, now));
    }
  }
  for (const el of root.querySelectorAll("[data-show-from]")) {
    if (Number.isFinite(Date.parse(el.dataset.showFrom))) {
      // Built hidden until its moment: that hiding is this one's.
      if (el.hidden && el.dataset.expiry === undefined) {
        el.dataset.expiry = "hid";
      }
      hold(el, !expired(el.dataset.showFrom, now));
    }
  }
};
