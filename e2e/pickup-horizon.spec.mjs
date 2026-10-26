// On-farm pickup is offered only through the Saturday of the week after
// this one, weeks starting Sunday (#267), and the server refuses a
// later day. Nothing here charges or records an order.
// docs/qa-launch.md, FM-14.

import { eggOrder, firstPickup, postOrder } from "./support/api.mjs";
import { expect, test, uniqueEmail } from "./support/order.mjs";

const ZONE = "America/New_York";
const DAY = 86400000;

// Today's date in farm time as "YYYY-MM-DD", and its weekday (Sunday 0).
const farmToday = () => {
  const iso = new Intl.DateTimeFormat("en-CA", { timeZone: ZONE })
    .format(new Date());
  const weekday = new Date(`${iso}T12:00:00Z`).getUTCDay();

  return { iso, weekday };
};

const horizon = () => {
  const { iso, weekday } = farmToday();
  const end = new Date(`${iso}T12:00:00Z`).getTime() +
    (13 - weekday) * DAY;

  return new Date(end).toISOString().slice(0, 10);
};

test.describe("pickup horizon", () => {
  test("the pickup list stops at next week's Saturday", async ({ request }) => {
    const dates = await (await request.get("/api/dates")).json();
    const days = dates.onfarm.map((d) => d.date);
    const { iso } = farmToday();

    expect(days.length).toBeGreaterThan(0);
    expect(days.at(-1) <= horizon(), days.at(-1)).toBe(true);
    expect(days[0] > iso).toBe(true);
  });

  test("a pickup day past the horizon is refused", async ({ request }) => {
    const { window } = await firstPickup(request);
    const late = new Date(
      new Date(`${horizon()}T12:00:00Z`).getTime() + DAY
    ).toISOString().slice(0, 10);
    const order = await eggOrder(request, {
      email: uniqueEmail("api-horizon"),
    });

    order.fulfilment = {
      method: "onfarm", date: late, onfarm: { window }, delivery: {},
    };

    const { status, body } = await postOrder(request, order);

    expect(status, JSON.stringify(body)).toBe(409);
    expect(body.dates).toBeTruthy();
  });
});
