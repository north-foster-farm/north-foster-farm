// The cart count in the header: on the cart half of the Order button
// in the row, and on the Order link in the phone menu. The cart half
// shows only while the cart holds something. The order page announces
// its count each time it draws the cart, and product search announces
// an add, both as an "nff:cart" event; otherwise the count comes from
// the saved draft, read again when another tab changes storage or the
// page returns from the back button's cache.

import Dropdown from "bootstrap/js/dist/dropdown.js";

import { cartCount } from "../search/cart.js";

const MAX = 99;

const itemsText = (n) => `${n} item${n === 1 ? "" : "s"}`;

export const wireCartBadge = () => {
  const badges = [...document.querySelectorAll("[data-cart-badge]")];
  const menu = document.querySelector("[data-cart-menu]");
  const toggle = document.querySelector("[data-cart-toggle]");

  if (!badges.length) return;

  const show = (count) => {
    const n = Math.max(0, Math.floor(Number(count) || 0));

    for (const badge of badges) {
      const link = badge.closest("a");

      badge.hidden = n === 0;
      badge.textContent = n > MAX ? `${MAX}+` : String(n);
      // On the order page Order is not a link, and the cart beside it
      // says the count; the cart half names itself below.
      if (!link) continue;
      if (n) {
        link.setAttribute("aria-label", `Order, ${itemsText(n)} in your cart`);
      } else {
        link.removeAttribute("aria-label");
      }
    }
    if (!menu) return;
    if (!n) Dropdown.getInstance(toggle)?.hide();
    menu.hidden = n === 0;
    toggle.setAttribute("aria-label",
      n ? `Your cart, ${itemsText(n)}` : "Your cart");
  };

  show(cartCount());
  document.addEventListener("nff:cart", (e) => show(e.detail.count));
  window.addEventListener("storage", () => show(cartCount()));
  window.addEventListener("pageshow", (e) => {
    if (e.persisted) show(cartCount());
  });
};
