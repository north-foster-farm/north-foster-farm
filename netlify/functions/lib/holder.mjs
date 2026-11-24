// Which Square order holds an order's fulfillment, kept apart from
// lib/amend.mjs so lib/account.mjs and lib/admin.mjs read it without
// importing the farm's change (#967, docs/refactors/server-cycles.md).
// It imports nothing. lib/amend.mjs re-exports it, and lib/records.mjs
// keeps its own private holderOf, of a checkout.

// The Square order that carries an order's fulfillment: the change
// order a switch moved it to, else the one the customer paid on.
export const holderOf = (order) => order.square
  && (order.square.fulfilmentOrderId || order.square.squareOrderId);
