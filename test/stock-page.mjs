// The least of a DOM the order page's Stock class reads
// (assets/scripts/order/stock.js), for the tests that build one
// without a browser: a region for the skeleton, a form with no rows,
// a document with no callout, and one row. Shared by
// stock-ready.test.mjs, eggs-counted.test.mjs and #908's stock-follow
// tests.

export const element = () => ({
  nodeType: 1,
  dataset: {},
  hidden: false,
  setAttribute() {},
  removeAttribute() {},
  toggleAttribute() {},
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener() {},
});

// One order page row that order/stock.js marks, as order/row.html
// writes it: `sku`, `qty` in the cart, its variety label `label`, and
// its restock label, if any. -> { form, row, input, add }.
export const stockRow = ({ sku, qty, label = "Large", restockLabel }) => {
  const attrs = new Set();
  const note = { textContent: "" };
  const add = { disabled: false };
  const row = {
    dataset: restockLabel === undefined ? {} : { restockLabel },
    hidden: false,
    hasAttribute: (name) => attrs.has(name),
    toggleAttribute: (name, on) => {
      if (on) attrs.add(name);
      else attrs.delete(name);
    },
    querySelector: (s) => (s === "label" ? { textContent: label }
      : s === "[data-stock-note]" ? note : null),
    querySelectorAll: (s) => (s === "[data-step]" ? [add] : []),
  };
  const input = {
    dataset: { qty: sku }, value: String(qty), disabled: false,
    closest: () => row,
  };
  const form = {
    toggleAttribute() {},
    querySelector: () => null,
    querySelectorAll: (s) => (s === "[data-qty]" ? [input]
      : s === ".order-item" ? [row] : []),
  };

  return { form, row, input, add };
};
