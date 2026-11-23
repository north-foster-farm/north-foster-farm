// An order's cutoff, kept apart from lib/jobs.mjs so lib/account.mjs
// reads it without importing the scheduled work (#967,
// docs/refactors/server-cycles.md). From lib/ it imports terms.mjs
// alone. lib/jobs.mjs re-exports it.

import terms from "./terms.mjs";
import {
  cutoffFor, isScheduled,
} from "../../../assets/scripts/order/lib/dates.mjs";
import {
  cutoffOf as eveningBefore,
} from "../../../assets/scripts/order/lib/events.mjs";
import { instant } from "../../../assets/scripts/order/lib/zoned.mjs";

const tz = terms.timeZone;

// When a customer can no longer change or cancel an order themselves:
// the delivery or drop-site cutoff, or midnight before an on-farm
// pickup.
export const cutoffAt = (order) => {
  const { date, method } = order.fulfilment;

  if (method === "delivery") return cutoffFor(date, terms);
  if (isScheduled(order.fulfilment)) return eveningBefore(date, tz);

  return instant(date, 0, 0, tz);
};
