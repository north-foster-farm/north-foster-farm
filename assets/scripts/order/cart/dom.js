// The cart's small helpers for the page (docs/refactors/cart.md,
// phase 1): finding its elements, restarting an animation, saying a
// line in a live region, and the reduced-motion setting.

export const qs = (root, selector) => root.querySelector(selector);
export const all = (root, selector) => Array.from(
  root.querySelectorAll(selector)
);

// Restarts a CSS animation by re-applying its class.
export const pulse = (el, className) => {
  el.classList.remove(className);
  void el.offsetWidth;
  el.classList.add(className);
};

export const reduced = () => matchMedia(
  "(prefers-reduced-motion: reduce)"
).matches;

// Says `text` in a live region; a repeated line must be heard again,
// so clear, then set.
export const say = (live, text) => {
  live.textContent = "";
  setTimeout(() => { live.textContent = text; }, 60);
};
