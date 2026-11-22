// What the cart view reads from and writes to the page's styles
// (docs/refactors/cart-view.md).

export const reduced = () => matchMedia(
  "(prefers-reduced-motion: reduce)"
).matches;

export const rootFont = () => parseFloat(
  getComputedStyle(document.documentElement).fontSize
) || 16;

export const prop = (el, name) => el.style.getPropertyValue(name);

export const setProp = (el, name, px) => {
  const next = `${Math.round(px)}px`;

  if (prop(el, name) !== next) el.style.setProperty(name, next);
};
