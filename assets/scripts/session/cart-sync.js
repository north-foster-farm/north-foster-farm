// A signed-in customer's cart on every device (#149). A change to the
// cart draft goes to the account a moment later, or at once when the
// page is left. The account's copy is fetched once per tab and sign-in,
// and by the order page before it restores the draft; whichever copy
// was saved last wins (order/lib/cart-sync.mjs). A guest's cart never
// leaves the browser.
//
// The draft is tagged with the account it was pulled or saved under. A
// page that finds it tagged for someone not signed in here (the session
// ended without a sign-out, or another account signed in) scrubs their
// details as Sign out does, before anything is shown or sent.

import { announceCart } from "../cart-badge/announce.js";
import { Draft, forgetCustomer } from "../order/draft.js";
import { cartOf, settle, stray } from "../order/lib/cart-sync.mjs";
import { cartCount } from "../search/cart.js";
import { api } from "../utils/api.js";
import { stampFrom } from "./cache.js";

const PATH = "/api/account/cart";
const DELAY = 1500;
const PULLED = "nff-cart-pulled";

// Fired on window when another account's details leave the draft, so a
// page showing them (the order form) clears them too.
export const SCRUBBED = "nff:draft-scrubbed";

// The stamp cookie says whether anyone is signed in, without asking.
const signedIn = () => !!stampFrom(document.cookie);

let timer = null;

// Scrubs a draft tagged for anyone but `account` (null: no one is
// signed in). -> true when it did.
const scrub = () => {
  forgetCustomer();
  window.dispatchEvent(new CustomEvent(SCRUBBED));
};

export const scrubStray = (account) => {
  if (!stray(new Draft().owner(), account)) return false;
  scrub();

  return true;
};

// What goes up: the cart, or word that it was cleared (an order
// placed), with the draft's tag, which the account refuses when it is
// another's.
const copyOf = (draft) => {
  const current = draft.current();
  const owner = current.owner || undefined;

  return current.payload
    ? { payload: cartOf(current.payload), savedAt: current.savedAt, owner }
    : { payload: null, savedAt: Date.now(), owner };
};

export const push = async ({ keepalive = false } = {}) => {
  clearTimeout(timer);
  timer = null;
  if (!signedIn()) {
    scrubStray(null);

    return;
  }

  const draft = new Draft();
  const sent = copyOf(draft);
  const { ok, status, data } = await api(PATH, {
    method: "PUT", body: sent, keepalive,
  }).catch(() => ({}));

  // Another account's draft: scrubbed here, never kept there.
  if (status === 409) {
    scrub();

    return;
  }
  // The session ended on the server; the stamp outlived it.
  if (status === 401) {
    scrubStray(null);

    return;
  }
  if (!ok || !data) return;
  if (sent.payload) draft.setOwner(data.owner);

  // The account may keep an earlier time than this device's clock
  // gave; take it, unless the draft changed meanwhile.
  if (data.kept && sent.payload
    && draft.current().savedAt === sent.savedAt) {
    draft.restamp(data.cart.savedAt);
  }
};

const later = () => {
  clearTimeout(timer);
  timer = setTimeout(push, DELAY);
};

// Fetches the account's copy and settles it with this device's.
// Gives up after `timeout`, keeping this device's. -> true when the
// account's copy replaced this device's, or another account's details
// were scrubbed from it.
export const pullCart = async ({ timeout = 2000 } = {}) => {
  if (!signedIn()) {
    scrubStray(null);

    return false;
  }

  const draft = new Draft();
  const before = draft.current().savedAt;
  const answer = await Promise.race([
    api(PATH).catch(() => ({})),
    new Promise((resolve) => {
      setTimeout(() => resolve({}), timeout);
    }),
  ]);

  // The session ended on the server (the account deleted, the CLI,
  // the sweep) and the stamp outlived it: signed out, so scrub.
  if (answer.status === 401) return scrubStray(null);
  if (!answer.ok || !answer.data) return false;

  const { owner } = answer.data;

  // Another account's details never reach this one, whatever else
  // happens below.
  const scrubbed = scrubStray(owner);

  // A change made while the answer was on its way is newer than it,
  // and on its way up already.
  if (draft.current().savedAt !== before) return scrubbed;

  const local = draft.load();
  const remote = answer.data.cart;
  const winner = settle(local, remote);

  if (winner !== "remote") draft.setOwner(owner);
  if (winner === "local") push();
  if (winner !== "remote" || (!remote.payload && !local)) return scrubbed;

  draft.adopt(remote);
  draft.setOwner(owner);

  return true;
};

// Every page. The order page fetches the account's copy itself.
export const wireCartSync = () => {
  window.addEventListener("nff:draft", () => {
    if (signedIn()) later();
  });
  window.addEventListener("pagehide", () => {
    if (timer) push({ keepalive: true });
  });

  // Signed out: a draft someone left signed in loses their details.
  if (!signedIn()) {
    scrubStray(null);

    return;
  }
  if (document.getElementById("order-form")) return;

  const stamp = stampFrom(document.cookie);

  try {
    if (sessionStorage.getItem(PULLED) === stamp) return;
    sessionStorage.setItem(PULLED, stamp);
  } catch {
    // Without storage, fetch on every page.
  }

  pullCart().then((changed) => {
    if (changed) announceCart(cartCount());
  });
};
