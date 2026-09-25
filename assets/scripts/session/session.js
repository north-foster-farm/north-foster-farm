// Who is signed in, for every page. Asks /api/me once per five
// minutes, or at once after signing in or out (cached in
// sessionStorage; see cache.js), and settles the header slot: the
// Sign in link fades in, or the Account menu takes its place. A build
// without accounts has no slot.

import { api } from "../utils/api.js";
import { forgetCustomer } from "../order/draft.js";
import { fresh, stampFrom } from "./cache.js";

const KEY = "nff-me";

const read = () => {
  try {
    const raw = sessionStorage.getItem(KEY);

    return fresh(raw ? JSON.parse(raw) : null, stampFrom(document.cookie),
      Date.now());
  } catch {
    return null;
  }
};

const write = (me) => {
  try {
    sessionStorage.setItem(KEY, JSON.stringify({
      at: Date.now(), stamp: stampFrom(document.cookie), me,
    }));
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

// The Sign in link is in the markup from the start, transparent; the
// slot fades in once the answer is known, so the header never jumps.
const fill = (slot, who) => {
  const signin = slot.querySelector("[data-account-signin]");
  const menu = slot.querySelector("[data-account-menu]");

  if (!who.signedIn) {
    signin.hidden = false;
    menu.hidden = true;
    slot.classList.add("is-ready");

    return;
  }

  signin.hidden = true;
  menu.hidden = false;
  slot.classList.add("is-ready");

  slot.querySelector("[data-account-signout]").addEventListener("click",
    async () => {
      await api("/api/auth/signout", { method: "POST", body: {} });
      forget();
      forgetCustomer();
      location.href = "/";
    }, { once: true });
};

export const Session = {
  async show() {
    // Two slots: the header row and the phone menu.
    const slots = document.querySelectorAll("[data-account]");

    if (!slots.length) return;

    const who = await me();

    for (const slot of slots) fill(slot, who);
  },
};
