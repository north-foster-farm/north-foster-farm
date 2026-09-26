// Contact information and Pickup or delivery: validation before any
// processor is asked, and revalidation after a failed attempt.
// docs/qa-launch.md, "Contact and pickup forms". Nothing here pays.

import {
  OrderPage, expect, test, uniqueEmail,
} from "./support/order.mjs";

// Presses Pay with the card form open and nothing typed into it. The
// form validates first, so no request reaches /api/orders.
const attempt = async (order) => {
  await order.openCard();
  await order.submit.click();
};

test.describe("contact and pickup forms", () => {
  let posted;

  test.beforeEach(async ({ page }) => {
    posted = 0;
    page.on("request", (r) => {
      if (r.url().includes("/api/orders") && r.method() === "POST") {
        posted += 1;
      }
    });
  });

  test("Delivery is the default and needs a phone; pickup does not",
    async ({ page }) => {
      const order = new OrderPage(page);
      const optional = page.locator("[data-phone-optional]");

      await order.open({ wings: 5 });
      await expect(page.locator("#method-delivery")).toBeChecked();
      await expect(optional).toBeHidden();
      await expect(page.locator("#customer-phone")).toHaveAttribute(
        "required", ""
      );
      await order.method("onfarm");
      await expect(optional).toBeVisible();
      await expect(optional).toHaveText("(optional)");
      await order.method("scituate");
      await expect(optional).toBeVisible();
    });

  test("an empty delivery order names every missing field and sends " +
    "nothing", { tag: "@regression" }, async ({ page }) => {
    const order = new OrderPage(page);

    await order.open({ wings: 5 });
    await attempt(order);
    await expect(order.errorFor("customer.firstName"))
      .toHaveText("Please enter your first name.");
    await expect(order.errorFor("customer.lastName"))
      .toHaveText("Please enter your last name.");
    await expect(order.errorFor("customer.email"))
      .toHaveText("That email address doesn't look right.");
    await expect(order.errorFor("customer.phone"))
      .toHaveText("Please enter a phone number.");
    await expect(order.errorFor("delivery.address1"))
      .toHaveText("Please enter your street address.");
    await expect(order.errorFor("delivery.town"))
      .toHaveText("Please enter your town.");
    await expect(order.errorFor("delivery.zip"))
      .toHaveText("Please enter a five-digit ZIP code.");
    await expect(order.errorFor("delivery.cooler"))
      .toHaveText("Tell us where the cooler will be.");
    await expect(page.locator("#customer-first-name")).toHaveClass(
      /is-invalid/
    );
    await expect(page.locator("#customer-first-name")).toBeFocused();
    // A screen reader hears it too: every field marked red is
    // aria-invalid (f27ed0e).
    const marked = await page.locator("#order-form .is-invalid").evaluateAll(
      (els) => els.map((el) => `${el.id}:${el.getAttribute("aria-invalid")}`)
    );

    expect(marked.length).toBeGreaterThanOrEqual(8);
    expect(marked.filter((m) => !m.endsWith(":true"))).toEqual([]);
    expect(posted).toBe(0);
  });

  test("on-farm pickup needs no phone, but a phone given must work",
    async ({ page }) => {
      const order = new OrderPage(page);

      await order.open({ eggs: 1 });
      await order.method("onfarm");
      await order.contact({ email: uniqueEmail("nophone") });
      await order.firstDate("onfarm");
      await attempt(order);
      // Everything is valid, so the card form is what stops it.
      await expect(order.errorFor("customer.phone")).toHaveCount(0);
      await expect(order.payError).toBeVisible();
      expect(posted).toBe(0);

      await page.locator("#customer-phone").fill("401555");
      await attempt(order);
      await expect(order.errorFor("customer.phone"))
        .toHaveText("That phone number doesn't look right.");
      expect(posted).toBe(0);
    });

  test("errors clear as each field is fixed, without refocusing",
    { tag: "@regression" }, async ({ page }) => {
      const order = new OrderPage(page);

      await order.open({ eggs: 1 });
      await order.method("onfarm");
      await order.firstDate("onfarm");
      await attempt(order);
      await expect(order.errorFor("customer.firstName")).toBeVisible();

      // Typing fixes a field: its error goes on input, not on refocus.
      await page.locator("#customer-first-name").fill("Ada");
      await expect(order.errorFor("customer.firstName")).toHaveCount(0);
      await expect(page.locator("#customer-first-name")).not.toHaveClass(
        /is-invalid/
      );
      await expect(page.locator("#customer-first-name")).not.toHaveAttribute(
        "aria-invalid", /./
      );

      // A value set the way autofill sets it, with no focus at all.
      await page.locator("#customer-last-name").evaluate((el) => {
        el.value = "Lovelace";
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      });
      await expect(order.errorFor("customer.lastName")).toHaveCount(0);

      // A still-wrong email keeps its error; leaving the field says so.
      // A field left with a value turns to plain text ("Click on a
      // field to edit it"), so a click makes it a field again.
      const email = page.locator("#customer-email");

      await email.fill("ada@");
      await email.blur();
      await expect(order.errorFor("customer.email"))
        .toHaveText("That email address doesn't look right.");
      await email.click();
      await email.fill("ada@example.com");
      await email.blur();
      await expect(order.errorFor("customer.email")).toHaveCount(0);
    });

  test("after a failed attempt, a field emptied and left shows its error",
    async ({ page }) => {
      const order = new OrderPage(page);

      await order.open({ eggs: 1 });
      await order.method("onfarm");
      await order.firstDate("onfarm");
      await order.contact({ last: "", email: uniqueEmail("blur") });
      await attempt(order);
      await expect(order.errorFor("customer.lastName")).toBeVisible();
      await expect(order.errorFor("customer.firstName")).toHaveCount(0);

      const first = page.locator("#customer-first-name");

      await first.click();
      await first.fill("");
      await first.blur();
      await expect(order.errorFor("customer.firstName"))
        .toHaveText("Please enter your first name.");
    });

  test("the phone formats itself and then offers text or call",
    async ({ page }) => {
      const order = new OrderPage(page);
      const row = page.locator("[data-contact-row]");

      await order.open({ eggs: 1 });
      await expect(row).toHaveAttribute("data-shown", "false");
      await page.locator("#customer-phone").pressSequentially("4015550100");
      await expect(page.locator("#customer-phone"))
        .toHaveValue("(401) 555-0100");
      await expect(row).toHaveAttribute("data-shown", "true");
      await expect(page.locator("#contact-text")).toBeChecked();
    });

  test("delivery under the minimum warns in red at the choice and " +
    "blocks the order", async ({ page }) => {
    const order = new OrderPage(page);

    await order.open({ eggs: 5 });
    await expect(order.short).toBeVisible();
    await expect(order.short).toHaveText(
      "You need $40 or more in your cart to use this option. Add $5 more."
    );

    const color = await order.short.evaluate(
      (el) => getComputedStyle(el).color
    );
    const [r, g, b] = color.match(/\d+/g).map(Number);

    expect(r, `warning colour ${color} should read as red`)
      .toBeGreaterThan(Math.max(g, b) + 60);
    await expect(order.next).toBeDisabled();

    await order.contact({ email: uniqueEmail("short"), phone: "4015550100" });
    await order.delivery();
    await attempt(order);
    await expect(order.short).toContainText("You need $40 or more");
    expect(posted).toBe(0);
  });

  test("the delivery-policy note can be dismissed, and stays dismissed",
    async ({ page }) => {
      const order = new OrderPage(page);
      const note = page.locator("[data-agree]");

      await order.open({ wings: 5 });
      await expect(note).toContainText(
        "By placing a delivery order you agree to our delivery policy."
      );
      await note.getByRole("button", { name: "Dismiss" }).click();
      await expect(note).toBeHidden();
      await page.reload();
      await expect(page.locator("#onfarm-date")).toBeEnabled();
      await expect(note).toBeHidden();
    });

  test("the delivery countdown names the next delivery day",
    async ({ page }) => {
      const order = new OrderPage(page);

      await order.open({ wings: 5 });
      await expect(page.locator("[data-countdown-text]")).toHaveText(
        /^Order in the next .+ to get your order on our next delivery day/
      );
    });

  test("ticking the farm-news box sends no email", async ({ page }) => {
    const order = new OrderPage(page);
    let asked = 0;

    page.on("request", (r) => {
      if (r.url().includes("/api/news/")) asked += 1;
    });
    await order.open({ eggs: 1 });
    await page.locator("#customer-email").fill(uniqueEmail("optin"));
    await page.locator("label[for='customer-marketing']").click();
    await page.locator("#customer-phone").focus();
    await expect(page.locator("#customer-marketing")).toBeChecked();
    await expect(page.locator("#details [data-news-note]")).toHaveCount(0);
    expect(asked, "the box joins with the order, not before").toBe(0);
    expect(posted).toBe(0);
  });
});
