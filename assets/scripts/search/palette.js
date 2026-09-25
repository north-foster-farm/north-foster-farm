// Product search (partials/search/palette.html): a dialog with a
// combobox. Cmd or ctrl K opens and closes it, as does the header's
// search button; Escape and a click outside close it. Arrows move
// through the matches, the selected one's card shows beside them, and
// Enter or the card's button adds it to the cart.

import { index, search } from "./match.js";
import { addToCart, cartCount, inCart } from "./cart.js";
import {
  MAX, fitQty, room as roomFor, soldOut as isSoldOut, stockText,
} from "./stock.js";

const STOCK_TTL = 60_000;
const ADDED_MS = 1800;

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
  const qtyBox = q("[data-search-qty]");
  const addForm = q("[data-search-add]");
  const addButton = q("[data-search-button]");
  const added = q("[data-search-added]");
  const products = JSON.parse(q("[data-search-products]").textContent);
  const indexed = index(products);

  let matches = [];
  let active = -1;
  let stock = null;
  let stockAt = 0;
  let addedTimer = null;

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

  const qty = () => {
    const n = parseInt(qtyBox.value.replace(/\D/g, ""), 10);

    return Number.isFinite(n) ? n : 1;
  };

  const setQty = (n) => {
    const p = matches[active];

    qtyBox.value = String(fitQty(n, p ? room(p) : MAX));
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
    q("[data-search-stock]").textContent = stockText(stock, p.sku);
    card.dataset.stock = soldOut(p) ? "out" : "in";
    addButton.disabled = room(p) === 0;
    setQty(qty());
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
    qtyBox.value = "1";
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
      name.append(group, ` ${p.label}`);
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

  // Stock has come in: mark the rows and the card where they stand. The
  // customer may have chosen a quantity or added already, so the
  // quantity stays, lowered only to what is left, and so does "Added".
  const refreshStock = () => {
    [...list.children].forEach((row, i) => markRow(row, matches[i]));
    if (matches[active]) showCard(matches[active]);
  };

  const add = () => {
    const p = matches[active];

    if (!p || room(p) === 0) return;

    const n = Math.min(qty(), room(p));
    const now = addToCart(p.sku, n);

    if (now === null) {
      added.textContent = "That's no longer on the order page. Reload it " +
        "to see what's available.";

      return;
    }

    const count = cartCount();

    added.textContent = `Added ${n} × ${title(p)}. ` +
      `${count} ${count === 1 ? "item" : "items"} in your cart.`;
    addButton.textContent = `Added · ${count} in cart`;
    clearTimeout(addedTimer);
    addedTimer = setTimeout(() => {
      addButton.textContent = "Add to cart";
    }, ADDED_MS);
    showCard(p);
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
    input.focus();
    loadStock();
  };

  const close = () => {
    if (!isOpen() || !dialog.classList.contains("is-open")) return;
    dialog.classList.remove("is-open");
    opener.setAttribute("aria-expanded", "false");

    const done = () => {
      settle();
      dialog.close();
      opener.focus();
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
  q("[data-search-close]").addEventListener("click", close);

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

  list.addEventListener("click", (e) => {
    const row = e.target.closest("[role='option']");

    if (!row) return;
    select([...list.children].indexOf(row), { scroll: false });
    input.focus();
  });

  q(".search-palette-qty").addEventListener("click", (e) => {
    const step = e.target.closest("[data-search-step]");

    if (step) setQty(qty() + Number(step.dataset.searchStep));
  });
  qtyBox.addEventListener("change", () => setQty(qty()));
  addForm.addEventListener("submit", (e) => {
    e.preventDefault();
    add();
  });
};
