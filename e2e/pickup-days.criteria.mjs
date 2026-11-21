// Criteria tests for #703: pickup days grouped by date, with Copy and
// Map, on the order page's Pickup days card, in the lapsed dialog and
// in the account's Change pickup. Written before the change from the
// issue's spec, James's three mockups and his decisions of 2026-11-21;
// one test per criterion, named for it. The parts each card shows
// (test/pickup-days.criteria.mjs) are unit tests; this file holds what
// needs a browser.
//
// Held out of every run by its name (playwright.config.mjs matches
// *.spec.mjs). The change that meets #703 turns it on with
//
//   git mv e2e/pickup-days.criteria.mjs e2e/pickup-days.spec.mjs
//
// and maps it in e2e/dispatch.json beside order-scheduled.spec.mjs
// (the order page, the account page and their scripts).
//
// The markup, the same in all three homes (James: "one layout for
// this purpose, not two"):
//
// - each date is a `.order-pickup-day`, holding one heading (any
//   element with the heading role) that reads the day and date,
//   "Saturday, November 21", then that date's pickups;
// - each pickup is a `.order-pickup` holding its radio, valued by the
//   occurrence id, and its parts: `.order-pickup-name` ("North
//   Scituate · Drop site"), `.order-pickup-time` ("10:00 – 11:00 AM"),
//   `.order-pickup-place` when the location has a place name ("Shady
//   Acres Diner"), `.order-pickup-street` ("46 Institute Lane") and
//   `.order-pickup-city` ("North Scituate, RI 02857");
// - and two controls outside the radio's label: a button named "Copy"
//   and a link named "Map" (a visually hidden "(opens in a new tab)"
//   after it is fine).
//
// The homes: #scheduled-pickups on the order page, #order-lapsed, and
// the account's .account-panel-form.

import {
  CUSTOMER, ORDER_SCHEDULED,
} from "./support/canned.mjs";
import {
  OrderPage, expect, pickupChosen, test,
} from "./support/order.mjs";
import {
  DROP, FOSTER, cannedScheduled, datesWith, payable,
} from "./support/scheduled.mjs";

const NARROW = { width: 390, height: 844 };
const WIDE = { width: 1500, height: 900 };

// What each place's card shows: the drop site, named for its street,
// and the Foster market at a place with a name of its own.
const SHOWS = {
  [DROP.series]: {
    name: "North Scituate · Drop site", time: "10:00 – 11:00 AM",
    place: "", street: "46 Institute Lane",
    city: "North Scituate, RI 02857",
    copy: "46 Institute Lane, North Scituate, RI 02857",
    map: "/#place-46-institute-lane",
  },
  [FOSTER.series]: {
    name: "Foster Farmers’ Market", time: "9:00 AM – 1:00 PM",
    place: "Shady Acres Diner", street: "164 Danielson Pike",
    city: "Foster, RI 02825",
    copy: "164 Danielson Pike, Foster, RI 02825",
    map: "/#place-shady-acres-diner",
  },
};

// Two pickups on one date, then one date each.
const grouped = () => datesWith([
  { place: DROP, days: [3, 10] },
  { place: FOSTER, days: [3, 9] },
]);

// The layout the lists should give: a heading per date, in order, and
// under each its pickups, in the list's order, each with its parts and
// its two controls.
const expected = (lists) => {
  const days = [];

  for (const d of lists.scheduled) {
    if (days.at(-1)?.heading !== d.label) {
      days.push({ heading: d.label, pickups: [] });
    }
    days.at(-1).pickups.push({
      value: d.occurrence, ...SHOWS[d.series], copyButton: true,
    });
  }
  return days;
};

