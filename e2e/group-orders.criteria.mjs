// Criteria tests for #749 (Group orders as their own fulfillment type
// for Village Family Fitness members, not under Pick-up days), one per
// box of its "Done when" marked (test), each named for its box, save
// the tooltip box, which is #717's test in e2e/perk-revision.spec.mjs
// with the words revised. Held out of every run by its name until the
// change lands: renamed to group-orders.spec.mjs, it runs.
//
// The member and everything the server would say of them come from
// e2e/support/vff.mjs. The rounds are the group's real ones
// (data/series.json), as /api/group lists them.
//
// #749's wording is not approved yet, so these test what the page does
// and how it is built, never its words, save "Group orders" (approved).
// The seam, what the tests rely on:
// - the fulfillment types are the radios of `#pickup`, each named by
//   its title; Group orders is a fourth, named "Group orders", beside
//   On-farm pickup (`#method-onfarm`), Pick-up days
//   (`#method-scheduled`) and Delivery (`#method-delivery`), and what
//   it reveals is the `[data-method-body]` of its value, as theirs is;
// - Group orders' rounds, like Pick-up days' days, are radios whose
//   values are occurrence ids, "<series>-<YYMMDD>", each labelled by a
//   `label[for]` that gives its date and its hours;
// - Delivery's address is the `delivery.*` fields and its day the
//   `[data-dates='delivery']` select, as on next;
// - a paid order opens for a change at /order/?edit=<id> (#160).

import { expect, test } from "./support/order.mjs";
import {
  GROUP_ORDERS, GYM, MEMBER, NON_MEMBER, SERIES, choose, chosenWay,
  gymOrder, methodRadio, openOrder, radioValues, roundOrder, rounds,
  signIn, way,
} from "./support/vff.mjs";
import { dates } from "./support/canned.mjs";

const isRound = (v) => v.startsWith(`${SERIES}-`);

// "8:30 – 9:00 AM" -> ["8:30", "9:00"]: a round's hours as the data
// gives them, however the page sets them out.
const hours = (window) => window.match(/\d{1,2}:\d{2}/g);

// "Sunday, November 22" -> ["November", "22"]: a round's date.
const dayOf = (label) => label.match(/([A-Z][a-z]+) (\d{1,2})$/).slice(1);

const WHO = [
  ["a member", MEMBER], ["a non-member", NON_MEMBER], ["signed out", null],
];

