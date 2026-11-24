// What the order page prices an order by (docs/refactors/order-form.md,
// phase 6). Pure: the root passes what it reads from the page and the
// record, and computeTotals and validateOrder take what these give.
// `placed` is the day a paid order being changed was placed (ISO), or
// null; `now` the page's clock.

import { moneyOn } from "../lib/money-on.mjs";
import { perkEffects } from "../lib/perks.mjs";
import { lockOn } from "../lib/totals.mjs";
import { zipInfo } from "../lib/validate.mjs";
import { today } from "../lib/zoned.mjs";

// The day prices are read for, in the farm's zone.
const dayOf = ({ now, placed, timeZone }) => today(
  placed ? new Date(placed) : now, timeZone
);

// The prices in force today in the farm's zone, so the 1 January
// changes (data/delivery.json, money.changes) arrive with the day;
// an order being changed keeps those of the day it was placed.
export const pricesOn = ({ money, now, placed, timeZone }) => moneyOn(
  money, dayOf({ now, placed, timeZone })
);

// The member price while it holds (#471): through its last day, by
// the day the order is for, the day it is placed or, for a change,
// was, as pricesOn chooses the prices in force. The server works it
// out the same way, so the totals agree.
export const lockOf = ({ member, now, placed, timeZone }) => {
  if (!member || !member.lock) return null;

  return lockOn({ ...member.lock, through: member.lockThrough },
    dayOf({ now, placed, timeZone }));
};

// The signed-in customer's perk types (#514), from /api/me; while
// changing an order, the ones it was priced with.
export const perkTypesOf = (perks) => perks.map((p) => p.type);

// The money rules the page holds the order to: a pass or a perk
// (#514) lifts the delivery minimum, and nothing else. `perks` are
// perk types.
export const rulesOf = ({ money, pass, perks }) => (
  pass || perkEffects(perks).minimum
    ? { ...money, deliveryMinimum: 0 } : money
);

// The arguments for computeTotals. The delivery ZIP's status (`zip` as typed,
// for the outside-area fee) is null unless delivery is chosen, so the
// fee shows the moment it applies; a change counts no credit.
export const totalsArgs = ({
  lines, method, index, money, group, code, lock, zip, area, pass,
  passFee, editing, credit, perks,
}) => ({
  lines,
  method,
  index,
  money,
  group,
  code,
  lock,
  zipStatus: method === "delivery" ? zipInfo(zip, area).status : null,
  waiveFee: !!pass && passFee,
  credit: editing ? 0 : credit,
  perks,
});

// What the payment section charges: the total, or for a change, the
// total less what is held, plus a kept fee, never below 0.
export const amountDue = ({ total, editing }) => (
  editing ? Math.max(0, (total || 0) - editing.held + editing.kept)
    : total || 0
);

// The options for validateOrder: as the totals price the order, with the
// day a change was placed and, as lib/edit.mjs passes it, its booked
// day (#643).
export const checkOptions = ({
  index, terms, now, editing, group, code, schedule, lock, credit, pass,
  passFee, perks,
}) => ({
  index,
  terms,
  now,
  placed: editing && editing.placed,
  group,
  code,
  schedule,
  keptDate: (editing && editing.booked) || null,
  lock,
  credit: editing ? 0 : credit,
  waive: { minimum: !!pass, fee: !!pass && passFee },
  perks,
});
