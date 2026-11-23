// Live stock for site search (#908, James's rules 8 to 10). Search
// asks each time its field takes the focus, through the same
// /api/stock the order page asks, so both meet the same edge cache.
// On the order page it reads through the page's own reader
// (window.nffStock, order/stock.js), which shares the page's
// 15-second floor; anywhere else it keeps that floor itself. Search
// never polls.

const FLOOR_MS = 15_000;

let askedAt = -Infinity;
let items = null;
let asking = null;

// -> the items, or null when stock could not be had.
const ask = () => fetch("/api/stock", { cache: "no-store" })
  .then((res) => (res.ok ? res.json() : null))
  .then((body) => (body && body.items) || null)
  .catch(() => null);

// -> a promise of { sku: state }, or null: the index's stock word
// stands for search until live stock answers.
export const readStock = () => {
  const page = window.nffStock;

  if (page) return page.read();
  if (asking) return asking;
  if (Date.now() - askedAt < FLOOR_MS) return Promise.resolve(items);

  askedAt = Date.now();
  asking = ask().then((got) => {
    items = got;
    asking = null;

    return got;
  });

  return asking;
};
