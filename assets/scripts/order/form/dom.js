// The order form's three DOM helpers (docs/refactors/order-form.md,
// phase 1). cart/dom.js holds the cart's own until both series have
// landed.

export const qs = (root, selector) => root.querySelector(selector);
export const all = (root, selector) => Array.from(
  root.querySelectorAll(selector)
);

// Restart a CSS animation by re-applying its class.
export const pulse = (el, className) => {
  el.classList.remove(className);
  void el.offsetWidth;
  el.classList.add(className);
};
