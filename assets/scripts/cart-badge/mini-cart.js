// What the header's cart half opens: the saved draft's lines, named
// and priced from the catalog that product search carries on every
// page, and their subtotal. Drawn afresh each time it opens, so it is
// never behind an add, another tab or the order page. Delivery, tiers
// and discounts are the order page's; this only adds up prices.

import { Draft } from "../order/draft.js";

const money = (d) => (Number.isInteger(d) ? `$${d}` : `$${d.toFixed(2)}`);

const catalog = () => {
  const el = document.querySelector("[data-search-products]");

  try {
    return new Map(JSON.parse(el.textContent).map((p) => [p.sku, p]));
  } catch {
    return new Map();
  }
};

export const wireMiniCart = () => {
  const menu = document.querySelector("[data-cart-menu]");

  if (!menu) return;

  const list = menu.querySelector("[data-mini-cart-lines]");
  const groupTemplate = menu.querySelector("[data-mini-cart-group]");
  const lineTemplate = menu.querySelector("[data-mini-cart-line]");
  const subtotal = menu.querySelector("[data-mini-cart-subtotal]");
  const panel = menu.querySelector(".site-mini-cart");
  const row = menu.closest(".site-header-inner");
  const phone = matchMedia("(max-width: 575.98px)");
  let products = null;

  // On a phone the panel sits on the page's gutters, as wide as the
  // order page's cart (#203): from the header row's left content edge
  // to its right one, whatever hangs it at the cart button.
  const place = () => {
    if (!phone.matches || !row) {
      panel.style.removeProperty("--mini-cart-right");
      panel.style.removeProperty("--mini-cart-width");

      return;
    }

    const box = row.getBoundingClientRect();
    const style = getComputedStyle(row);
    const left = box.left + parseFloat(style.paddingLeft);
    const right = box.right - parseFloat(style.paddingRight);
    const anchor = menu.getBoundingClientRect().right;

    panel.style.setProperty("--mini-cart-right", `${anchor - right}px`);
    panel.style.setProperty("--mini-cart-width", `${right - left}px`);
  };

  window.addEventListener("resize", place);
  menu.addEventListener("show.bs.dropdown", place);

  menu.addEventListener("show.bs.dropdown", () => {
    const saved = new Draft().load();
    const lines = (saved && saved.payload && saved.payload.lines) || [];

    products ||= catalog();
    list.replaceChildren();

    // In catalog order, each group under its own heading, as the
    // order page's cart shows them: the name never has to share a
    // row with its group, so no line wraps (#207).
    const skus = [...products.keys()];
    const shown = lines
      .map((line) => ({
        p: products.get(line.sku), qty: Number(line.qty) || 0,
        at: skus.indexOf(line.sku),
      }))
      .filter(({ p, qty }) => p && qty >= 1)
      .sort((a, b) => a.at - b.at);
    let items = null;
    let group = null;
    let sum = 0;

    for (const { p, qty } of shown) {
      if (p.group !== group) {
        const g = groupTemplate.content.cloneNode(true);

        g.querySelector("[data-mini-cart-heading]").textContent = p.group;
        items = g.querySelector("[data-mini-cart-items]");
        list.append(g);
        group = p.group;
      }

      const li = lineTemplate.content.cloneNode(true);
      const set = (name, text) => {
        li.querySelector(`[data-mini-cart-${name}]`).textContent = text;
      };

      set("label", p.label);
      set("qty", `× ${qty}`);
      set("price", money(p.price * qty));
      items.append(li);
      sum += p.price * qty;
    }
    subtotal.textContent = money(sum);
  });
};
