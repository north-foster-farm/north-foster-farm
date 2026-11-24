// The payment SDKs' scripts (docs/refactors/pay.md, phase 2): each URL
// the checkout config gives is appended to the head once, and every
// caller shares its promise. A script that fails to load is forgotten,
// so the next call tries again.

const loaded = new Map();

export const loadScript = (src) => {
  if (!loaded.has(src)) {
    loaded.set(src, new Promise((resolve, reject) => {
      const s = document.createElement("script");

      s.src = src;
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => {
        loaded.delete(src);
        reject(new Error(`Could not load ${src}`));
      };
      document.head.appendChild(s);
    }));
  }

  return loaded.get(src);
};
