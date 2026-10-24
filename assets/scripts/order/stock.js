// Keeps the product list honest while the page is open: asks
// /api/stock on load, when the tab comes back, when the network
// returns, every couple of minutes, and right before a submission.
// Stock is not optional (#333): the first load retries with a backoff,
// then shuts adding and paying behind a notice, keeps asking every 30
// seconds and opens again on the first good answer (lib/stock-gate.mjs).
// A row that sold out is marked out: hidden while Show is on "In
// stock", else greyed with its restock label and no way to add it
// (order/restock.js); a quantity above what is left is brought down
// and the customer is told.

import { clear, whileLoading } from "../utils/skeleton.js";
import { showRows } from "./restock.js";
import { ATTEMPT_MS, StockGate, withBackoff } from "./lib/stock-gate.mjs";
import { syncSchema } from "./schema.js";

// The first load may retry for about half a minute.
const FIRST_GIVE_UP_MS = 60_000;

export class Stock {
  // `onChange(notice)` is called after the cart changed under the
  // customer, with a sentence to show. `setQty(input, n)` is the
  // form's own setter, so the row's state follows. `inStockOnly()`
  // says whether Show is on "In stock". `onLock()` is called when
  // adding and paying open or shut.
  constructor(form, { onChange, setQty, inStockOnly, onLock }) {
    this.form = form;
    this.region = document.getElementById("order-catalog");
    this.callout = document.getElementById("order-stock-down");
    this.onChange = onChange;
    this.onLock = onLock || (() => {});
    this.gate = new StockGate();
    // The controls this class shut, to open them again.
    this.shut = new Set();
    this.starting = false;
    this.setQty = setQty || ((input, n) => { input.value = String(n); });
    this.inStockOnly = inStockOnly || (() => true);
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
    const retry = this.callout
      && this.callout.querySelector("[data-stock-retry]");

    if (retry) {
      retry.addEventListener("click", async () => {
        retry.disabled = true;
        await this.refresh();
        retry.disabled = false;
      });
    }
    this.schedule();
  }

  // The next look: every 30 seconds while shut, else every two
  // minutes, counted from the last one.
  schedule() {
    clearTimeout(this.timer);
    this.timer = setTimeout(async () => {
      if (document.visibilityState === "visible") await this.refresh();
      else this.schedule();
    }, this.gate.every);
  }

  // The first answer: the Add buttons wait under their skeletons
  // (#271), since one pressed now might be sold out. A failure retries
  // with a backoff while they show, and only then shuts the page.
  async first() {
    this.starting = true;

    const items = await whileLoading(this.region, () => withBackoff(
      () => this.fetchItems()
    ), {
      render: (answer) => this.take(answer),
      giveUpMs: FIRST_GIVE_UP_MS,
    });

    this.starting = false;
    if (!items) this.fail("stock.unavailable");
    this.schedule();

    return items;
  }

  // -> { sku: state }, or null.
  async fetchItems() {
    const res = await fetch("/api/stock", {
      cache: "no-store",
      signal: typeof AbortSignal.timeout === "function"
        ? AbortSignal.timeout(ATTEMPT_MS) : undefined,
    });

    return res.ok ? (await res.json()).items || {} : null;
  }

  // Nothing can be added or paid while stock is unknown or the notice
  // shows.
  get locked() {
    return this.gate.locked;
  }

  // A failed check. Shuts the page when the gate says so, and tells
  // the farm through the browser error reporter.
  fail(where, { final = false } = {}) {
    if (this.gate.bad({ final })) {
      this.show();
      try {
        if (window.nffReport) {
          window.nffReport("error", {
            where, error: "Stock could not be checked.",
          });
        }
      } catch {
        // Reporting is never the customer's problem.
      }
    }
  }

  // Brings the notice and the controls in line with the gate.
  show() {
    if (this.callout) this.callout.hidden = !this.gate.down;
    this.form.toggleAttribute("data-stock-down", this.gate.down);
    this.lock(this.gate.locked);
    this.onLock();
  }

  // The notice, brought into view: for a press that was refused.
  warn() {
    if (!this.gate.down || !this.callout) return;
    this.callout.scrollIntoView({ block: "center", behavior: "smooth" });
  }

  // Shuts Add, More and the quantity fields, or opens what this shut.
  // Fewer stays open: a customer can always take something out.
  lock(on) {
    if (on) {
      for (const el of this.form.querySelectorAll(
        "[data-step='1'], [data-qty]"
      )) {
        if (!el.disabled) {
          el.disabled = true;
          this.shut.add(el);
        }
      }
    } else {
      for (const el of this.shut) el.disabled = false;
      this.shut.clear();
    }
  }

  take(items) {
    // The first load's answer opens the gate as it renders.
    if (!this.gate.known || this.gate.down) {
      this.gate.good();
      this.show();
    }
    this.items = items;
    syncSchema(items);
    this.apply();
  }

  // -> the latest availability, or null when it cannot be fetched. A
  // good answer also ends a failed first load and opens the page. A
  // failure keeps the last known stock, unless it is the `final` check
  // before a submission (#333).
  async refresh({ final = false } = {}) {
    let items;

    try {
      items = await this.fetchItems();
    } catch {
      items = null;
    }
    this.schedule();
    if (!items) {
      // The first load is still retrying: it will say.
      if (!this.starting) {
        this.fail(final ? "stock.final_check" : "stock.unavailable",
          { final });
      }

      return null;
    }
    clear(this.region);
    this.take(items);

    return this.items;
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
      const held = this.held[sku] || 0;
      const inStock = state.inStock || held > 0;
      // An archived line can only keep what the order holds, and says
      // so: "Not available".
      const archived = row.hasAttribute("data-archived");
      const available = archived ? held
        : state.available === null ? null : state.available + held;

      const note = row.querySelector("[data-stock-note]");
      const qty = parseInt(input.value, 10) || 0;
      const label = row.querySelector("label").textContent.trim();
      let text = "";

      // Out of stock is never a sold-out row: hidden, or under Full
      // catalog its restock label (#267). Stock wins over the
      // label; an archived item has no row at all.
      row.toggleAttribute("data-out", !inStock);
      if (!inStock) {
        // The label is the disabled button in Add's place (#318).
        if (row.dataset.restockLabel) row.dataset.stock = "out";
        else delete row.dataset.stock;
        if (qty > 0) {
          this.setQty(input, 0);
          changed.push(`${label} sold out and was removed`);
        }
      } else if (archived) {
        delete row.dataset.stock;
        text = row.dataset.restockLabel;
        if (qty > available) this.setQty(input, available);
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

    showRows(this.form, this.inStockOnly());

    if (changed.length) {
      this.onChange(`Stock changed while you were shopping: ${
        changed.join("; ")}. Your cart was updated.`);
    }
  }
}
