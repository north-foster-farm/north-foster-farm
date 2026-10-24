// Farm news sign-up forms hide from people already on the list
// (#267), in the footer and on the news page. A signed-in customer
// follows the server's opt-in; anyone else follows a flag this
// browser sets after signing up and the unsubscribe page clears.
// /api/me and the sign-up request are stubbed.

import {
  OrderPage, expect, test, uniqueEmail,
} from "./support/order.mjs";

const PAGES = [
  { name: "the footer", path: "/about/", block: "footer [data-news-block]" },
  { name: "the news page", path: "/news/", block: "main [data-news-block]" },
];

const me = (page, marketing) => page.route("**/api/me", (route) =>
  route.fulfill({ json: {
    signedIn: true,
    customer: { email: "qa-e2e-hide@example.com", marketing },
  } }));

const stamp = (context, baseURL) => context.addCookies([
  { name: "nff_signed_in", value: "1", url: baseURL },
]);

for (const { name, path, block } of PAGES) {
  test.describe(`farm news forms in ${name} (#267)`, () => {
    test("show to a visitor with no flag", async ({ page }) => {
      await page.goto(path);
      await expect(page.locator(block)).toBeVisible();
    });

    test("hide once this browser has signed up, and stay hidden",
      async ({ page }) => {
        await page.route("**/api/news/subscribe", (route) =>
          route.fulfill({ json: { ok: true } }));
        await page.goto(path);

        const form = page.locator(`${block} [data-news-signup]`);

        await form.locator("input[type='email']").fill("you@example.com");
        await form.getByRole("button").click();
        await expect(form.locator("[data-news-note]"))
          .toHaveText("You're on the list. Thanks!");

        const kept = await page.evaluate(() =>
          Object.values(localStorage).join(" "));

        expect(kept, "the flag never holds the address").not.toContain("@");

        await page.reload();
        await expect(page.locator(block)).toBeHidden();
      });

    test("show again after the unsubscribe page, in this browser",
      async ({ page }) => {
        // Only on the first load; the init script runs on every one.
        await page.addInitScript(() => {
          if (location.search) localStorage.setItem("nff-news", "joined");
        });
        await page.route("**/api/news/unsubscribe", (route) =>
          route.fulfill({ json: { ok: true } }));
        await page.goto("/news/?unsubscribe=abc");
        await expect(page.locator("[data-news-note]").first())
          .toHaveText("You're off the list. We won't send you farm news.");
        expect(await page.evaluate(() => localStorage.getItem("nff-news")))
          .toBeNull();

        await page.goto(path);
        await expect(page.locator(block)).toBeVisible();
      });

    test("hide for a signed-in customer who is opted in, flag or not",
      async ({ page, context, baseURL }) => {
        await stamp(context, baseURL);
        await me(page, true);
        await page.goto(path);
        await expect(page.locator(block)).toBeHidden();
      });

    test("show for a signed-in customer who is not, and drop the flag",
      async ({ page, context, baseURL }) => {
        await stamp(context, baseURL);
        await page.addInitScript(() => localStorage.setItem("nff-news",
          "joined"));
        await me(page, false);
        await page.goto(path);
        await expect(page.locator(block)).toBeVisible();
        expect(await page.evaluate(() => localStorage.getItem("nff-news")))
          .toBeNull();
      });
  });
}

test.describe("the order page's farm news opt-in (#391)", () => {
  const block = "#confirm [data-news-block]";

  test("shows, subheading and box, to a visitor with no flag",
    async ({ page }) => {
      await page.goto("/order/");
      await expect(page.locator(block)).toBeVisible();
      await expect(page.locator(`${block} h3`))
        .toHaveText("Farm news and updates");
      await expect(page.locator("#customer-marketing")).toBeVisible();
    });

  test("hides, subheading and box, once this browser has joined",
    async ({ page }) => {
      await page.addInitScript(() => localStorage.setItem("nff-news",
        "joined"));
      await page.goto("/order/");
      await expect(page.locator(block)).toBeHidden();
      await expect(page.locator(`${block} h3`)).toBeHidden();
    });

  test("hides for a signed-in customer on the list and sends no yes",
    async ({ page, context, baseURL }) => {
      await stamp(context, baseURL);
      await me(page, true);
      await page.goto("/order/");
      await expect(page.locator(block)).toBeHidden();
      await expect(page.locator("#customer-marketing")).not.toBeChecked();
    });

  test("a hidden block sends marketing false, never a no",
    async ({ page, context, baseURL }) => {
      let body = null;

      await stamp(context, baseURL);
      await me(page, true);
      // Stubbed, so no order is placed; only the request is read.
      await page.route("**/api/orders", (route) => {
        body = route.request().postDataJSON();

        return route.fulfill({
          status: 429,
          contentType: "application/json",
          headers: { "Retry-After": "600" },
          body: JSON.stringify({ message: "Stubbed." }),
        });
      });

      const order = new OrderPage(page);

      await order.open({ eggs: 1 });
      await order.method("onfarm");
      await order.contact({
        first: "Hide", email: uniqueEmail("hide"),
      });
      await order.firstDate("onfarm");
      await expect(page.locator(block)).toBeHidden();
      await order.openCard();
      await order.card();
      await order.submit.click();
      await expect(order.payError).toBeVisible();

      expect(body, "the order was posted").not.toBeNull();
      expect(body.customer.marketing,
        "a hidden block says false, which changes no record")
        .toBe(false);
    });

  test("shows for a signed-in customer who is not on the list",
    async ({ page, context, baseURL }) => {
      await stamp(context, baseURL);
      await me(page, false);
      await page.goto("/order/");
      await expect(page.locator(block)).toBeVisible();
    });
});

test("a hidden form leaves no gap, a shown one does not move",
  async ({ page, context, baseURL }) => {
    await page.goto("/about/");

    const height = () => page.evaluate(
      () => document.documentElement.scrollHeight);
    const shown = await height();

    await page.evaluate(() => localStorage.setItem("nff-news", "joined"));
    await page.reload();
    await expect(page.locator("footer [data-news-block]")).toBeHidden();
    expect(await height()).toBeLessThan(shown);

    await stamp(context, baseURL);
    await page.evaluate(() => localStorage.removeItem("nff-news"));
    await me(page, false);
    await page.reload();

    const block = page.locator("footer [data-news-block]");

    await expect(block).toBeVisible();
    expect(await height(), "the same page as the first view")
      .toBe(shown);
  });
