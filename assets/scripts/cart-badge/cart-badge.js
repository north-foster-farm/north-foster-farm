// The cart count in the header: on the cart link beside Order in the
// row, and on the Order link in the phone menu. The cart link shows
// only while the cart holds something (#402). The order page announces
// its count each time it draws the cart, and product search announces
// an add, both as an "nff:cart" event; otherwise the count comes from
// the saved draft, read again when another tab changes storage or the
// page returns from the back button's cache.

import { cartCount } from "../search/cart.js";

const MAX = 99;

const itemsText = (n) => `${n} item${n === 1 ? "" : "s"}`;

export const wireCartBadge = () => {
  const badges = [...document.querySelectorAll("[data-cart-badge]")];
  const link = document.querySelector("[data-cart-link]");

  if (!badges.length) return;

  const show = (count) => {
    const n = Math.max(0, Math.floor(Number(count) || 0));

    for (const badge of badges) {
      const order = badge.closest("a:not([data-cart-link])");

      badge.hidden = n === 0;
      badge.textContent = n > MAX ? `${MAX}+` : String(n);
      // The cart link's badge sits in the link, which names itself
      // below.
      if (!order) continue;
      if (n) {
        order.setAttribute("aria-label", `Order, ${itemsText(n)} in your cart`);
      } else {
        order.removeAttribute("aria-label");
      }
    }
    if (!link) return;
    link.hidden = n === 0;
    link.setAttribute("aria-label",
      n ? `Your cart, ${itemsText(n)}` : "Your cart");
  };

  show(cartCount());
  document.addEventListener("nff:cart", (e) => show(e.detail.count));
  window.addEventListener("storage", () => show(cartCount()));
  window.addEventListener("pageshow", (e) => {
    if (e.persisted) show(cartCount());
  });
};
