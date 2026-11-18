// The on-farm "Pickup time" radios (#616): one per line, with the
// times written in full, as in James's screenshot of 2026-11-18.
// Criteria tests, written before the change from the issue's spec and
// "Done when"; one test per criterion, named for it.
//
// The labels come from the farm's schedule as /api/dates gives it.
// Each test answers /api/dates with lists the real lib/dates.mjs makes
// from a schedule written here, so the windows are known on any day
// the specs run, whether the page or the function formats them.
//
// The value a radio sends is the window's id, the schedule's own range
// text "HH:MM-HH:MM" ("08:00-10:00"), as on `next` before #616: it
// stays.
//
// The unit test of the label's formatter is test/window-label.criteria
// .mjs (held out of npm test until the formatter exists).

import {
  OrderPage, expect, test,
} from "./support/order.mjs";
import { CUSTOMER, ORDER, dates } from "./support/canned.mjs";
import { onFarmDates } from "../assets/scripts/order/lib/dates.mjs";
import { parseSchedule } from "../assets/scripts/order/lib/schedule.mjs";
import { addDays, today } from "../assets/scripts/order/lib/zoned.mjs";

const ZONE = "America/New_York";

// James's five windows (#616, his list), in order, by window id.
const JAMES = [
  ["08:00-10:00", "8:00 – 10:00 AM"],
  ["10:00-12:00", "10:00 AM – 12:00 PM"],
  ["12:00-14:00", "12:00 – 2:00 PM"],
  ["14:00-16:00", "2:00 – 4:00 PM"],
  ["16:00-18:00", "4:00 – 6:00 PM"],
];

// Rule 2's cases: a half-hour start, a window crossing noon, one
// ending at 12:00 PM, both ends AM, both ends PM.
const RULE_2 = [
  ["09:30-11:00", "9:30 – 11:00 AM"],
  ["10:30-12:00", "10:30 AM – 12:00 PM"],
  ["11:00-13:00", "11:00 AM – 1:00 PM"],
  ["11:30-12:30", "11:30 AM – 12:30 PM"],
  ["13:00-15:30", "1:00 – 3:30 PM"],
];

const NO_BREAK = new RegExp(`[${String.fromCharCode(0xa0, 0x202f)}]`);

// Two days from today, James's windows on the first and rule 2's on
// the second, as /api/dates lists them.
const days = () => {
  const start = today(new Date(), ZONE);

  return [addDays(start, 2), addDays(start, 3)];
};

const listsWith = () => {
  const [james, rule2] = days();
  const text = [
    `${james} ${JAMES.map(([id]) => id).join(" ")}`,
    `${rule2} ${RULE_2.map(([id]) => id).join(" ")}`,
  ].join("\n");
  const { windows } = parseSchedule(text);

  return {
    ...dates(),
    onfarm: onFarmDates(new Date(), { timeZone: ZONE }, windows),
  };
};

const answer = (page, lists) => page.route(
  "**/api/dates", (route) => route.fulfill({ json: lists }),
);

const radios = (page) => page.locator(
  "[data-windows] input[type='radio'][name='onfarm.window']"
);

// The order page on on-farm pickup, the day `date` chosen.
const openOn = async (page, date) => {
  const order = new OrderPage(page);

  await order.open({ eggs: 1 }, { method: "onfarm" });
  await page.locator("#onfarm-date").selectOption(date);
  await expect(radios(page).first()).toBeVisible();

  return order;
};

// Each radio's label, as text, its lines counted from the boxes its
// text draws (one top per line).
const labels = (inputs) => inputs.evaluateAll((els) => els.map((el) => {
  const label = el.labels[0];
  const range = document.createRange();

  range.selectNodeContents(label);

  const tops = new Set([...range.getClientRects()]
    .filter((r) => r.width > 0 && r.height > 0)
    .map((r) => Math.round(r.top + r.height / 2)));
  const lines = [...tops].sort((a, b) => a - b)
    .filter((t, i, all) => i === 0 || t - all[i - 1] > 4).length;

  return { text: label.textContent.trim(), lines, value: el.value };
}));

