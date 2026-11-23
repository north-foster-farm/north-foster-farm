// The first Add of a browser session (#278), which the cart teaches
// (docs/refactors/cart.md, phase 1).

// True once per browser session; the session's own storage, so a new
// page keeps the count and a new visit starts it over.
let addedBefore = false;

export const firstAdd = () => {
  const key = "nff-cart-first-add";

  try {
    if (sessionStorage.getItem(key)) return false;
    sessionStorage.setItem(key, "1");

    return true;
  } catch {
    const first = !addedBefore;

    addedBefore = true;

    return first;
  }
};
