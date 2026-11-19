// The farm's maintenance message (#267), shown at the top of the page
// when the site refuses a change because maintenance is on, and on
// the order, account and sign-in pages as soon as /api/me says it is
// (#489). Styled here, not in a class, so nothing for PurgeCSS to
// strip.

const STYLE = "position:sticky;top:0;z-index:2000;margin:0;" +
  "padding:.75rem 1rem;text-align:center;background:#fff3cd;" +
  "color:#664d03;border-bottom:1px solid #ffecb5";

export const announce = (message) => {
  if (typeof document === "undefined" || !document.body || !message) return;

  let bar = document.getElementById("maintenance-notice");

  if (!bar) {
    bar = document.createElement("p");
    bar.id = "maintenance-notice";
    bar.setAttribute("role", "alert");
    bar.style.cssText = STYLE;
    document.body.prepend(bar);
  }
  bar.textContent = message;
};

// The pages maintenance closes, where the bar shows on load: a
// customer on the order page should not fill a cart before learning
// that Pay is refused (#489). Every path under each counts, so an
// order's own page in the account does too.
const CLOSED = /^\/(?:order|account|login)(?:\/|$)/;

// -> the message to show on load at `path`, given /api/me's answer,
// or "" for none: another page, maintenance off, or an admin's
// session, whose answer carries no notice.
export const noticeOnLoad = (me, path) => (
  me && me.maintenance === true && me.message && CLOSED.test(path || "")
    ? me.message : "");

// Shows the bar on load when /api/me's answer calls for it here.
export const announceOnLoad = (me) => {
  if (typeof location === "undefined") return;
  announce(noticeOnLoad(me, location.pathname));
};
