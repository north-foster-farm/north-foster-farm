// The shape of an order id the site draws: NFF-, the year and month,
// and ID_LENGTH letters and digits (NFF-2611-K3WMPA). Alone here so
// lib/store.mjs can know one in a key without loading the Square
// client.
//
// ID_LENGTH is the one source of the length: orders.mjs draws that
// many. Ids before #253 had four (NFF-2610-K3WM), and those orders
// are still in Square and in the records, so both lengths match
// (#937).
export const ID_LENGTH = 6;

const BEFORE_253 = 4;

// The part after the second dash, of either length.
export const ID_TAIL =
  `(?:[A-Z0-9]{${ID_LENGTH}}|[A-Z0-9]{${BEFORE_253}})`;

export const ORDER_ID = new RegExp(`^NFF-\\d{4}-${ID_TAIL}$`);
