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

// The row a search result links to, /order/#<sku in lower case>
// (#402), until it is in view: brought there, with Full catalog chosen
// when only that shows it. It is held until live stock first answers,
// since stock can hide a row after load (order/stock.js, settle()).
let wanted = null;

const reveal = (form) => {
  const row = wanted;

  if (!row) return;

  const all = form.querySelector("[data-show][value='all']");

  if (row.hidden && row.dataset.restockLabel && all && !all.checked) {
    // Not remembered: the customer did not choose it.
    all.checked = true;
    showRows(form, false);

    return;
  }
  if (!row.hidden) {
    row.scrollIntoView({ block: "center" });
    row.focus({ preventScroll: true });
  }
};

const want = (form) => {
  const id = decodeURIComponent(location.hash.slice(1));

  wanted = id ? form.querySelector(`.order-item[id="${CSS.escape(id)}"]`)
    : null;
  reveal(form);
};

// Live stock has answered: the row stays where it is from now on.
export const settle = () => {
  wanted = null;
};

// Shows and hides rows for the choice, then a category left with no
// row, and its link in the sidebar.
export const showRows = (form, only = inStockOnly()) => {
  for (const row of form.querySelectorAll(".order-item")) {
    const out = row.hasAttribute("data-out");

    // An archived row shows only while a paid order being changed
    // holds it (order/archived.html).
    row.hidden = row.hasAttribute("data-archived")
      ? !row.hasAttribute("data-held")
      : out && (only || !row.dataset.restockLabel);
  }
  for (const group of form.querySelectorAll(".order-cat")) {
    const empty = !group.querySelector(".order-item:not([hidden])");
    const link = document.querySelector(
      `#order-nav a[href="#${CSS.escape(group.id)}"]`
    );

    group.hidden = empty;
    if (link) link.closest(".nav-item").hidden = empty;
  }
  reveal(form);
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
      settle();
      remember(only());
      showRows(form, only());
    });
  }
  showRows(form, only());
  want(form);
  window.addEventListener("hashchange", () => want(form));

  return only;
};
