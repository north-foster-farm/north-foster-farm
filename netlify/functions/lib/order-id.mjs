// The shape of an order id the site draws, for the functions. The
// pattern lives in assets/scripts/utils/order-id.mjs, so the account
// page reads the same one (#947). Alone here so lib/store.mjs can know
// one in a key without loading the Square client. orderId draws one,
// here since #968 so lib/farm-orders.mjs need not import the orders
// function; terms.mjs, which it reads, is a leaf.
import { createHash } from "node:crypto";

import { ID_LENGTH } from "../../../assets/scripts/utils/order-id.mjs";
import { parts } from "../../../assets/scripts/order/lib/zoned.mjs";
import terms from "./terms.mjs";

export {
  ID_LENGTH,
  ID_TAIL,
  ORDER_ID,
} from "../../../assets/scripts/utils/order-id.mjs";

// Human-readable, and the same for every retry of one submission:
// `NFF-YYMM-` and six letters and digits, about a billion a month.
// Ids before #253 had four, and stay valid everywhere (an id is only
// ever looked up whole). `draw` is the nth candidate, for when an
// earlier one is taken (lib/records.mjs, reserveOrderId). ID_LENGTH
// lives here beside the pattern that reads it (#937).
export const orderId = (key, now, draw = 0) => {
  const p = parts(now, terms.timeZone);
  const yymm = `${String(p.year).slice(2)}${String(p.month).padStart(2, "0")}`;
  const hash = createHash("sha256")
    .update(draw ? `${key}#${draw}` : key)
    .digest("hex");
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let tail = "";

  for (let i = 0; i < ID_LENGTH; i++) {
    tail += alphabet[parseInt(hash.slice(i * 2, i * 2 + 2), 16) % 32];
  }

  return `NFF-${yymm}-${tail}`;
};
