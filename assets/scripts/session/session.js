// Who is signed in, for every page. Asks /api/me once per five
// minutes, or at once after signing in or out (cached in
// sessionStorage; see cache.js), and settles the header slot: the
// Sign in link fades in, or the Account menu takes its place. A build
// without accounts has no slot.

import { api } from "../utils/api.js";
import { failBusy, isBusy, setBusy } from "../utils/busy-button.js";
import { forgetCustomer } from "../order/draft.js";
import { fresh, stampFrom } from "./cache.js";
import { whileLoading } from "../utils/skeleton.js";

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

// Every Sign out button: the order draft keeps its cart but loses the
// customer's details, as the privacy page promises.
// Pressed, the button stays busy until the home page takes over, or
// goes idle and says it failed if the site never signs it out. The
// click stops here, so Bootstrap leaves the header's menu open and its
// egg and any failure show (#299).
export const signOut = async (event) => {
  const button = event && event.currentTarget;

  if (event) event.stopPropagation();
  if (button && isBusy(button)) return;
  if (button) setBusy(button, true);

  let answer;

  try {
    answer = await api("/api/auth/signout", { method: "POST", body: {} });
  } catch (error) {
    console.error("Sign out failed", error);
    answer = { ok: false, data: null };
  }

  if (!answer.ok) {
    if (button) failBusy(button, answer.data && answer.data.message);

    return;
  }
  forget();
  forgetCustomer();
  location.href = "/";
};

export const me = async () => {
  const cached = read();

  if (cached) return cached;

  const { ok, data } = await api("/api/me");
  const result = ok && data ? data : { signedIn: false };

  write(result);

  return result;
};

// The customer's chicken before "Account" (#238), or none. The account
// page calls it again when a new one is picked.
export const showChick = (root, avatar) => {
  for (const chick of root.querySelectorAll("[data-account-chick]")) {
    // An <svg> has no `hidden` property; the attribute works.
    chick.toggleAttribute("hidden", !avatar);
    if (avatar && /^[\w-]+$/.test(avatar)) {
      chick.querySelector("use").setAttribute("href", `#avatar-${avatar}`);
    }
  }
};

// The Sign out buttons fill() has bound.
const wired = new WeakSet();

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
  showChick(slot, who.customer && who.customer.avatar);
  slot.classList.add("is-ready");

  // Bound once per button, and kept: a sign-out that fails can be
  // pressed again.
  const button = slot.querySelector("[data-account-signout]");

  if (!wired.has(button)) {
    wired.add(button);
    button.addEventListener("click", signOut);
  }
};

export const Session = {
  async show() {
    // Two slots in the header row: with the links from md up, and with
    // the actions below md (#303).
    const slots = document.querySelectorAll("[data-account]");

    if (!slots.length) return;

    // A slow answer shows a bar in the slot (#271); none at all, or an
    // error, leaves the Sign in link, and a late answer still lands.
    const who = await whileLoading(slots, me, {
      render: (answer) => {
        for (const slot of slots) fill(slot, answer);
      },
    });

    if (!who) for (const slot of slots) fill(slot, { signedIn: false });
  },
};
