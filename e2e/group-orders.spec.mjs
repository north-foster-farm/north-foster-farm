// Criteria tests for #749 (Group orders as their own fulfillment type
// for Village Family Fitness members, not under Pick-up days), one per
// box of its "Done when" marked (test), each named for its box, save
// the tooltip box, which is #717's test in e2e/perk-revision.spec.mjs
// with the words revised. The 6:00 AM box has a server half too,
// test/group-orders-grace.criteria.mjs. Held out of every run by its
// name until the change lands: renamed to group-orders.spec.mjs, it
// runs.
//
// The member and everything the server would say of them come from
// e2e/support/vff.mjs. The rounds are the group's real ones
// (data/series.json), as /api/group lists them.
//
// #749's wording is approved final (its "Wording and behavior"
// list, James, 2026-11-21), so where a test reads the words it holds
// them exactly: the card's lines (items 1 to 4), the orders-close line
// (5), the card with no round open (6), the late member's dialog (8)
// and the message to a customer no longer a member (9).
// The seam, what the tests rely on:
// - the fulfillment types are the radios of `#pickup`, each named by
//   its title; Group orders is a fourth, named "Group orders", beside
//   On-farm pickup (`#method-onfarm`), Pick-up days
//   (`#method-scheduled`) and Delivery (`#method-delivery`), and what
//   it reveals is the `[data-method-body]` of its value, as theirs is;
// - its card is the `label[for]` of its radio, set out as the others
//   are: the title in `.order-method-title`, then a `dt` heading and
//   its `dd` line each for When, Where and Cost;
// - Delivery's orders-closing line is its `[data-countdown]`, the
//   first thing its body shows;
// - with no round open, /api/group answers with no `dates`; the next
//   date is known while the group's series still runs, and none is
//   once its series is off the schedule (`noRound` below);
// - a late group order is refused as a lapsed pickup is today (409,
//   with the rounds still open as `dates`), and the page says so in
//   its lapsed dialog, `#order-lapsed`;
// - the last test posts to the real /api/orders, which knows nothing
//   of the page's canned member, as for a customer just removed;
// - Group orders' rounds, like Pick-up days' days, are radios whose
//   values are occurrence ids, "<series>-<YYMMDD>", each labelled by a
//   `label[for]` that gives its date and its hours;
// - Delivery's address is the `delivery.*` fields and its day the
//   `[data-dates='delivery']` select, as on next;
// - a paid order opens for a change at /order/?edit=<id> (#160).

