// Who is signed in, for every page. Asks /api/me once per five
// minutes (cached in sessionStorage) and fills the header slot: a
// Sign in link, or an Account menu. The sign-in page shows the link
// as the current page; a build without accounts has no slot.

import { api } from "../utils/api.js";

const KEY = "nff-me";
const TTL = 5 * 60_000;

const read = () => {
  try {
    const raw = sessionStorage.getItem(KEY);
    const cached = raw ? JSON.parse(raw) : null;

    return cached && Date.now() - cached.at < TTL ? cached.me : null;
  } catch {
    return null;
  }
};

const write = (me) => {
  try {
    sessionStorage.setItem(KEY, JSON.stringify({ at: Date.now(), me }));
  } catch {
    // A cache only.
  }
};

export const forget = () => {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    // Nothing to forget.
  }
};

export const me = async () => {
  const cached = read();

  if (cached) return cached;

  const { ok, data } = await api("/api/me");
  const result = ok && data ? data : { signedIn: false };

  write(result);

  return result;
};

const fill = (slot, who) => {
  const signin = slot.querySelector("[data-account-signin]");
  const menu = slot.querySelector("[data-account-menu]");

  if (!who.signedIn) {
    signin.hidden = false;
    menu.hidden = true;
    slot.hidden = false;
    // On the sign-in page the link is the current page, like About
    // on /about/.
    if (/^\/login\//.test(location.pathname)) {
      signin.setAttribute("aria-current", "page");
    }

    return;
  }

  signin.hidden = true;
  menu.hidden = false;
  slot.hidden = false;

  slot.querySelector("[data-account-signout]").addEventListener("click",
    async () => {
      await api("/api/auth/signout", { method: "POST", body: {} });
      forget();
      location.href = "/";
    }, { once: true });
};

export const Session = {
  async show() {
    const slot = document.querySelector("[data-account]");

    if (!slot) return;

    fill(slot, await me());
  },
};