// The layout a home shows, read from the page.
const layoutOf = (scope) => scope.locator(".order-pickup-day")
  .evaluateAll((days) => days.map((day) => {
    const text = (el, s) => (el.querySelector(s)?.innerText || "").trim();
    const heads = [...day.querySelectorAll(
      "h1, h2, h3, h4, h5, h6, [role='heading']"
    )];

    return {
      heading: heads.length === 1 ? heads[0].innerText.trim()
        : `${heads.length} headings`,
      pickups: [...day.querySelectorAll(".order-pickup")].map((p) => {
        const map = [...p.querySelectorAll("a")]
          .find((a) => /^Map\b/.test(a.textContent.trim()));
        const href = map ? new URL(map.href) : null;

        return {
          value: p.querySelector("input[type='radio']")?.value || "",
          name: text(p, ".order-pickup-name"),
          time: text(p, ".order-pickup-time"),
          place: text(p, ".order-pickup-place"),
          street: text(p, ".order-pickup-street"),
          city: text(p, ".order-pickup-city"),
          map: href ? `${href.pathname}${href.hash}` : "",
          copyButton: [...p.querySelectorAll("button")]
            .some((b) => b.textContent.trim() === "Copy"),
        };
      }),
    };
  }));
// What Copy copies is read by pressing it (the Copy test), not from
// the markup, so a layout leaves it out.
const withoutCopy = (days) => days.map((d) => ({
  ...d,
  pickups: d.pickups.map((p) => Object.fromEntries(
    Object.entries(p).filter(([key]) => key !== "copy")
  )),
}));

const card = (scope, value) => scope.locator(
  `.order-pickup:has(input[value='${value}'])`
);
const first = (lists, series) => lists.scheduled
  .find((d) => d.series === series).occurrence;

// The order page with `lists`, the Pickup days card open.
const openPickups = async (page, lists = grouped()) => {
  await cannedScheduled(page, lists);

  const order = new OrderPage(page);

  await order.open({ eggs: 1 }, { method: "scheduled" });
  await expect(page.locator("#scheduled-pickups .order-pickup").first())
    .toBeVisible();

  return order;
};

const box = (locator) => locator.evaluate((el) => {
  const r = el.getBoundingClientRect();

  return { x: r.left, y: r.top, right: r.right, bottom: r.bottom,
    height: r.height,
    line: parseFloat(getComputedStyle(el).lineHeight) || 0 };
});

// The tops of the lines an element's text sits on, near-equal tops
// counted once.
const lineTops = (locator) => locator.evaluate((el) => {
  const range = document.createRange();

  range.selectNodeContents(el);

  const tops = [...range.getClientRects()].filter((r) => r.width > 0)
    .map((r) => r.top).sort((a, b) => a - b);

  return tops.filter((t, i) => i === 0 || t - tops[i - 1] > 2);
});

// The clipboard as a list of what was written, so the test reads the
// copy in every browser.
const stubClipboard = (page) => page.addInitScript(() => {
  window.copiedText = [];
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: async (t) => { window.copiedText.push(t); },
      readText: async () => window.copiedText.at(-1) || "",
    },
  });
});

