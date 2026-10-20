// Show "In stock" or "Full catalog" over the product list (#267,
// 6303649455). In stock, the default, is what can be bought now. Full
// catalog also shows what is out of stock, greyed, with its restock
// label ("Back in spring") and no way to add it; a row with no
// restock type stays hidden while it is out. The choice is
// remembered on this device.
//
// A row's stock is its `data-out` attribute, set by the build from
// the catalog and by order/stock.js from /api/stock; this only
// decides what shows.

export const KEY = "nff-order-in-stock-only";

// -> true unless this device chose Full catalog. Storage can be
// blocked or missing (a private window); the default stands then.
export const inStockOnly = () => {
  try {
    return localStorage.getItem(KEY) !== "off";
  } catch {
    return true;
  }
};

const remember = (on) => {
  try {
    localStorage.setItem(KEY, on ? "on" : "off");
  } catch {
    // Not remembered; the choice still works for this visit.
  }
};

// Shows and hides rows for the choice, then a category left with no
// row, and its link in the sidebar.
export const showRows = (form, only = inStockOnly()) => {
  for (const row of form.querySelectorAll(".order-item")) {
    const out = row.hasAttribute("data-out");

    row.hidden = out && (only || !row.dataset.restockLabel);
  }
  for (const group of form.querySelectorAll(".order-cat")) {
    const empty = !group.querySelector(".order-item:not([hidden])");
    const link = document.querySelector(
      `#order-nav a[href="#${CSS.escape(group.id)}"]`
    );

    group.hidden = empty;
    if (link) link.closest(".nav-item").hidden = empty;
  }
};

// Wires the two radios. -> a function that says whether In stock is
// the one chosen.
export const wireSwitch = (form) => {
  const stock = form.querySelector("[data-show][value='stock']");
  const all = form.querySelector("[data-show][value='all']");

  if (!stock || !all) return () => true;

  const only = () => stock.checked;

  (inStockOnly() ? stock : all).checked = true;
  // The form listens for input and change to save the draft and
  // revalidate; this choice is neither an order field nor a draft one.
  for (const radio of [stock, all]) {
    radio.addEventListener("input", (e) => e.stopPropagation());
    radio.addEventListener("change", (e) => {
      e.stopPropagation();
      remember(only());
      showRows(form, only());
    });
  }
  showRows(form, only());

  return only;
};
