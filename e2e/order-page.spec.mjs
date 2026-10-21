// The order page and the cart: what a customer sees before paying.
// docs/qa-launch.md, "The order page and cart".

import { readFileSync } from "node:fs";

import { OrderPage, SKU, expect, test } from "./support/order.mjs";

const catalog = JSON.parse(readFileSync(
  new URL("../data/catalog.json", import.meta.url), "utf8"
));

test.describe("order page", () => {
  test("an empty cart owes nothing and cannot continue", async ({ page }) => {
    const order = new OrderPage(page);

    await order.open();
    await expect(page.locator("#method-onfarm")).toBeChecked();
    await order.method("delivery");
    await expect(order.count).toHaveText("0 items");
    await expect(order.subtotal).toHaveText("$0");
    await expect(order.total).toHaveText("$0");
    await expect(order.feeRow).toBeHidden();
    await expect(order.discountRow).toBeHidden();
    await expect(order.next).toBeDisabled();
    await expect(order.nudge).toHaveText(
      "Delivery orders need a $40 minimum."
    );
    await expect(order.short).toHaveText(
      "You need $40 or more in your cart to use this option."
    );
  });

  test("the ways to get an order: the farm first, then the drop site, " +
    "then delivery", async ({ page }) => {
    const order = new OrderPage(page);

    await order.open();
    await expect(page.locator(".order-method-title")).toHaveText([
      "On-farm pickup", "Drop site", "Delivery",
    ]);
  });

  test("the steps run items, pickup or delivery, contact, payment",
    async ({ page }) => {
      const order = new OrderPage(page);

      await order.open();
      await expect(page.locator(".order-rest > .order-section > legend"))
        .toHaveText(["Pickup or delivery", "Contact information", "Payment"]);
      // Farm news sits in the email's own row, under the field (#228).
      expect(await page.locator("#customer-email").evaluate((el) =>
        el.closest(".row").querySelector("#customer-marketing") !== null))
        .toBe(true);
    });

  test("Add becomes a stepper and the cart itemizes the line",
    async ({ page }) => {
      const order = new OrderPage(page);
      const eggs = order.item("eggs");

      await order.open(null, { method: "delivery" });
      // Delivery scrolled the cart settled, open; back up, it floats.
      await order.showRow("eggs");
      // Add is aria-hidden (the stepper's + is the accessible control).
      await eggs.locator(".order-qty-add").click();
      await expect(eggs.locator(".order-qty")).toHaveAttribute(
        "data-qty-state", "active"
      );
      await expect(order.qty("eggs")).toHaveValue("1");
      await order.showRow("eggs");
      await eggs.getByRole("button", { name: "One more" }).click();
      await expect(order.qty("eggs")).toHaveValue("2");

      const line = order.cart.locator(".order-cart-item");

      await expect(line).toHaveCount(1);
      await expect(line.locator(".order-cart-item-name"))
        .toHaveText("Large");
      await expect(line.locator(".order-cart-item-qty")).toHaveText("2 × $7");
      await expect(line.locator(".order-cart-item-sub")).toHaveText("$14");
      await expect(order.cart.locator(".order-cart-group-name"))
        .toHaveText("Eggs");
      await expect(order.count).toHaveText("2 items");
      await expect(order.subtotal).toHaveText("$14");
      // Delivery is chosen and $14 is short: fee shown, total $19.
      await expect(order.fee).toHaveText("+$5");
      await expect(order.total).toHaveText("$19");
    });

  test("the stepper's minus at one removes the item", async ({ page }) => {
    const order = new OrderPage(page);
    const eggs = order.item("eggs");

    await order.open({ eggs: 1 });
    await order.showRow("eggs");
    await expect(eggs.getByRole("button", { name: "Remove" })).toBeVisible();
    await eggs.getByRole("button", { name: "Remove" }).click();
    await expect(order.qty("eggs")).toHaveValue("0");
    await expect(eggs.locator(".order-qty")).toHaveAttribute(
      "data-qty-state", "empty"
    );
    await expect(order.count).toHaveText("0 items");
  });

  test("the × on a cart line takes every unit out", async ({ page }) => {
    const order = new OrderPage(page);

    await order.open({ eggs: 3, wings: 2 });
    await expect(order.count).toHaveText("5 items");
    await order.cart.getByRole("button", {
      name: "Remove Wings, 1.0 – 1.9 lbs from the cart",
    }).click();
    await expect(order.qty("wings")).toHaveValue("0");
    await expect(order.count).toHaveText("3 items");
    await expect(order.subtotal).toHaveText("$21");
  });

  test("the × works on the first click right after typing in a field",
    async ({ page }) => {
      const order = new OrderPage(page);

      await order.open({ wings: 5, eggs: 1 });
      // Leaving a changed field re-renders the cart lines; the click
      // that caused the blur must still land on its ×.
      await order.zip.fill("02857");
      await order.cart.getByRole("button", {
        name: "Remove Wings, 1.0 – 1.9 lbs from the cart",
      }).click();
      await expect(order.qty("wings")).toHaveValue("0");
      await expect(order.count).toHaveText("1 item");
    });

  test("a typed quantity keeps to two digits", async ({ page }) => {
    const order = new OrderPage(page);

    await order.open({ eggs: 1 });
    await order.qty("eggs").fill("");
    await order.qty("eggs").pressSequentially("150");
    await order.qty("eggs").blur();
    await expect(order.qty("eggs")).toHaveValue("15");
    await order.qty("eggs").fill("abc");
    await order.qty("eggs").blur();
    await expect(order.qty("eggs")).toHaveValue("0");
  });

  test("?add= fills the cart, names what it added and clears the query",
    async ({ page }) => {
      const order = new OrderPage(page);

      await order.open({ eggs: 2, "NFF-CHK-EGG-MD": 1 });
      await expect(page.locator("#order-added")).toHaveText(
        new RegExp("^Added to your cart: 2 × Eggs, Large\\. No longer " +
          "available: Eggs.*, Medium\\.$")
      );
      await expect(order.qty("eggs")).toHaveValue("2");
      await expect(page).toHaveURL(/\/order\/$/);
    });

  test("the draft survives a reload", async ({ page }) => {
    const order = new OrderPage(page);

    await order.open({ wings: 5 });
    await order.method("scituate");
    await page.locator("#customer-first-name").fill("Draft");
    await page.reload();
    await expect(page.locator("#onfarm-date")).toBeEnabled();
    await expect(order.qty("wings")).toHaveValue("5");
    await expect(page.locator("#method-scituate")).toBeChecked();
    await expect(page.locator("#customer-first-name")).toHaveValue("Draft");
    await expect(order.total).toHaveText("$45");
  });

  test("Continue to payment takes the customer to Pickup or delivery",
    async ({ page }) => {
      const order = new OrderPage(page);

      await order.open({ wings: 5 });
      await expect(order.next).toBeEnabled();
      await order.next.click();
      await expect(page.locator("#pickup legend")).toBeFocused();
      await expect(page.locator("#pickup legend")).toBeInViewport();
    });

  test("the site's own scripts log no errors", async ({ page, baseURL }) => {
    const errors = [];
    const ours = new URL(baseURL).host;

    page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
    page.on("console", (m) => {
      const url = m.location().url || "";

      // Vendor SDKs (Square, Cash App, PayPal, Google Pay) log their
      // own CSP and telemetry noise; only our origin's errors count.
      if (m.type() === "error" && url.includes(ours)
        && !url.includes("/api/staging/")) {
        errors.push(`${m.text()} (${url})`);
      }
    });

    const order = new OrderPage(page);

    await order.open({ eggs: 2 });
    await page.locator("#payment").scrollIntoViewIfNeeded();
    await expect(page.locator("[data-pay]")).toHaveAttribute(
      "data-pay-state", /ready|venmo-only/, { timeout: 30_000 }
    );
    expect(errors).toEqual([]);
  });

  test("every in-stock product has a row and an Add button",
    async ({ page }) => {
      const order = new OrderPage(page);

      await order.open();

      const stock = await (await page.request.get("/api/stock")).json();
      const inStock = Object.entries(stock.items)
        .filter(([, s]) => s.inStock && s.available !== 0)
        .map(([sku]) => sku);
      const rows = await page.locator(".order-item:not([hidden])")
        .evaluateAll((items) => items.map((li) => li.dataset.sku));

      expect(rows.sort()).toEqual(inStock.sort());
      expect(rows).toContain(SKU.eggs);
    });

  // Square is the database; by default the page shows only what is in
  // stock. An item out of stock shows no row, not a sold-out one
  // (#267); Show "Full catalog" shows it (restock.spec.mjs).
  test("an out-of-stock item has no row", async ({ page }) => {
    const order = new OrderPage(page);

    await order.open();

    const out = catalog.groups.flatMap((g) => g.items)
      .filter((item) => !item.inStock)
      .map((item) => item.sku);

    expect(out).toEqual(expect.arrayContaining(
      ["NFF-CHK-EGG-MD", "NFF-CHK-EGG-SM"]
    ));
    for (const sku of out) {
      await expect(page.locator(`.order-item[data-sku="${sku}"]`))
        .toBeHidden();
    }
    await expect(page.locator(
      "#cat-eggs .order-item:visible .order-item-name"
    )).toHaveText([/Large/]);
  });

  // A stock count of 0 is out of stock too: the row goes, never a
  // sold-out one, and a category it leaves empty goes with its link.
  test("a product whose count reaches 0 loses its row, and its " +
    "category when empty", async ({ page }) => {
    const gone = [SKU.eggs, "NFF-CHK-DRM-15-99"];

    await page.route("**/api/stock", async (route) => {
      const res = await route.fetch();
      const body = await res.json();

      for (const sku of gone) {
        body.items[sku] = { inStock: false, available: 0 };
      }
      await route.fulfill({ response: res, json: body });
    });

    const order = new OrderPage(page);

    await order.open({ eggs: 1 });

    const row = (sku) => page.locator(`.order-item[data-sku="${sku}"]`);

    for (const sku of gone) await expect(row(sku)).toBeHidden();
    await expect(page.getByText("Sold out", { exact: true }))
      .toHaveCount(0);
    await expect(page.locator("#cat-eggs")).toBeHidden();
    await expect(page.locator("#order-nav a[href='#cat-eggs']"))
      .toBeHidden();
    await expect(row(SKU.drums)).toBeVisible();
    await expect(page.locator("#order-stock"))
      .toContainText("Large sold out and was removed");
    await expect(order.count).toHaveText("0 items");
  });
});