test.describe("pickup days grouped by date (#703)", () => {
  test("pickups are grouped under a heading showing the day and date; " +
    "several pickups on one date sit together under that one heading",
  async ({ page }) => {
    const lists = grouped();

    await openPickups(page, lists);

    const home = page.locator("#scheduled-pickups");
    const days = home.locator(".order-pickup-day");
    const want = expected(lists);

    await expect(days).toHaveCount(want.length);
    for (const [i, day] of want.entries()) {
      await expect(days.nth(i).getByRole("heading"))
        .toHaveText(day.heading);
      expect(await days.nth(i).locator(".order-pickup input[type='radio']")
        .evaluateAll((inputs) => inputs.map((r) => r.value)))
        .toEqual(day.pickups.map((p) => p.value));
    }
    // The first date holds both its pickups, under its one heading.
    expect(want[0].pickups).toHaveLength(2);
    // The heading replaces the date on each card.
    for (const d of lists.scheduled) {
      await expect(card(home, d.occurrence)).not.toContainText(d.label);
    }
  });

  test("the choices are indented slightly under their heading, like " +
    "list items", async ({ page }) => {
    await openPickups(page);

    for (const size of [WIDE, NARROW]) {
      await page.setViewportSize(size);

      const days = page.locator("#scheduled-pickups .order-pickup-day");

      // A heading per date, so the loop below has something to measure.
      await expect(days).toHaveCount(3);
      for (const day of await days.all()) {
        const head = await box(day.getByRole("heading"));
        const pickups = day.locator(".order-pickup");

        await expect(pickups.first()).toBeVisible();
        for (const pickup of await pickups.all()) {
          const at = await box(pickup);
          const indent = at.x - head.x;

          expect(indent, `indent at ${size.width}px`)
            .toBeGreaterThanOrEqual(8);
          expect(indent, `indent at ${size.width}px`)
            .toBeLessThanOrEqual(48);
        }
      }
    }
  });

  test("on narrow displays the address is street on the first line and " +
    "city, state and zip on the second", async ({ page }) => {
    const lists = grouped();

    await page.setViewportSize(NARROW);
    await openPickups(page, lists);

    for (const series of [DROP.series, FOSTER.series]) {
      const pickup = card(page.locator("#scheduled-pickups"),
        first(lists, series));
      const street = pickup.locator(".order-pickup-street");
      const city = pickup.locator(".order-pickup-city");

      await expect(street).toHaveText(SHOWS[series].street);
      await expect(city).toHaveText(SHOWS[series].city);
      expect(await lineTops(street), "the street on one line")
        .toHaveLength(1);
      expect(await lineTops(city), "city, state and zip on one line")
        .toHaveLength(1);

      const s = await box(street);
      const c = await box(city);

      expect(c.y, "city, state and zip below the street")
        .toBeGreaterThanOrEqual(s.bottom - 1);

      // Copy and Map below the address (the narrow mockups).
      for (const control of [
        pickup.getByRole("button", { name: "Copy" }),
        pickup.getByRole("link", { name: /^Map\b/ }),
      ]) {
        expect((await box(control)).y, "Copy and Map below the address")
          .toBeGreaterThanOrEqual(c.bottom - 1);
      }
    }
  });

  // The wide mockup, as the issue's spec reads it: "the address is one
  // line ... with Copy and Map to its right".
  test("wide, the address is one line with Copy and Map to its right",
    async ({ page }) => {
      const lists = grouped();

      await page.setViewportSize(WIDE);
      await openPickups(page, lists);

      const pickup = card(page.locator("#scheduled-pickups"),
        first(lists, DROP.series));
      const street = await box(pickup.locator(".order-pickup-street"));
      const city = await box(pickup.locator(".order-pickup-city"));

      expect(Math.abs(city.y - street.y), "street and city on one line")
        .toBeLessThanOrEqual(2);
      expect(city.x).toBeGreaterThan(street.x);
      for (const control of [
        pickup.getByRole("button", { name: "Copy" }),
        pickup.getByRole("link", { name: /^Map\b/ }),
      ]) {
        const at = await box(control);

        expect(at.x, "to the address's right")
          .toBeGreaterThanOrEqual(city.right);
        expect(at.y, "beside the address").toBeLessThan(city.bottom);
        expect(at.bottom, "beside the address").toBeGreaterThan(city.y);
      }
    });

  test("a location with a place name shows it on the first line, above " +
    "the street", async ({ page }) => {
    const lists = grouped();

    await openPickups(page, lists);

    const home = page.locator("#scheduled-pickups");

    for (const size of [WIDE, NARROW]) {
      await page.setViewportSize(size);

      const foster = card(home, first(lists, FOSTER.series));
      const place = foster.locator(".order-pickup-place");

      await expect(place).toHaveText("Shady Acres Diner");

      const p = await box(place);
      const time = await box(foster.locator(".order-pickup-time"));
      const street = await box(foster.locator(".order-pickup-street"));

      expect(p.y, `the place name after the time at ${size.width}px`)
        .toBeGreaterThanOrEqual(time.bottom - 1);
      expect(street.y, `the street below the place at ${size.width}px`)
        .toBeGreaterThanOrEqual(p.bottom - 1);

      // The drop site is named for its street: no place line.
      const drop = card(home, first(lists, DROP.series));

      await expect(drop.locator(".order-pickup-place:visible"))
        .toHaveCount(0);
    }
  });

  test("a place name that wraps sets its wrapped lines slightly closer " +
    "together than the lines of the address, so they read as one name",
  async ({ page }) => {
    const lists = grouped();

    await page.setViewportSize(NARROW);
    await openPickups(page, lists);

    const foster = card(page.locator("#scheduled-pickups"),
      first(lists, FOSTER.series));
    const place = foster.locator(".order-pickup-place");

    // James's long example, in place of the real name.
    await place.evaluate((el) => {
      el.textContent = "Inside of Shady Acres Diner And Really Long " +
        "Location Name";
    });

    const name = await lineTops(place);
    const street = await lineTops(foster.locator(".order-pickup-street"));
    const city = await lineTops(foster.locator(".order-pickup-city"));

    expect(name.length, "the long name wraps").toBeGreaterThanOrEqual(2);

    const wrapped = name[1] - name[0];
    const address = city[0] - street[0];

    expect(wrapped, "the name's lines closer than the address's")
      .toBeLessThan(address - 1);
    expect(wrapped, "only slightly closer")
      .toBeGreaterThanOrEqual(address * 0.6);
    // The name's last line is as far from the street as the address's
    // lines are from each other, or farther.
    expect(street[0] - name.at(-1), "the street a full line below")
      .toBeGreaterThanOrEqual(address - 1);
  });

  test("each location has a Copy button and a Map button, both outline " +
    "style", async ({ page }) => {
    const lists = grouped();

    await openPickups(page, lists);

    const green = await page.evaluate(() => `rgb(${getComputedStyle(
      document.documentElement
    ).getPropertyValue("--bs-primary-rgb").trim()})`);
    const pickups = page.locator("#scheduled-pickups .order-pickup");

    await expect(pickups).toHaveCount(lists.scheduled.length);
    for (const pickup of await pickups.all()) {
      const copy = pickup.getByRole("button", { name: "Copy" });
      const map = pickup.getByRole("link", { name: /^Map\b/ });

      await expect(copy).toHaveCount(1);
      await expect(map).toHaveCount(1);
      for (const control of [copy, map]) {
        await expect(control).toBeVisible();
        await expect(control).toHaveClass(/\bbtn-outline-/);

        const style = await control.evaluate((el) => {
          const s = getComputedStyle(el);

          return { bg: s.backgroundColor, border: s.borderTopColor,
            width: parseFloat(s.borderTopWidth), color: s.color };
        });

        expect(style.bg, "an outline button is not filled")
          .toBe("rgba(0, 0, 0, 0)");
        expect(style.width).toBeGreaterThan(0);
        // In the brand green, as the mockups draw them.
        expect(style.border).toBe(green);
        expect(style.color).toBe(green);
      }
    }
  });

  test("Copy copies the street address as one line, without the place " +
    "name, and briefly shows Copied", async ({ page }) => {
    const lists = grouped();

    await stubClipboard(page);
    await openPickups(page, lists);

    const home = page.locator("#scheduled-pickups");
    const copied = () => page.evaluate(() => window.copiedText);

    for (const [i, series] of [DROP.series, FOSTER.series].entries()) {
      const pickup = card(home, first(lists, series));

      await pickup.getByRole("button", { name: "Copy" }).click();
      await expect.poll(copied).toHaveLength(i + 1);
      expect((await copied())[i]).toBe(SHOWS[series].copy);
      await expect(pickup).toContainText("Copied");
      // Briefly: it goes back to Copy on its own.
      await expect(pickup).not.toContainText("Copied", { timeout: 6000 });
      await expect(pickup.getByRole("button", { name: "Copy" }))
        .toBeVisible();
    }
    expect((await copied()).join(" ")).not.toContain("Shady Acres Diner");
  });

  test("Map opens the location on the Places tab of the home page's " +
    "map, in a new browser tab", async ({ page, request }) => {
    const lists = grouped();

    await openPickups(page, lists);

    const home = page.locator("#scheduled-pickups");
    const map = card(home, first(lists, DROP.series))
      .getByRole("link", { name: /^Map\b/ });

    await expect(map).toHaveAttribute("target", "_blank");

    // The home page has the pin the link names.
    const slug = SHOWS[DROP.series].map.split("#")[1];
    const html = await (await request.get("/")).text();

    expect(html).toContain(`data-map-slug="${slug}"`);

    const [tab] = await Promise.all([
      page.context().waitForEvent("page"),
      map.click(),
    ]);

    await tab.waitForLoadState("domcontentloaded");

    const url = new URL(tab.url());

    expect(`${url.pathname}${url.hash}`).toBe(SHOWS[DROP.series].map);
    await expect(tab.locator("[data-map-layer='places']").first())
      .toHaveAttribute("aria-selected", "true");
    await expect(tab.locator(`[data-map-slug='${slug}']`).first())
      .toHaveAttribute("aria-pressed", "true");
    // And the order page stays where it was.
    expect(new URL(page.url()).pathname).toBe("/order/");
    await tab.close();
  });

  // The issue's draft, which James may overrule on the pull request.
  test("pressing Copy or Map does not choose the pickup",
    async ({ page }) => {
      const lists = grouped();

      await stubClipboard(page);
      await openPickups(page, lists);

      const pickup = card(page.locator("#scheduled-pickups"),
        first(lists, DROP.series));

      await pickup.getByRole("button", { name: "Copy" }).click();
      await expect(pickup).toContainText("Copied");
      await expect(pickupChosen(page)).toHaveCount(0);

      const [tab] = await Promise.all([
        page.context().waitForEvent("page"),
        pickup.getByRole("link", { name: /^Map\b/ }).click(),
      ]);

      await tab.close();
      await expect(pickupChosen(page)).toHaveCount(0);
      await expect(pickup.locator("input[type='radio']")).not.toBeChecked();
    });

  test("the same layout goes into the order page's Pickup days card, " +
    "the lapsed dialog and the account's Change pickup",
  async ({ page, context, baseURL }) => {
    const lists = grouped();
    const want = withoutCopy(expected(lists));

    await test.step("the order page", async () => {
      await openPickups(page, lists);
      expect(withoutCopy(await layoutOf(page.locator("#scheduled-pickups"))))
        .toEqual(want);
    });

    await test.step("the lapsed dialog", async () => {
      // A payable drop site Saturday goes stale as the customer pays;
      // the 409 offers the grouped lists. A route added later answers
      // first.
      await cannedScheduled(page, payable());
      await page.route("**/api/orders", (route) => (
        route.request().method() === "POST"
          ? route.fulfill({
            status: 409, json: { ok: false, dates: lists.scheduled },
          })
          : route.fallback()
      ));

      const order = new OrderPage(page);

      await order.open({ eggs: 1 }, { method: "scheduled" });
      await order.scheduled(DROP.series);
      await order.contact({ email: "lapsed@example.com" });
      await order.openCard();
      await order.card();
      await order.submit.click();

      const dialog = page.locator("#order-lapsed");

      await expect(dialog).toBeVisible();
      expect(withoutCopy(await layoutOf(dialog))).toEqual(want);
    });

    await test.step("the account's Change pickup", async () => {
      const booked = lists.scheduled[0];
      const placed = {
        ...ORDER_SCHEDULED,
        fulfilment: { ...ORDER_SCHEDULED.fulfilment,
          occurrence: booked.occurrence, date: booked.date },
        pickup: { ...ORDER_SCHEDULED.pickup, series: DROP.series,
          occurrence: booked.occurrence },
      };

      await context.addCookies([{
        name: "nff_signed_in", value: "1", url: baseURL,
      }]);
      await page.route("**/api/me", (route) => route.fulfill({
        json: { signedIn: true, customer: CUSTOMER },
      }));
      await page.route("**/api/account/orders", (route) => route.fulfill({
        json: { orders: [placed] },
      }));
      await page.route("**/api/account/cart", (route) => route.fulfill({
        json: { ok: true, cart: null },
      }));
      await cannedScheduled(page, lists);
      await page.goto("/account/#orders");
      await page.getByRole("button", { name: "Change pickup" }).first()
        .click();

      const form = page.locator(".account-panel-form");

      await expect(form.locator(".order-pickup").first()).toBeVisible();
      expect(withoutCopy(await layoutOf(form))).toEqual(want);
      // The booked pickup is the one chosen.
      await expect(card(form, booked.occurrence)
        .locator("input[type='radio']")).toBeChecked();
    });
  });
});
