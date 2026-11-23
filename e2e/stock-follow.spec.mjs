// Criteria tests for #908 (Order page: follow stock within seconds
// while a customer is browsing), the boxes a browser has to show, one
// test each, named for its box, with the page's clock faked. The rest
// are unit tests, test/stock-follow.criteria.mjs. Written to James's
// rules of 2026-11-23 ("Decided" on the issue): interaction drives the
// check, a background check once a minute, one 15-second floor for
// every trigger, search checking on focus and sharing the order page's
// reader.
//
// Provisional, as the issue leaves them open:
// - "prominent" is read as a notice with role="alert", on the screen
//   when it shows, naming the item and what changed; for the change,
//   "1 left" when cut to one and "removed" when taken out, as today's
//   sentences say (lib/stock-notice.mjs). Today's line is a
//   polite role="status", so it fails;
// - opening the cart is the cart's own toggle, which only a folding
//   cart has (below 1200 px): the desktop project checks adding and
//   changing a quantity, the phone project all three.
//
// Held out of every run by its name until the change lands: renamed to
// stock-follow.spec.mjs and added to e2e/dispatch.json beside
// search-stock.spec.mjs.
//
// The seam, beside search-stock.spec.mjs's: the field is a combobox
// named "Search" in a `role="search"` landmark, opened below 992 px by
// the banner's "Search" button; a product option carries `data-sku`,
// and `data-stock="out"` while out; the landmark says
// `data-stock="ready"` once live stock is applied. An order row is
// `.order-item[data-sku]`, marked `data-out` while out; its first
// `[data-step='1']` adds one; the cart's `[data-cart-toggle]` folds
// and opens it.

import { readFileSync } from "node:fs";

import {
  OrderPage, SKU, expect, foldCart, stockApplied, test, unfoldCart,
} from "./support/order.mjs";
import { findInSearch, searchField } from "./support/search.mjs";
import { stubStock } from "./support/stock-stub.mjs";

const FLOOR = 15_000;
const MINUTE = 60_000;
// Past the floor, short of the next background check.
const STEP = FLOOR + 1_000;

const catalog = JSON.parse(readFileSync(
  new URL("../data/catalog.json", import.meta.url), "utf8"
));
const THIGHS = SKU.thighs;
const NAME = catalog.groups.flatMap((g) => g.items)
  .find((i) => i.sku === THIGHS).name;

test.afterEach(({ page }) => page.unrouteAll({ behavior: "ignoreErrors" }));

// Every request the page makes to /api/stock, as { url, at }.
const watch = (page) => {
  const seen = [];

  page.on("request", (request) => {
    const url = new URL(request.url());

    if (url.pathname === "/api/stock") seen.push(url);
  });

  return seen;
};

// /api/stock as the server answers, with what a test sets in the
// returned object laid on top, read at each answer.
const stub = async (page) => {
  const over = {};

  await stubStock(page, over);

  return over;
};

// Search opened as a customer opens it (support/search.mjs), the query
// typed and live stock in. -> the field and the option for THIGHS.
const search = async (page) => ({
  option: await findInSearch(page, NAME.split(",")[0], THIGHS),
  field: searchField(page),
});

// Sets the stub's answer for THIGHS.
const sell = (over, state) => {
  for (const key of Object.keys(over)) delete over[key];
  Object.assign(over, { [THIGHS]: state });
};

const more = (seen, before, message) => expect.poll(() => seen.length,
  { message }).toBeGreaterThan(before);

test("Adding to the cart, changing a quantity and opening the cart each "
  + "check stock", async ({ page }) => {
  const seen = watch(page);
  const order = new OrderPage(page);

  await page.clock.install();
  await order.open();
  await stockApplied(page);

  const row = await order.showRow("thighs");
  const add = row.locator("[data-step='1']").first();

  await page.clock.fastForward(STEP);

  let before = seen.length;

  await add.click();
  await more(seen, before, "adding checks");

  await page.clock.fastForward(STEP);
  before = seen.length;
  await order.qty("thighs").fill("2");
  await order.qty("thighs").dispatchEvent("change");
  await more(seen, before, "changing a quantity checks");

  const toggle = order.cart.locator("[data-cart-toggle]");

  if (await toggle.isVisible()) {
    await foldCart(page, order.cart);
    await page.clock.fastForward(STEP);
    before = seen.length;
    await unfoldCart(order);
    await more(seen, before, "opening the cart checks");
  }
});

