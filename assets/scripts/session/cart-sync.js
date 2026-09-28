// A signed-in customer's cart on every device (#149). A change to the
// cart draft goes to the account a moment later, or at once when the
// page is left. The account's copy is fetched once per tab and sign-in,
// and by the order page before it restores the draft; whichever copy
// was saved last wins (order/lib/cart-sync.mjs). A guest's cart never
// leaves the browser.

import { announceCart } from "../cart-badge/announce.js";
import { Draft } from "../order/draft.js";
import { cartOf, settle } from "../order/lib/cart-sync.mjs";
import { cartCount } from "../search/cart.js";
import { api } from "../utils/api.js";
import { stampFrom } from "./cache.js";

const PATH = "/api/account/cart";
const DELAY = 1500;
const PULLED = "nff-cart-pulled";

// The stamp cookie says whether anyone is signed in, without asking.
const signedIn = () => !!stampFrom(document.cookie);

let timer = null;

// What goes up: the cart, or word that it was cleared (an order placed).
const copyOf = (draft) => {
  const current = draft.current();

  return current.payload
    ? { payload: cartOf(current.payload), savedAt: current.savedAt }
    : { payload: null, savedAt: Date.now() };
};

const push = async ({ keepalive = false } = {}) => {
  clearTimeout(timer);
  timer = null;
  if (!signedIn()) return;

  const draft = new Draft();
  const sent = copyOf(draft);
  const { ok, data } = await api(PATH, {
    method: "PUT", body: sent, keepalive,
  }).catch(() => ({}));

  // The account may keep an earlier time than this device's clock
  // gave; take it, unless the draft changed meanwhile.
  if (ok && data.kept && sent.payload
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
// account's copy replaced this device's.
export const pullCart = async ({ timeout = 2000 } = {}) => {
  if (!signedIn()) return false;

  const draft = new Draft();
  const before = draft.current().savedAt;
  const answer = await Promise.race([
    api(PATH).catch(() => ({})),
    new Promise((resolve) => {
      setTimeout(() => resolve({}), timeout);
    }),
  ]);

  if (!answer.ok || !answer.data) return false;

  // A change made while the answer was on its way is newer than it,
  // and on its way up already.
  if (draft.current().savedAt !== before) return false;

  const local = draft.load();
  const remote = answer.data.cart;
  const winner = settle(local, remote);

  if (winner === "local") push();
  if (winner !== "remote" || (!remote.payload && !local)) return false;

  draft.adopt(remote);

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

  if (document.getElementById("order-form") || !signedIn()) return;

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
