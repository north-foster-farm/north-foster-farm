// The least of a DOM the order page's Stock class reads
// (assets/scripts/order/stock.js), for the tests that build one
// without a browser: a region for the skeleton, a form with no rows,
// a document with no callout. Shared by stock-ready.test.mjs and
// #908's stock-follow tests.

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
