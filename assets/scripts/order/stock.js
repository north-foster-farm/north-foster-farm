// Keeps the product list honest while the page is open: asks
// /api/stock on load, when the tab comes back, when the network
// returns, every couple of minutes, and right before a submission.
// A row that sold out is closed; a quantity above what is left is
// brought down and the customer is told.

import { clear, whileLoading } from "../utils/skeleton.js";

const EVERY = 2 * 60_000;

export class Stock {
  // `onChange(notice)` is called after the cart changed under the
  // customer, with a sentence to show. `setQty(input, n)` is the
  // form's own setter, so the row's state follows.
  constructor(form, { onChange, setQty }) {
    this.form = form;
    this.region = document.getElementById("order-catalog");
    this.onChange = onChange;
    this.setQty = setQty || ((input, n) => { input.value = String(n); });
    this.items = null;
    this.timer = null;
    // Packs a paid order being changed (?edit=) already holds: they
    // count as available, so a line that sold out since can stay.
    this.held = {};
  }

  start() {
    this.first();
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") this.refresh();
    });
    window.addEventListener("online", () => this.refresh());
    this.timer = setInterval(() => {
      if (document.visibilityState === "visible") this.refresh();
    }, EVERY);
  }

  // The first answer, and a Try again: the Add buttons wait under
  // their skeletons (#271), since one pressed now might be sold out.
  first() {
    return whileLoading(this.region, () => this.fetchItems(), {
      render: (items) => this.take(items),
      retry: () => this.first(),
    });
  }

  // -> { sku: state }, or null.
  async fetchItems() {
    const res = await fetch("/api/stock", { cache: "no-store" });

    return res.ok ? (await res.json()).items || {} : null;
  }

  take(items) {
    this.items = items;
    this.apply();
  }

  // -> the latest availability, or null when it cannot be fetched. A
  // good answer also ends a failed first load.
  async refresh() {
    try {
      const items = await this.fetchItems();

      if (!items) return null;
      clear(this.region);
      this.take(items);

      return this.items;
    } catch {
      return null;
    }
  }

  state(sku) {
    return this.items ? this.items[sku] : null;
  }

  // Marks rows and clamps quantities. Reports what changed.
  apply() {
    if (!this.items) return;

    const changed = [];

    for (const input of this.form.querySelectorAll("[data-qty]")) {
      const sku = input.dataset.qty;
      const state = this.items[sku];

      if (!state) continue;

      const held = this.held[sku] || 0;
      const inStock = state.inStock || held > 0;
      const available = state.available === null ? null
        : state.available + held;

      const row = input.closest(".order-item");
      const note = row.querySelector("[data-stock-note]");
      const qty = parseInt(input.value, 10) || 0;
      const label = row.querySelector("label").textContent.trim();
      let text = "";

      if (!inStock) {
        row.dataset.stock = "out";
        text = "Sold out";
        if (qty > 0) {
          this.setQty(input, 0);
          changed.push(`${label} sold out and was removed`);
        }
      } else if (available !== null && available <= 5) {
        row.dataset.stock = "low";
        text = available === 1 ? "1 left" : `${available} left`;
        if (qty > available) {
          this.setQty(input, available);
          changed.push(`only ${available} of ${label} left`);
        }
      } else {
        delete row.dataset.stock;
      }

      for (const button of row.querySelectorAll("[data-step]")) {
        button.disabled = !inStock;
      }
      input.disabled = !inStock;
      if (note && note.textContent !== text) note.textContent = text;
    }

    if (changed.length) {
      this.onChange(`Stock moved while you were shopping: ${
        changed.join("; ")}. Your cart was updated.`);
    }
  }
}