import { OrderPage, expect, test } from "./support/order.mjs";
import {
  GROUP_ORDERS, GYM, MEMBER, NON_MEMBER, SERIES, choose, chosenWay,
  groupAnswer, gymOrder, methodRadio, openOrder, pick, radioValues,
  roundOrder, rounds, signIn, way,
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

// The card's approved lines (#749 items 2 to 4), by their headings.
const CARD = {
  When: "Every other Sunday, 8:30 – 9:00 AM",
  Where: "The Village Family Fitness, Warwick",
  Cost: "No minimum, no fee",
};

// A card's line under the heading `name` ("When", "Where", "Cost"), as
// the other three cards set theirs out.
const fact = (card, name) => card.locator("dt")
  .filter({ hasText: new RegExp(`^\\s*${name}\\s*$`) })
  .locator("xpath=following-sibling::dd[1]");

// "Orders close at 11:59 PM on Saturday, November 21": a round's
// cutoff, in the farm's zone (#749 item 5).
const closeLine = (cutoff) => {
  const at = new Date(cutoff);
  const zone = { timeZone: "America/New_York" };
  const time = at.toLocaleTimeString("en-US", {
    ...zone, hour: "numeric", minute: "2-digit",
  }).replace(/\s/gu, " ");
  const day = at.toLocaleDateString("en-US", {
    ...zone, weekday: "long", month: "long", day: "numeric",
  });

  return `Orders close at ${time} on ${day}`;
};

// /api/group's answer with no round open (#749 item 6): `scheduled`,
// the group's series still runs, so a next date is known; otherwise
// the farm has taken it off the schedule and none is.
const noRound = (now, { scheduled }) => {
  const answer = groupAnswer(now);

  if (!scheduled) {
    answer.group = { ...answer.group, series: null };
    answer.group.places = { ...answer.group.places, series: [] };
  }

  return { ...answer, dates: [] };
};

// Group orders' radio in any state: with no round open its heading
// carries more than its name.
const groupWay = (page) => page.locator("#pickup")
  .getByRole("radio", { name: /^Group orders\b/ });

// Pays for the order on the page: the contact details, then the card,
// then Pay, as e2e/order-scheduled's lapsed pickups do.
const pay = async (order) => {
  await order.contact({ email: MEMBER.customer.email,
    phone: MEMBER.customer.phone });
  await order.openCard();
  await order.card();
  await order.submit.click();
};

// Chooses Group orders and its first round. -> the round
const firstRound = async (page, order) => {
  const body = await choose(order, GROUP_ORDERS);
  const radio = body.locator("input[type='radio']").first();

  await pick(page, radio);

  return radio.getAttribute("value");
};

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

        const card = page.locator(`label[for='${id}']`);

        await expect(card, who).toBeVisible();
        // The card's approved lines (#749 items 1 to 4).
        await expect(card.locator(".order-method-title"), "its title")
          .toHaveText(GROUP_ORDERS);
        for (const [name, line] of Object.entries(CARD)) {
          await expect(fact(card, name), `its ${name} line`).toHaveText(line);
        }
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

  test("The orders-close line (\"Orders close at 11:59 PM on Saturday, " +
    "November 21\") sits above the round cards, in the same style and " +
    "position as the Delivery card's orders-closing line, not inside a " +
    "round card", async ({ page, baseURL }) => {
    const now = new Date();
    const [first] = rounds(now);

    await signIn(page, baseURL, MEMBER, { now });

    const order = await openOrder(page, MEMBER);
    const body = await choose(order, GROUP_ORDERS);
    const text = closeLine(first.cutoff);
    const line = body.getByText(text, { exact: true });

    await expect(line, "the earliest round's close").toBeVisible();
    await expect(line).toHaveCount(1);

    // Above every round card and in none: no box around it holds a
    // round of its own, and no round card says it.
    const placed = await line.evaluate((el) => {
      const box = el.closest("[data-method-body]");
      const radios = [...box.querySelectorAll("input[type='radio']")];
      const above = radios.every((r) => el.compareDocumentPosition(r)
        & Node.DOCUMENT_POSITION_FOLLOWING);
      let inCard = false;

      for (let up = el; up && up !== box; up = up.parentElement) {
        if (up.querySelectorAll("input[type='radio']").length === 1) {
          inCard = true;
        }
      }

      return { count: radios.length, above, inCard };
    });

    expect(placed.count, "the rounds").toBeGreaterThan(0);
    expect(placed.above, "above every round card").toBe(true);
    expect(placed.inCard, "inside no round card").toBe(false);
    for (const label of await body.locator("label").all()) {
      await expect(label, "no close line in a card")
        .not.toContainText("Orders close");
    }

    // In Delivery's place: the first thing its way reveals, as
    // Delivery's countdown is.
    const firstIn = (el) => {
      const box = el.closest("[data-method-body]");
      const walker = document.createTreeWalker(box,
        NodeFilter.SHOW_TEXT, {
          acceptNode: (n) => (n.textContent.trim()
            ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP),
        });
      const node = walker.nextNode();

      return !!node && el.contains(node);
    };

    expect(await line.evaluate(firstIn), "the first line of its body")
      .toBe(true);
    expect(await page.locator("[data-method-body='delivery'] " +
      "[data-countdown]").evaluate((el) => el.closest(
      ".order-method-body"
    ).firstElementChild === el), "as Delivery's is").toBe(true);

    // In Delivery's style.
    const STYLE = ["fontFamily", "fontSize", "fontWeight", "fontStyle",
      "lineHeight", "color", "textTransform", "letterSpacing"];
    const style = (el, keys) => {
      const s = getComputedStyle(el);

      return Object.fromEntries(keys.map((k) => [k, s[k]]));
    };
    const delivery = page.locator("[data-method-body='delivery'] " +
      "[data-countdown]");

    expect(await line.evaluate(style, STYLE), "Delivery's style")
      .toEqual(await delivery.evaluate(style, STYLE));
  });

  test("With no round open, the card shows \"Group orders\" with \"· no " +
    "open group order\" in its heading, a When line \"next order opens " +
    "[date]\" when the next date is known or \"Not currently " +
    "scheduled\" when not, the same Where and Cost lines, and it can't " +
    "be chosen", async ({ page, baseURL }) => {
    const now = new Date();
    // "[date]": a month and a day, as the site writes a date.
    const MONTH = "(January|February|March|April|May|June|July|August|" +
      "September|October|November|December)";

    for (const [state, scheduled, when] of [
      ["the next date known", true,
        new RegExp(`^next order opens \\S.*\\b${MONTH} \\d{1,2}\\b`)],
      ["no next date", false, /^Not currently scheduled$/],
    ]) {
      await signIn(page, baseURL, MEMBER, {
        now, group: noRound(now, { scheduled }),
      });

      const order = await openOrder(page, MEMBER);
      const radio = groupWay(page);

      await expect(radio, `${state}: the card`).toHaveCount(1);

      const card = page.locator(`label[for='${await radio
        .getAttribute("id")}']`);

      await expect(card.locator(".order-method-title"),
        `${state}: its heading`)
        .toHaveText(/^Group orders\s*·\s*no open group order$/);
      await expect(fact(card, "When"), `${state}: its When line`)
        .toHaveText(when);
      await expect(fact(card, "Where"), `${state}: its Where line`)
        .toHaveText(CARD.Where);
      await expect(fact(card, "Cost"), `${state}: its Cost line`)
        .toHaveText(CARD.Cost);

      // It can't be chosen, and what was chosen stays so.
      await order.scrollSettled();
      await pick(page, methodRadio(page, "onfarm"));
      await card.click({ force: true });
      await expect(radio, `${state}: not chosen`).not.toBeChecked();
      await expect(methodRadio(page, "onfarm"), `${state}: still on-farm`)
        .toBeChecked();

      await page.evaluate(() => localStorage.clear());
    }
  });

  test("A group order is accepted until 6:00 AM after its round's " +
    "cutoff; after that, a late member sees \"That group order date is " +
    "no longer available\" and its approved lines (page)", async ({
    page, baseURL,
  }) => {
    // The server's half, the 6:00 AM grace, is
    // test/group-orders-grace.criteria.mjs. Here the server has
    // refused the round as lapsed (409, as a lapsed pickup is today)
    // and sent the rounds still open, if any (#749 item 8).
    const now = new Date();
    const later = rounds(new Date(now.getTime() + 14 * 86_400_000));

    for (const [state, open] of [["another round open", later],
      ["none open", []]]) {
      await signIn(page, baseURL, MEMBER, { now });
      await page.route("**/api/orders", (route) => (
        route.request().method() === "POST"
          ? route.fulfill({ status: 409, json: { ok: false, dates: open } })
          : route.fallback()
      ));

      const order = await openOrder(page, MEMBER);

      await firstRound(page, order);
      await pay(order);

      const dialog = page.locator("#order-lapsed");

      await expect(dialog, state).toBeVisible();
      if (open.length) {
        expect(open.length, "the later round").toBeGreaterThan(0);
        await expect(dialog.getByText(
          "That group order date is no longer available", { exact: true }
        ), `${state}: its title`).toBeVisible();
        await expect(dialog.getByText("Nothing has been charged. Pay " +
          "again once you've chosen another date.", { exact: true }),
        `${state}: its lead`).toBeVisible();
        await expect(dialog.getByText("Use this date", { exact: true }),
          `${state}: its button`).toBeVisible();
      } else {
        await expect(dialog.getByText(
          "No group orders are open right now", { exact: true }
        ), `${state}: its title`).toBeVisible();
        await expect(dialog.getByText("Choose on-farm pickup, a pick-up " +
          "day or delivery instead", { exact: true }),
        `${state}: the other ways`).toBeVisible();
      }

      await page.evaluate(() => localStorage.clear());
    }
  });

  test("A customer who isn't a member (any more) sees \"We couldn't " +
    "complete your group order. Please try again.\", and back on the " +
    "order page the Group orders option no longer shows", async ({
    page, baseURL,
  }) => {
    // The page still holds the membership, but the server does not:
    // the order goes to the real /api/orders, where this customer is in
    // no group (the session cookie is the page's alone), as for one
    // the farm has just removed. Nothing is charged.
    await signIn(page, baseURL, MEMBER);

    const order = await openOrder(page, MEMBER);

    await firstRound(page, order);
    await pay(order);
    await expect(page.getByText("We couldn't complete your group order. " +
      "Please try again.", { exact: true }), "the message").toBeVisible();

    // Back on the order page, the account says what the server does:
    // a customer in no group, whom /api/group no longer answers.
    await page.unroute("**/api/me");
    await page.route("**/api/me", (route) => route.fulfill({
      json: NON_MEMBER,
    }));
    await page.unroute("**/api/group");

    const asked = page.waitForResponse((r) => /\/api\/(me|group)\b/
      .test(r.url()), { timeout: 10_000 }).catch(() => null);
    const again = new OrderPage(page);

    await again.open({ whole: 2 });
    await asked;
    await again.scrollSettled();
    await expect(methodRadio(page, "onfarm"), "the order page")
      .toHaveCount(1);
    await expect(groupWay(page), "no Group orders").toHaveCount(0);
  });
});
