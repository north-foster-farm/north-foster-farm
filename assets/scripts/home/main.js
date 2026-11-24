// The home page's own bundle: the delivery map's ZIP field (#214),
// and the "Three ways" Delivery card's terms for a signed-in account
// whose perks change the delivery fee or the minimum (#717, "Delivery
// terms for perk customers"). Signed out, or with no such perk, the
// card stays as built.

import "../zip-check/main.js";
import { drawTerms } from "../order/cart/perk-label.js";
import { me } from "../session/session.js";
import { stampFrom } from "../session/cache.js";

let tips = [];

const show = (who) => {
  const perks = who && who.signedIn && who.customer
    && Array.isArray(who.customer.perks) ? who.customer.perks : [];

  for (const tip of tips) tip.stop();
  tips = drawTerms(perks);
};

document.addEventListener("DOMContentLoaded", () => {
  if (!stampFrom(document.cookie)) return;
  me().then(show).catch(() => {});
});
