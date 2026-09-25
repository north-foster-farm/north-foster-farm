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
  const template = menu.querySelector("[data-mini-cart-line]");
  const subtotal = menu.querySelector("[data-mini-cart-subtotal]");
  let products = null;

  menu.addEventListener("show.bs.dropdown", () => {
    const saved = new Draft().load();
    const lines = (saved && saved.payload && saved.payload.lines) || [];

    products ||= catalog();
    list.replaceChildren();

    let sum = 0;

    for (const line of lines) {
      const p = products.get(line.sku);
      const qty = Number(line.qty) || 0;

      if (!p || qty < 1) continue;

      const li = template.content.cloneNode(true);
      const set = (name, text) => {
        li.querySelector(`[data-mini-cart-${name}]`).textContent = text;
      };

      set("group", p.group);
      set("label", p.label);
      set("qty", `× ${qty}`);
      set("price", money(p.price * qty));
      list.append(li);
      sum += p.price * qty;
    }
    subtotal.textContent = money(sum);
  });
};
