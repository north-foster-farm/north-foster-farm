// A member's key tag (#131): /account/member-tag/. The page asks
// /api/membership for the member's code and draws the tag with the QR
// code the server makes of it (/api/membership/code), so the code
// never leaves the site for an outside image service. Signed out, the
// sign-in page brings them back here. Draft wording, for James.

import { api } from "../utils/api.js";

export const NOT_MEMBER = "Your account isn't in a buying group, so it " +
  "has no member code to print.";
export const NO_CODE = "Your member code isn't ready yet. Open the " +
  "Membership tab on your account page, then come back.";
export const FAILED = "We couldn't load your member code just now. " +
  "Check your connection and reload the page.";

const start = async () => {
  const ready = document.getElementById("tag-ready");

  if (!ready) return;

  const notice = document.getElementById("tag-notice");
  const say = (text) => {
    notice.textContent = text;
    notice.hidden = false;
  };
  const res = await api("/api/membership").catch(() => null);

  if (res && res.status === 401) {
    location.replace(`/login/?next=${encodeURIComponent(location.pathname)}`);

    return;
  }
  if (res && res.status === 404) {
    say(NOT_MEMBER);

    return;
  }
  if (!res || !res.ok) {
    say(FAILED);

    return;
  }

  const own = res.data && res.data.member;

  if (!own) {
    say(NOT_MEMBER);

    return;
  }
  if (!own.code) {
    say(NO_CODE);

    return;
  }

  const img = document.getElementById("tag-qr");

  document.getElementById("tag-id").textContent = own.code.id;
  img.src = `/api/membership/code?v=${encodeURIComponent(own.code.id)}`;
  ready.hidden = false;
  document.getElementById("tag-print").addEventListener("click",
    () => window.print());
};

start();
