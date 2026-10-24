// The prices and rules in force on a day. data/delivery.json holds
// today's under `money`, and `money.changes` the ones that start later,
// each switched on by its `from` date in the farm's zone, not by a
// deploy: { from, deliveryMinimum?, dropTiers?: [thresholds] }.
// -> the money without `changes`, every change on or before `day`
// applied in order.
export const moneyOn = (money, day) => {
  const { changes = [], ...base } = money;
  let out = base;

  const byDate = [...changes].sort((a, b) => (a.from < b.from ? -1 : 1));

  for (const change of byDate) {
    if (change.from > day) break;

    const set = { ...change };
    const drop = set.dropTiers || [];

    delete set.from;
    delete set.dropTiers;
    out = {
      ...out, ...set,
      bulkTiers: out.bulkTiers.filter((t) => !drop.includes(t.threshold)),
    };
  }

  return out;
};