test("An item in the cart that sells out or is cut while the page is open "
  + "is taken out of the cart or cut to what is left, and a prominent "
  + "notice names the item and says what changed in the cart",
async ({ page }) => {
  const over = await stub(page);
  const order = new OrderPage(page);
  const notice = page.getByRole("alert").filter({ hasText: NAME });

  await page.clock.install();
  await order.open({ thighs: 3 });
  await stockApplied(page);
  await expect(order.qty("thighs")).toHaveValue("3");

  sell(over, { inStock: true, available: 1 });
  await page.clock.fastForward(MINUTE + 1_000);
  await expect(order.qty("thighs"), "cut to what is left")
    .toHaveValue("1");
  await expect(notice).toBeVisible();
  await expect(notice).toBeInViewport();
  await expect(notice, "says what is left").toContainText(/\b1 left\b/);

  sell(over, { inStock: false, available: 0 });
  await page.clock.fastForward(MINUTE + 1_000);
  await expect(order.qty("thighs"), "taken out").toHaveValue("0");
  await expect(notice).toBeVisible();
  await expect(notice).toBeInViewport();
  await expect(notice, "says it was taken out").toContainText(/removed/i);
});

test("Search and the order page agree: neither shows an item in stock "
  + "that the other shows out for longer than the rules above allow",
async ({ page }) => {
  const over = await stub(page);
  const order = new OrderPage(page);

  await page.clock.install();
  await order.open();
  await stockApplied(page);

  const row = order.item("thighs");

  await expect(row).not.toHaveAttribute("data-out");

  const first = await search(page);

  await expect(first.option).toBeVisible();
  await expect(first.option).not.toHaveAttribute("data-stock", "out");
  await first.field.press("Escape");

  // Sold out; the page's background check is due within the minute.
  sell(over, { inStock: false, available: 0 });
  await page.clock.fastForward(MINUTE + 1_000);
  await expect(row, "the order page shows it out")
    .toHaveAttribute("data-out", "");

  const again = await search(page);

  await expect(again.option, "search shows it out")
    .toHaveAttribute("data-stock", "out");
});

test("On every page, focusing the search field checks stock, each time it "
  + "is focused and not once per page load", async ({ page }) => {
  const seen = watch(page);

  await page.clock.install();
  await page.goto("/about/");

  const loaded = seen.length;
  const first = await search(page);

  await more(seen, loaded, "the first focus checks");
  await first.field.press("Escape");
  await page.clock.fastForward(STEP);

  const before = seen.length;

  await search(page);
  await more(seen, before, "focused again, it checks again");
});

test("On the order page, search and the page share one stock reader and "
  + "its 15-second floor: search uses the page's answer when the page "
  + "checked in the last 15 seconds, and asks otherwise; search has no "
  + "polling of its own", async ({ page }) => {
  const seen = watch(page);
  const order = new OrderPage(page);

  await page.clock.install();
  await order.open();
  await stockApplied(page);

  const loaded = seen.length;
  const first = await search(page);

  await expect(first.option).toBeVisible();
  expect(seen.length, "inside 15 s: the page's answer").toBe(loaded);
  await first.field.press("Escape");

  await page.clock.fastForward(STEP);
  await search(page);
  await more(seen, loaded, "past 15 s: search asks");
  expect(seen.length, "once").toBe(loaded + 1);
});

test("Search reads the same edge-cached /api/stock as the page",
  async ({ page }) => {
    const seen = watch(page);
    const order = new OrderPage(page);

    await order.open();
    await stockApplied(page);

    const pages = seen.map((u) => `${u.pathname}${u.search}`);

    await page.goto("/about/");

    const before = seen.length;

    await search(page);
    await more(seen, before, "search asks");

    const searched = seen.slice(before).map((u) => `${u.pathname}${u.search}`);

    expect(pages.length, "the page asks").toBeGreaterThan(0);
    for (const url of searched) {
      expect(pages, "the page's own address").toContain(url);
    }
  });
