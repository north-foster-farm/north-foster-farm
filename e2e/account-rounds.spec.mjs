// Criteria tests for #762 (Account page still lists rounds as pick-up
// days), one per box of its "Done when" marked (test), each named for
// its box word for word. The account page's Change pickup should
// match the order page after #749: a round order changes among the
// group's open rounds, under Group orders, and Pick-up days there
// lists no round, for anyone.
//
// Held out of every run by its name (playwright.config.mjs matches
// *.spec.mjs). The change that meets the boxes turns it on with
//
//   git mv e2e/account-rounds.criteria.mjs \
//     e2e/account-rounds.spec.mjs
//
// and maps it in e2e/dispatch.json wherever the account page's
// scripts and layout map to specs (pickup-days.spec.mjs's entries),
// with e2e/support/vff.mjs.
//
// The seam, what the tests rely on:
// - the member, the non-member, a paid round order and the group's
//   real rounds come from e2e/support/vff.mjs, as in
//   e2e/group-orders.spec.mjs; /api/group answers the account's ask
//   for the group, whatever its method;
// - a paid pickup's card on /account/#orders has a "Change pickup"
//   button, and its form is the `.account-panel-form` it opens, as
//   e2e/pickup-days.spec.mjs reads it;
// - in that form, Pick-up days' list is `[data-pickups]`, as on next,
//   and Group orders' is a radiogroup whose accessible name holds
//   "Group order" (the order page's `#group-pickups` is "Group order
//   date"); each list's radios are valued by occurrence ids,
//   "<series>-<YYMMDD>";
// - the order page's Group orders lists the rounds as
//   group-orders.spec.mjs reads them (vff.mjs `choose`).

import { ORDER_SCHEDULED } from "./support/canned.mjs";
import { expect, test } from "./support/order.mjs";
import { FOSTER, datesWith } from "./support/scheduled.mjs";
import {
  GROUP_ORDERS, GYM, MEMBER, NON_MEMBER, SERIES, choose, openOrder,
  radioValues, roundOrder, rounds, signIn,
} from "./support/vff.mjs";

// Pick-up days with the Foster market alone.
const lists = () => datesWith([{ place: FOSTER, days: [3] }]);

// A paid pickup at the Foster market, as the account API sends one.
const fosterOrder = (dated) => {
  const booked = dated.scheduled[0];

  return {
    ...ORDER_SCHEDULED,
    id: "NFF-2611-QA89",
    fulfilment: { ...ORDER_SCHEDULED.fulfilment,
      occurrence: booked.occurrence, date: booked.date },
    pickup: { ...ORDER_SCHEDULED.pickup, series: FOSTER.series,
      name: FOSTER.name, occurrence: booked.occurrence },
  };
};

// The account's orders, and the Change pickup form of the first.
const changeForm = async (page) => {
  await page.goto("/account/#orders");
  await page.getByRole("button", { name: "Change pickup" }).first()
    .click();

  const form = page.locator(".account-panel-form");

  await expect(form.locator("input[type='radio']").first()).toBeVisible();

  return form;
};

const isRound = (v) => v.startsWith(`${SERIES}-`);

test.describe("the account's Change pickup and rounds (#762)", () => {
  test("On the account page's Change pickup, Pick-up days lists no " +
    "Village Family Fitness round, for anyone", async ({
    page, baseURL,
  }) => {
    const now = new Date();
    const dated = lists();

    for (const [who, me, order] of [
      ["a member's pickup", MEMBER, fosterOrder(dated)],
      ["a member's round", MEMBER, roundOrder(now)],
      ["a non-member's pickup", NON_MEMBER, fosterOrder(dated)],
    ]) {
      await signIn(page, baseURL, me, { lists: dated, now, orders: [order] });

      const form = await changeForm(page);
      const days = form.locator("[data-pickups]");
      const values = await days.locator("input[type='radio']")
        .evaluateAll((els) => els.map((el) => el.value));

      expect(values.filter(isRound), `${who}: no round in Pick-up days`)
        .toEqual([]);
      await expect(days.getByText(GYM.name), `${who}: not the gym`)
        .toHaveCount(0);
    }
  });

  test("A paid round order's change offers the group's open rounds " +
    "under Group orders, as the order page does", async ({
    page, baseURL,
  }) => {
    const now = new Date();
    const booked = roundOrder(now);

    expect(rounds(now).length, "the group has a round open")
      .toBeGreaterThan(0);

    // What the order page offers the member under Group orders.
    await signIn(page, baseURL, MEMBER, { lists: lists(), now });

    const order = await openOrder(page, MEMBER);
    const body = await choose(order, GROUP_ORDERS);

    await expect(body.locator("input[type='radio']").first()).toBeVisible();

    const offered = (await radioValues(body)).sort();

    expect(offered.length, "the order page offers rounds")
      .toBeGreaterThan(0);

    // The same member's paid round order, changed on the account page.
    await signIn(page, baseURL, MEMBER, {
      lists: lists(), now, orders: [booked],
    });

    const form = await changeForm(page);
    const group = form.getByRole("radiogroup", { name: /group order/i });

    await expect(group, "Group orders' list in the change").toHaveCount(1);

    const values = await group.locator("input[type='radio']")
      .evaluateAll((els) => els.map((el) => el.value));

    expect(values.sort(), "the rounds the order page offers").toEqual(offered);
  });
});
