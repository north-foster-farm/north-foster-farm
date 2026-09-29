// Product search (partials/search/palette.html): a dialog with a
// combobox. Cmd or ctrl K opens and closes it, as does the header's
// search button; Escape and a click outside close it. Arrows move
// through the matches, the selected one's card shows beside them, and
// Enter or the card's Add puts one in the cart. Add then turns into
// the quantity in the cart, as on the order page, and taking it to 0
// takes the product out (#208).

import Dropdown from "bootstrap/js/dist/dropdown.js";
import { index, search } from "./match.js";
import { cartCount, inCart, setCart } from "./cart.js";
import { room as roomFor, soldOut as isSoldOut } from "./stock.js";

const STOCK_TTL = 60_000;

const money = (n) => `$${Number.isInteger(n) ? n : n.toFixed(2)}`;

// "Whole Chicken, 3.0 – 3.4 lbs".
const title = (p) => `${p.group}, ${p.label}`;

export const wireSearch = () => {
  const dialog = document.querySelector("[data-search-palette]");
  const opener = document.querySelector("[data-search-open]");

  if (!dialog || !opener) return;

  const q = (selector) => dialog.querySelector(selector);
  const input = q(".search-palette-input");
  const list = q(".search-palette-list");
  const empty = q("[data-search-empty]");
  const card = q("[data-search-card]");
  const img = q("[data-search-img]");
  const qtyWrap = q("[data-search-qty-state]");
  const qtyBox = q("[data-search-qty]");
  const addButton = q("[data-search-add]");
  const fewer = q("[data-search-step='-1']");
  const more = q("[data-search-step='1']");
  const added = q("[data-search-added]");
  const cartButton = q("[data-search-cart]");
  // The way to the cart, once there is one.
  const showCartButton = () => {
    cartButton.dataset.searchCart = cartCount() === 0 ? "empty" : "full";
  };
  const products = JSON.parse(q("[data-search-products]").textContent);
  const indexed = index(products);

  let matches = [];
  let active = -1;
  let stock = null;
  let stockAt = 0;

  // Live stock: { sku: { inStock, available } }, or null if unknown.
  const loadStock = async () => {
    if (stock && Date.now() - stockAt < STOCK_TTL) return;
    try {
      const res = await fetch("/api/stock", { cache: "no-store" });

      if (!res.ok) return;
      stock = (await res.json()).items || {};
      stockAt = Date.now();
      refreshStock();
    } catch {
      // The build's stock stands in.
    }
  };

  const soldOut = (p) => isSoldOut(stock, p.sku);

  // How many more of this product can go in the cart.
  const room = (p) => roomFor(stock, p.sku, inCart(p.sku));

  // The card's control as the cart has it: Add at 0, else the stepper
  // holding the quantity, its + gone quiet when there is no more room.
  const syncQty = (p) => {
    const have = inCart(p.sku);
    const state = have > 0 ? "active" : "empty";

    if (qtyWrap.dataset.searchQtyState !== state) {
      qtyWrap.dataset.searchQtyState = state;
    }
    qtyBox.value = String(have);
    addButton.disabled = room(p) === 0;
    more.disabled = room(p) === 0;
    fewer.setAttribute("aria-label", have === 1 ? "Remove" : "One fewer");
    showCartButton();
  };

  const showCard = (p) => {
    if (!p) {
      card.hidden = true;

      return;
    }
    card.hidden = false;
    img.src = p.image || (p.key === "eggs"
      ? dialog.dataset.egg : dialog.dataset.hen);
    img.classList.toggle("is-photo", !!p.image);
    q("[data-search-name]").textContent = p.label;
    q("[data-search-group]").textContent = p.group;
    q("[data-search-price]").textContent =
      `${money(p.price)}${p.unit ? ` ${p.unit}` : ""}` +
      `${p.note ? ` · ${p.note}` : ""}`;
    syncQty(p);
  };

  const select = (i, { scroll = true } = {}) => {
    const rows = [...list.children];

    active = matches.length ? Math.max(0, Math.min(matches.length - 1, i))
      : -1;
    rows.forEach((row, n) => {
      row.setAttribute("aria-selected", String(n === active));
    });
    if (active === -1) {
      input.removeAttribute("aria-activedescendant");
      showCard(null);

      return;
    }
    input.setAttribute("aria-activedescendant", rows[active].id);
    if (scroll) rows[active].scrollIntoView({ block: "nearest" });
    added.textContent = "";
    showCard(matches[active]);
  };

  // A row's sold-out mark and its price, or "Sold out" in its place.
  const markRow = (row, p) => {
    if (soldOut(p)) row.dataset.stock = "out";
    else delete row.dataset.stock;
    row.querySelector(".search-palette-row-price").textContent =
      soldOut(p) ? "Sold out" : money(p.price);
  };

  const render = (query) => {
    matches = search(indexed, query);
    list.replaceChildren(...matches.map((p, i) => {
      const row = document.createElement("li");
      const name = document.createElement("span");
      const group = document.createElement("strong");
      const price = document.createElement("span");

      row.id = `search-option-${i}`;
      row.setAttribute("role", "option");
      row.dataset.sku = p.sku;
      name.className = "search-palette-row-name";
      group.textContent = p.group;
      // A dot between them: weight alone can't part "Eggs Large".
      name.append(group, ` · ${p.label}`);
      price.className = "search-palette-row-price";
      row.append(name, price);
      markRow(row, p);

      return row;
    }));

    const trimmed = query.trim();

    empty.hidden = matches.length > 0;
    empty.textContent = `Nothing matches “${trimmed}”. Try eggs, whole, ` +
      "breast or wings.";
    list.hidden = !matches.length;
    select(0, { scroll: false });
  };

  // Stock has come in: mark the rows, and the card's + and Add. What
  // the customer has in the cart stays as it is.
  const refreshStock = () => {
    [...list.children].forEach((row, i) => markRow(row, matches[i]));
    if (matches[active]) syncQty(matches[active]);
  };

  // Puts n of the selected product in the cart, no more than stock
  // allows, and says so to a screen reader. -> false if it couldn't.
  const setTo = (n) => {
    const p = matches[active];

    if (!p) return false;

    const have = inCart(p.sku);
    const now = setCart(p.sku, Math.min(n, have + room(p)));

    if (now === null) {
      added.textContent = "That's no longer on the order page. Reload it " +
        "to see what's available.";

      return false;
    }

    const count = cartCount();
    const items = `${count} ${count === 1 ? "item" : "items"}`;

    added.textContent = now > 0
      ? `${now} × ${title(p)} in your cart. ${items} in all.`
      : `Removed ${title(p)}. ${items} in your cart.`;
    syncQty(p);

    return true;
  };

  // Enter in the field, or Add: one more.
  const add = () => {
    const p = matches[active];

    if (!p || room(p) === 0) return false;

    return setTo(inCart(p.sku) + 1);
  };

  const isOpen = () => dialog.open;

  // A close under way: its transitionend listener and the fallback
  // timer, both dropped once it finishes or the palette reopens, so
  // neither can shut a palette opened after it.
  let closing = null;

  const settle = () => {
    if (!closing) return;
    clearTimeout(closing.timer);
    dialog.removeEventListener("transitionend", closing.done);
    closing = null;
  };

  const open = () => {
    // Asked for again while fading out: fade back in instead.
    if (closing) {
      settle();
      dialog.classList.add("is-open");
      opener.setAttribute("aria-expanded", "true");
      input.focus();
      return;
    }
    if (isOpen()) return;
    dialog.showModal();
    requestAnimationFrame(() => dialog.classList.add("is-open"));
    opener.setAttribute("aria-expanded", "true");
    input.value = "";
    render("");
    showCartButton();
    input.focus();
    loadStock();
  };

  // Closes, then runs then(), if given, once the palette is gone.
  const close = (then) => {
    if (!isOpen() || !dialog.classList.contains("is-open")) return;
    dialog.classList.remove("is-open");
    opener.setAttribute("aria-expanded", "false");

    const done = () => {
      settle();
      dialog.close();
      opener.focus();
      then?.();
    };

    if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
      done();
    } else {
      dialog.addEventListener("transitionend", done, { once: true });
      // In case the transition never ends (a hidden tab).
      closing = { done, timer: setTimeout(done, 400) };
    }
  };

  // Open, or close; a palette fading out counts as closed.
  const toggle = () => (isOpen() && !closing ? close() : open());

  opener.addEventListener("click", toggle);
  q("[data-search-close]").addEventListener("click", () => close());

  // On the order page, the cart on the page, opened if folded; anywhere
  // else, the header's cart.
  cartButton.addEventListener("click", () => close(() => {
    const pageCart = document.getElementById("order-cart");

    if (pageCart) {
      if (pageCart.dataset.open === "false") {
        pageCart.querySelector("[data-cart-toggle]")?.click();
      }
      pageCart.scrollIntoView({ block: "nearest" });

      return;
    }

    const toggle = document.querySelector("[data-cart-toggle]");

    if (toggle) Dropdown.getOrCreateInstance(toggle).show();
  }));

  document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      toggle();
    }
  });

  // Escape: close with the animation rather than at once.
  dialog.addEventListener("cancel", (e) => {
    e.preventDefault();
    close();
  });

  // A click on the backdrop, outside the panel.
  dialog.addEventListener("click", (e) => {
    if (e.target === dialog) close();
  });

  input.addEventListener("input", () => render(input.value));
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      select(active + (e.key === "ArrowDown" ? 1 : -1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      add();
    }
  });

  // A click on a row keeps the keyboard in the field, as a combobox
  // should; a tap doesn't, or the phone's keyboard would rise over the
  // card each time (#208).
  let pointer = "mouse";

  list.addEventListener("pointerdown", (e) => {
    pointer = e.pointerType;
  });
  list.addEventListener("click", (e) => {
    const row = e.target.closest("[role='option']");

    if (!row) return;
    select([...list.children].indexOf(row), { scroll: false });
    if (pointer === "mouse") input.focus();
  });

  // Add hands the focus to its +, and a step to 0 hands it back to
  // Add, so the keyboard stays on the control that is showing.
  addButton.addEventListener("click", () => {
    if (add()) more.focus();
  });
  fewer.addEventListener("click", () => {
    const p = matches[active];

    if (p && setTo(inCart(p.sku) - 1) && inCart(p.sku) === 0) {
      addButton.focus();
    }
  });
  more.addEventListener("click", () => add());

  // A typed quantity counts once it is left or entered; blank or 0
  // takes the product out.
  const typed = () => {
    const p = matches[active];

    if (!p) return;

    const n = parseInt(qtyBox.value.replace(/\D/g, ""), 10);

    setTo(Number.isFinite(n) ? n : 0);
    if (inCart(p.sku) === 0) addButton.focus();
  };

  qtyBox.addEventListener("change", typed);
  qtyBox.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      typed();
    }
  });
};
