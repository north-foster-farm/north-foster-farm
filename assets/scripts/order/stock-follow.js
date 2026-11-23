// How the order page follows stock between its first load and the
// check before paying (#908, James's rules of 2026-11-23): what asks,
// under one 15-second floor, and when it all stops (lib/stock-rhythm.mjs).
// The customer's interactions arrive as nudge() (stock-nudges.js); the
// tab shown again and the network back check; any pointer, key, touch
// or scroll is input; the background check is the Stock's own timer,
// whose turn is tick(). Five minutes without input stops every check
// until the next input or the tab shown again. Site search on this
// page reads through read().

import { StockRhythm } from "./lib/stock-rhythm.mjs";

// What counts as the customer still there (rule 4).
const INPUTS = ["pointerdown", "keydown", "touchstart", "scroll"];

export class StockFollower {
  // `stock` is the page's Stock (stock.js): its first load, its
  // answer in hand and its refresh() and schedule().
  constructor(stock) {
    this.stock = stock;
    this.rhythm = new StockRhythm();
    // The check out now, if any.
    this.asking = null;
  }

  listen() {
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState !== "visible") return;
      this.rhythm.input();
      this.check();
    });
    // The network back is no input: an idle page stays stopped.
    window.addEventListener("online", () => {
      if (!this.rhythm.idle) this.check();
    });
    for (const type of INPUTS) {
      window.addEventListener(type, () => this.input(), { passive: true });
    }
  }

  // The background timer's turn: nothing once idle, a check while the
  // tab shows and the first load is done, else the next turn.
  tick() {
    if (this.rhythm.idle) return;

    const visible = document.visibilityState === "visible";

    if (visible && !this.stock.starting) this.check();
    else this.stock.schedule();
  }

  // Input: a page that had gone idle checks at once, which starts its
  // rhythm again.
  input() {
    if (this.rhythm.input()) this.check();
  }

  // An interaction that should check stock. -> the items.
  nudge() {
    this.rhythm.input();

    return this.check();
  }

  // Stock for a reader on this page. -> the items, or null.
  async read() {
    return (await this.check()) || this.stock.items;
  }

  // A check under the shared floor: while the first load runs, or a
  // check is out, or inside 15 s of the last, the answer in hand
  // stands. -> the items, or null.
  check() {
    const { stock } = this;

    if (stock.starting) return stock.loading.then(() => stock.items);
    if (this.asking) return this.asking;
    if (this.rhythm.fresh) return Promise.resolve(stock.items);

    const asking = stock.refresh();

    this.asking = asking;
    asking.finally(() => {
      if (this.asking === asking) this.asking = null;
    });

    return asking;
  }
}