test.describe("Group orders (#749)", () => {
  test("A signed-in Village Family Fitness member sees a \"Group " +
    "orders\" fulfillment type; a non-member doesn't", async ({
    page, baseURL,
  }) => {
    for (const [who, me] of WHO) {
      await signIn(page, baseURL, me);

      const order = await openOrder(page, me);

      // The three ways everyone has.
      for (const value of ["onfarm", "scheduled", "delivery"]) {
        await expect(methodRadio(page, value), `${who}: ${value}`)
          .toHaveCount(1);
      }

      const radio = way(page, GROUP_ORDERS);

      if (me === MEMBER) {
        await expect(radio, `${who}: Group orders`).toHaveCount(1);

        const id = await radio.getAttribute("id");

        await expect(page.locator(`label[for='${id}']`), who)
          .toBeVisible();
        await expect(radio, "a way like the others")
          .toHaveAttribute("name", "method");
        // Choosing it chooses no other way.
        await choose(order, GROUP_ORDERS);
        for (const value of ["onfarm", "scheduled", "delivery"]) {
          await expect(methodRadio(page, value)).not.toBeChecked();
        }
      } else {
        await expect(radio, `${who}: no Group orders`).toHaveCount(0);
      }
    }
  });

  test("Group orders lists the buying group's rounds with their dates " +
    "and times", async ({ page, baseURL }) => {
    const now = new Date();
    const expected = rounds(now);

    expect(expected.length, "the group has a round open").toBeGreaterThan(0);
    await signIn(page, baseURL, MEMBER, { now });

    const order = await openOrder(page, MEMBER);
    const body = await choose(order, GROUP_ORDERS);

    // Every round, and nothing but rounds.
    await expect.poll(async () => (await radioValues(body)).sort(),
      "Group orders' choices").toEqual(
      expected.map((d) => d.occurrence).sort()
    );

    for (const round of expected) {
      const radio = body.locator(`input[value='${round.occurrence}']`);
      const id = await radio.getAttribute("id");
      const label = body.locator(`label[for='${id}']`);

      await expect(label, round.occurrence).toBeVisible();

      const [month, day] = dayOf(round.label);

      await expect(label, `${round.occurrence}: its month`)
        .toContainText(month);
      await expect(label, `${round.occurrence}: its day`)
        .toContainText(new RegExp(`\\b${day}\\b`));
      for (const time of hours(round.window)) {
        await expect(label, `${round.occurrence}: ${time}`)
          .toContainText(time);
      }

      // A round can be chosen, as a pick-up day can.
      await label.click();
      await expect(radio).toBeChecked();
    }
  });

  test("The Village Family Fitness drop-off no longer appears under " +
    "Pick-up days, for anyone", async ({ page, baseURL }) => {
    for (const [who, me] of WHO) {
      await signIn(page, baseURL, me);

      const order = await openOrder(page, me);
      const body = await choose(order, "scheduled");

      // The regular places are there; the gym's rounds are not.
      await expect(body.locator("input[type='radio']").first(), who)
        .toBeVisible();
      expect((await radioValues(body)).filter(isRound), `${who}: rounds`)
        .toEqual([]);
      await expect(body, `${who}: the gym`).not.toContainText(GYM.name);
      await expect(body, `${who}: the gym`)
        .not.toContainText("Village Family Fitness");
      await expect(page.locator("[data-scheduled-facts]"), who)
        .not.toContainText("Village Family Fitness");
    }
  });

  test("Group orders holds only rounds: no delivery address choice and " +
    "no delivery day", async ({ page, baseURL }) => {
    await signIn(page, baseURL, MEMBER);

    const order = await openOrder(page, MEMBER);
    const group = await choose(order, GROUP_ORDERS);

    // Its choices are rounds and nothing else.
    await expect.poll(async () => (await radioValues(group)).length,
      "its rounds").toBeGreaterThan(0);
    expect((await radioValues(group)).filter((v) => !isRound(v)),
      "nothing but rounds").toEqual([]);

    // No delivery address choice: no field of a delivery, no address
    // to type and no choice of where it goes.
    await expect(group.locator("[name^='delivery.'], [data-field^=" +
      "'delivery.'], [autocomplete*='address'], [autocomplete*='postal']"),
    "no delivery fields").toHaveCount(0);
    await expect(group.getByRole("radio", { name: /deliver/i }),
      "no choice of where it goes").toHaveCount(0);

    // No delivery day: no day select, and none of the days Delivery
    // offers.
    await expect(group.locator("select, [data-dates='delivery']"),
      "no day select").toHaveCount(0);
    for (const { label } of dates().delivery) {
      await expect(group, `no delivery day (${label})`)
        .not.toContainText(label);
    }

    // And choosing it shows none of Delivery's: the address and the
    // day stay with Delivery, out of sight.
    for (const id of ["#delivery-address1", "#delivery-zip",
      "#delivery-date"]) {
      await expect(page.locator(id), `${id} hidden`).toBeHidden();
    }
  });

  test("Existing round and `toGroup` orders keep working as today",
    async ({ page, baseURL }) => {
      const now = new Date();
      const lists = dates();
      const opened = async (stored) => {
        expect(stored.canChange, `${stored.id} can change`).toBe(true);
        await signIn(page, baseURL, MEMBER, { orders: [stored], lists, now });
        await page.goto(`/order/?edit=${stored.id}`, {
          waitUntil: "domcontentloaded",
        });
        await expect(page.locator("#order-editing")).toBeVisible();
        await expect(page).toHaveURL(new RegExp(`edit=${stored.id}`));
      };

      // A member's delivery to the gym, stored with `toGroup` (#471)
      // before #626 parked the option. On next it opens as a plain
      // Delivery that keeps its own address and day (order-form.js:
      // a paid order being changed keeps its address), and so it
      // does still, never under Group orders. It comes first, so a run
      // on next shows this half holding.
      const day = lists.delivery[0].date;
      const gymDrop = gymOrder(day);

      await opened(gymDrop);
      await expect(chosenWay(page), "one way, Delivery")
        .toHaveAttribute("value", "delivery");
      await expect(methodRadio(page, "delivery")).toBeChecked();

      const kept = gymDrop.fulfilment.delivery;

      await expect(page.locator("#delivery-address1"), "its street")
        .toHaveValue(kept.address1);
      await expect(page.locator("#delivery-town"), "its town")
        .toHaveValue(kept.town);
      await expect(page.locator("#delivery-zip"), "its ZIP")
        .toHaveValue(kept.zip);
      await expect(page.locator("#delivery-cooler"), "its cooler")
        .toHaveValue(kept.cooler);
      await expect(page.locator("#delivery-date"), "its day")
        .toHaveValue(day);

      await page.evaluate(() => localStorage.clear());

      // A member's order at a round, placed under Pick-up days before
      // this: it opens under Group orders, its round chosen.
      const round = roundOrder(now);

      await opened(round);

      const radio = way(page, GROUP_ORDERS);

      await expect(radio, "Group orders").toBeChecked();
      await expect(methodRadio(page, "scheduled")).not.toBeChecked();

      const body = page.locator(
        `[data-method-body='${await radio.getAttribute("value")}']`
      );

      await expect(body.locator(
        `input[value='${round.fulfilment.occurrence}']`
      ), "its round").toBeChecked();
    });
});
