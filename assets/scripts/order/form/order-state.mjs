// The order's state as one record (docs/refactors/order-form.md,
// phase 5): the terms, what prices the order, the buying group, the
// session, the change to a paid order, and the choices waiting for
// the lists. Pure: the root reads it from its store and writes a new
// record for every change, which draws nothing.

// The record before the page knows anything: the root adds the page's
// `terms` (prices, area, time zone and the pickup model), which a
// group unlocked or dropped replaces (withPlaces). `perks`,
// `joinConfirmed` and `termTips` are made anew for each record
// (initialState).
const BLANK = {
  terms: null,
  // A discount code the form applied: { code, label, off }.
  code: null,
  // A pass the farm issued (#182): its code, once /api/pass says it
  // lifts the delivery minimum, and whether it waives the delivery
  // fee too. The server checks it again. To the customer it is a
  // discount code like any other.
  pass: null,
  passFee: false,
  // The signed-in customer's discount group, from /api/me. The server
  // applies it again from the session; this only shows it.
  group: null,
  // The signed-in customer's perks (#514), from /api/me: [{ type,
  // start, end }]. The server reads them again from the record.
  perks: null,
  // A member's credit, in cents, from /api/group when signed in: it
  // comes off the total by itself, and the server reads the ledger
  // again. `ownCredit` is what /api/me says is the customer's own,
  // kept after leaving a group (#495).
  credit: 0,
  ownCredit: 0,
  // A buying group (#471): what /api/group said its code unlocks
  // (the name, the lock, its place and series), and the code itself
  // when one was typed or linked, so the order carries it; null for
  // a member signed in, whose account the server knows.
  member: null,
  // The group whose rounds Group orders offers (#749): the member's,
  // or the one a code unlocked. A change to a paid order sets it
  // alone, its prices and credit staying as the order has them.
  roundGroup: null,
  groupCode: null,
  // A code that came by the link, not typed, for the join log (#495).
  groupLinked: false,
  // Group codes the customer has said Join to (#495, decision 5): a
  // draft's, and any confirmed here. Applied again, they don't ask.
  joinConfirmed: null,
  // The buying group whose member line the cart shows (#717), and the
  // tooltips of the Delivery choice's terms, as the account has them.
  shownMember: null,
  termTips: null,
  // Whether /api/me said so: the thank-you card then leaves out the
  // line about the account the order made (#114).
  signedIn: false,
  // A paid order being changed (startEdit): { id, held, kept,
  // keptDate, placed, booked }, or null.
  editing: null,
  // A pickup time to select once its day's windows are drawn: a
  // restored draft's, or the dialog's.
  wantedWindow: null,
  // A draft's pickup at a round the lists lack until the group is
  // unlocked, chosen then.
  wantedOccurrence: null,
};

export const initialState = () => ({
  ...BLANK, perks: [], joinConfirmed: new Set(), termTips: [],
});

// The one record, replaced whole on `set`. A record handed out is
// frozen, so nothing changes it after.
export const createStore = (record) => {
  let current = Object.freeze(record);

  return {
    get: () => current,
    set: (next) => {
      current = Object.freeze(next);
    },
  };
};
