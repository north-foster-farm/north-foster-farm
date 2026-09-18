// Keeps the product list honest while the page is open: asks
// /api/stock on load, when the tab comes back, when the network
// returns, every couple of minutes, and right before a submission.
// A row that sold out is closed; a quantity above what is left is
// brought down and the customer is told.

const EVERY = 2 * 60_000;

export class Stock {
  // `onChange(notice)` is called after the cart changed under the
  // customer, with a sentence to show. `setQty(input, n)` is the
  // form's own setter, so the row's state follows.
  constructor(form, { onChange, setQty }) {
    this.form = form;
    this.onChange = onChange;
    this.setQty = setQty || ((input, n) => { input.value = String(n); });
    this.items = null;
    this.timer = null;
  }

  start() {
    this.refresh();
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") this.refresh();
    });
    window.addEventListener("online", () => this.refresh());
    this.timer = setInterval(() => {
      if (document.visibilityState === "visible") this.refresh();
    }, EVERY);
  }

  // -> the latest availability, or null when it cannot be fetched.
  async refresh() {
    try {
      const res = await fetch("/api/stock", { cache: "no-store" });

      if (!res.ok) return null;

      const data = await res.json();

      this.items = data.items || {};
      this.apply();

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

      const row = input.closest(".order-item");
      const note = row.querySelector("[data-stock-note]");
      const qty = parseInt(input.value, 10) || 0;
      const label = row.querySelector("label").textContent.trim();
      let text = "";

      if (!state.inStock) {
        row.dataset.stock = "out";
        text = "Sold out";
        if (qty > 0) {
          this.setQty(input, 0);
          changed.push(`${label} sold out and was removed`);
        }
      } else if (state.available !== null && state.available <= 5) {
        row.dataset.stock = "low";
        text = state.available === 1 ? "1 left" : `${state.available} left`;
        if (qty > state.available) {
          this.setQty(input, state.available);
          changed.push(`only ${state.available} of ${label} left`);
        }
      } else {
        delete row.dataset.stock;
      }

      for (const button of row.querySelectorAll("[data-step]")) {
        button.disabled = !state.inStock;
      }
      input.disabled = !state.inStock;
      if (note && note.textContent !== text) note.textContent = text;
    }

    if (changed.length) {
      this.onChange(`Stock moved while you were shopping: ${
        changed.join("; ")}. Your cart was updated.`);
    }
  }
}