test.describe("on-farm pickup times (#616)", () => {
  // Rule 1: 390 px on the phone project, 1280 px on the desktop one.
  test("at 390 and 1280 px each on-farm time radio sits on its own " +
    "line, in order", async ({ page }, info) => {
    const width = info.project.name === "desktop" ? 1280 : 390;

    if (info.project.name === "desktop") {
      await page.setViewportSize({ width, height: 900 });
    }
    expect(page.viewportSize().width).toBe(width);

    const lists = listsWith();
    const [james] = days();

    await answer(page, lists);
    await openOn(page, james);
    await expect(radios(page)).toHaveCount(JAMES.length);

    // The order by each radio's window, so this test is about layout
    // alone; the words are the next test's.
    const got = await labels(radios(page));

    expect(got.map((g) => g.value), "in the screenshot's order")
      .toEqual(JAMES.map(([id]) => id));

    const boxes = await radios(page).evaluateAll((els) => els.map((el) => {
      const r = el.getBoundingClientRect();

      return { top: r.top, bottom: r.bottom };
    }));

    for (let i = 1; i < boxes.length; i += 1) {
      expect(boxes[i].top, `radio ${i + 1} below radio ${i}`)
        .toBeGreaterThanOrEqual(boxes[i - 1].bottom);
    }
  });

  test("the labels read exactly as in James's list and follow rule 2 " +
    "for any window", async ({ page }) => {
    const lists = listsWith();
    const [james, rule2] = days();

    await answer(page, lists);
    await openOn(page, james);
    await expect(radios(page)).toHaveCount(JAMES.length);
    expect((await labels(radios(page))).map((g) => g.text))
      .toEqual(JAMES.map(([, text]) => text));

    await page.locator("#onfarm-date").selectOption(rule2);
    await expect(radios(page)).toHaveCount(RULE_2.length);
    expect((await labels(radios(page))).map((g) => g.text))
      .toEqual(RULE_2.map(([, text]) => text));
  });

  test("no label holds noon or a no-break space, and none breaks " +
    "across lines", async ({ page }, info) => {
    if (info.project.name === "desktop") {
      await page.setViewportSize({ width: 1280, height: 900 });
    }

    const lists = listsWith();

    await answer(page, lists);
    await openOn(page, days()[0]);
    for (const date of days()) {
      await page.locator("#onfarm-date").selectOption(date);
      await expect(radios(page).first()).toBeVisible();
      for (const { text, lines } of await labels(radios(page))) {
        expect(text).not.toMatch(/noon/i);
        expect(text, `${text}: no U+00A0 or U+202F`).not.toMatch(NO_BREAK);
        expect(lines, `${text} on one line`).toBe(1);
      }
    }
    // The markup too: no entity or character hides in the label.
    const html = await page.locator("[data-windows]").innerHTML();

    expect(html).not.toMatch(NO_BREAK);
    expect(html).not.toMatch(/&nbsp;|&#x?(a0|160|202f|8239);/i);
  });

  test("the value sent with the order for each window is unchanged",
    async ({ page }) => {
      const lists = listsWith();
      const [james, rule2] = days();
      let posted;

      await answer(page, lists);
      // The order is never placed: the server's 409 answers it, with
      // the on-farm list, and the body is read.
      await page.route("**/api/orders", (route) => {
        if (route.request().method() !== "POST") return route.fallback();
        posted = route.request().postDataJSON();

        return route.fulfill({
          status: 409, json: { ok: false, dates: lists.onfarm },
        });
      });

      const order = await openOn(page, rule2);

      expect((await labels(radios(page))).map((g) => g.value))
        .toEqual(RULE_2.map(([id]) => id));
      await page.locator("#onfarm-date").selectOption(james);
      await expect(radios(page)).toHaveCount(JAMES.length);
      expect((await labels(radios(page))).map((g) => g.value))
        .toEqual(JAMES.map(([id]) => id));

      const chosen = radios(page).nth(1);

      await chosen.check();
      await expect(chosen).toBeChecked();
      await order.contact({ email: "onfarm-times@example.com" });
      await order.openCard();
      await order.card();
      await order.submit.click();
      await expect.poll(() => posted).toBeTruthy();
      expect(posted.fulfilment).toMatchObject({
        method: "onfarm", date: james, onfarm: { window: "10:00-12:00" },
      });
    });

  // Rule 3: the same choice wherever the customer picks an on-farm
  // time in the browser. The lapsed dialog lists each open time as
  // "<day>, <time>", as on production.
  test("the lapsed dialog's on-farm times read the same",
    async ({ page }) => {
      const lists = listsWith();

      await answer(page, lists);
      await page.route("**/api/orders", (route) => (
        route.request().method() === "POST"
          ? route.fulfill({
            status: 409, json: { ok: false, dates: lists.onfarm },
          })
          : route.fallback()
      ));

      const order = await openOn(page, days()[0]);

      await order.contact({ email: "lapsed@example.com" });
      await order.openCard();
      await order.card();
      await order.submit.click();

      const dialog = page.locator("#order-lapsed");
      const [first, second] = lists.onfarm;

      await expect(dialog).toBeVisible();
      await expect(dialog.locator("label")).toHaveText([
        ...JAMES.map(([, text]) => `${first.label}, ${text}`),
        ...RULE_2.map(([, text]) => `${second.label}, ${text}`),
      ]);
    });

  // Rule 3: the account's Change pickup offers on-farm times too.
  test("Change pickup's on-farm times read the same",
    async ({ page, context, baseURL }) => {
      const lists = listsWith();
      const [james, rule2] = days();
      const order = {
        ...ORDER,
        fulfilment: {
          method: "onfarm", date: james, state: "requested",
          onfarm: { window: "08:00-10:00", from: "08:00", to: "10:00" },
        },
      };

      await context.addCookies([{
        name: "nff_signed_in", value: "1", url: baseURL,
      }]);
      await page.route("**/api/me", (route) => route.fulfill({
        json: { signedIn: true, customer: CUSTOMER },
      }));
      await page.route("**/api/account/orders", (route) => route.fulfill({
        json: { orders: [order] },
      }));
      await page.route("**/api/account/cart", (route) => route.fulfill({
        json: { ok: true, cart: null },
      }));
      await answer(page, lists);
      await page.goto("/account/#orders");
      await page.getByRole("button", { name: /^Change (delivery|pickup)$/ })
        .first().click();

      const form = page.locator(".account-panel-form");
      const times = form.locator("[data-windows] input[type='radio']");
      // A radio with no label reads as such, so the failure says so.
      const texts = () => times.evaluateAll((els) => els.map((el) => {
        const label = el.labels[0] || el.closest("label");

        return label ? label.textContent.trim() : "(no label)";
      }));

      await expect(times).toHaveCount(JAMES.length);
      expect(await texts()).toEqual(JAMES.map(([, text]) => text));
      await form.locator("[data-dates]").selectOption(rule2);
      await expect(times).toHaveCount(RULE_2.length);
      expect(await texts()).toEqual(RULE_2.map(([, text]) => text));
      for (const text of await texts()) {
        expect(text).not.toMatch(/noon/i);
        expect(text).not.toMatch(NO_BREAK);
      }
    });
});
