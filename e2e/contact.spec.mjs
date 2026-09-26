// The contact page as #140 lands it: the ways to reach the farm and a
// form that checks itself, then posts to /api/contact. Until the
// function lands the endpoint is stubbed here; the real message, its
// emails and the reminders are AR-15 to AR-17.
// docs/qa-launch.md, "The autumn refresh".

import { expectBusy, expectIdle, holdRequests } from "./support/busy.mjs";
import { expect, test } from "./support/order.mjs";

const HEADING = "Don't be a chicken. Talk to us.";
const LEAD = "Call, text, email, message us on Instagram, or use our " +
  "contact form.";
const LIMITED = "There have been too many messages from here. Wait a " +
  "few minutes and send it again; what you wrote is still here.";

const fields = (page) => ({
  name: page.locator("#contact-name"),
  email: page.locator("#contact-email"),
  orders: page.locator("#contact-form [data-contact-orders]"),
  order: page.locator("#contact-order"),
  filter: page.locator("#contact-order-filter"),
  filterStatus: page.locator("#contact-form [data-contact-filter-status]"),
  message: page.locator("#contact-message"),
  submit: page.locator("#contact-submit"),
  alert: page.locator("#contact-form [data-contact-error]"),
  sent: page.locator("#contact-sent"),
});

const errorFor = (page, key) => page.locator(
  `#contact-form [data-error-for='${key}']`
);

const fill = async (f, {
  name = "QA Contact", email = "qa-e2e-contact@example.com",
  message = "Do you have wings this week?",
} = {}) => {
  await f.name.fill(name);
  await f.email.fill(email);
  await f.message.fill(message);
};

// Who the page thinks is signed in, and their orders (#176), answered
// in the browser: `orders` null means signed out.
const signIn = async (page, orders) => {
  const customer = { email: "qa-e2e-contact@example.com", name: "Ada Hen" };

  await page.route("**/api/me", (route) => route.fulfill({
    json: orders ? { signedIn: true, customer } : { signedIn: false },
  }));
  await page.route("**/api/account/orders", (route) => route.fulfill(
    orders
      ? { json: { orders } }
      : { status: 401, json: { error: "Please sign in." } }
  ));
};

// Orders as /api/account/orders gives them, oldest first here.
const ordersOf = (n) => Array.from({ length: n }, (_, i) => ({
  id: `NFF-26${String(10 + i).padStart(2, "0")}-QA${i}X`,
  submittedAt: new Date(Date.UTC(2026, 8, 1 + i, 15)).toISOString(),
  totals: { total: (20 + i) * 100 },
}));

// Counts what reaches /api/contact without answering for it.
const countPosts = (page) => {
  const sent = [];

  page.on("request", (req) => {
    if (req.url().includes("/api/contact")) sent.push(req);
  });

  return sent;
};

test.describe("contact (#140)", () => {
  test("the heading, the lead and the ways to reach the farm",
    async ({ page }) => {
      await page.goto("/contact/");
      await expect(page.locator("h1")).toHaveText(HEADING);
      await expect(page.locator(".contact .lead")).toHaveText(LEAD);
      await expect(page.locator(".contact-ways dt")).toHaveText([
        "Call or text", "Email", "Instagram", "The farm",
      ]);

      const ways = page.locator(".contact-ways dd a");

      await expect(ways.nth(0)).toHaveAttribute("href", "tel:+14015783713");
      await expect(ways.nth(1))
        .toHaveAttribute("href", "mailto:sales@northfosterfarm.com");
      await expect(ways.nth(2))
        .toHaveAttribute("href", /instagram\.com\/northfosterfarm$/);
      await expect(page.locator(".contact-ways"))
        .toContainText("by appointment");

      await page.locator(".contact .lead a").click();
      await expect(page).toHaveURL(/#contact-form$/);
      await expect(page.locator("#contact-form")).toBeInViewport();

      // The honeypot is there for bots only.
      const bot = page.locator("#contact-website");

      await expect(bot).toHaveAttribute("tabindex", "-1");
      await expect(bot.locator("xpath=..")).toHaveClass(/visually-hidden/);
      await expect(bot.locator("xpath=..")).toHaveAttribute(
        "aria-hidden", "true"
      );
    });

  test("on a phone the ways come first, the form under them",
    async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 664 });
      await page.goto("/contact/");

      const ways = await page.locator(".contact-ways").boundingBox();
      const form = await page.locator("#contact-form").boundingBox();

      expect(form.y).toBeGreaterThan(ways.y + ways.height - 1);
      expect(form.x + form.width).toBeLessThanOrEqual(390);
    });

  test("an empty message names every missing field and sends nothing",
    async ({ page }) => {
      const sent = countPosts(page);

      await page.goto("/contact/");

      const f = fields(page);

      await f.submit.click();
      await expect(errorFor(page, "name")).toHaveText("Tell us your name.");
      await expect(errorFor(page, "email"))
        .toHaveText("Enter your email address, so we can answer.");
      await expect(errorFor(page, "message"))
        .toHaveText("Write us a message first.");
      await expect(errorFor(page, "orderId")).toHaveText("");
      await expect(f.name).toBeFocused();
      for (const field of [f.name, f.email, f.message]) {
        await expect(field).toHaveAttribute("aria-invalid", "true");
      }
      expect(sent).toHaveLength(0);
    });

  test("errors clear as each field is put right", async ({ page }) => {
    const sent = countPosts(page);

    await page.goto("/contact/");

    const f = fields(page);

    await fill(f, { email: "you@farm" });
    await f.submit.click();
    await expect(errorFor(page, "email"))
      .toHaveText("Enter a valid email address, like you@example.com.");
    await expect(f.email).toBeFocused();
    await expect(errorFor(page, "name")).toHaveText("");

    await f.email.pressSequentially(".com");
    await expect(errorFor(page, "email")).toHaveText("");
    await expect(f.email).not.toHaveClass(/\bis-invalid\b/);
    expect(sent).toHaveLength(0);
  });

  test("while it sends the button shows the egg, then the thanks card",
    async ({ page }) => {
      const hold = await holdRequests(page, "**/api/contact");

      await page.goto("/contact/");

      const f = fields(page);
      const width = (await f.submit.boundingBox()).width;

      await fill(f, { email: " qa-e2e-contact@example.com " });

      const posted = page.waitForRequest("**/api/contact");

      await f.submit.click();

      const body = (await posted).postDataJSON();

      expect(body).toMatchObject({
        name: "QA Contact", orderId: "",
        message: "Do you have wings this week?", website: "",
      });
      await expectBusy(page, f.submit, { busyWord: "Sending", width });

      // A second press while it sends sends nothing more. The button is
      // only aria-disabled, so a person can still press it.
      await f.submit.click({ force: true });
      hold.release();

      await expect(f.sent).toBeVisible();
      await expect(f.sent.locator("h2")).toHaveText("Thanks, we have it");
      await expect(f.sent).toContainText(
        "We'll answer by email to qa-e2e-contact@example.com."
      );
      await expect(page.locator("#contact-form")).toBeHidden();
      expect(hold.calls()).toBe(1);
    });

  test("the function's field errors land under their fields",
    async ({ page }) => {
      // An address the page lets through and the function refuses.
      const refused = "Enter a valid email address, like you@example.com.";

      await holdRequests(page, "**/api/contact", {
        status: 422,
        body: { errors: { email: refused } },
      }).then((hold) => hold.release());
      await page.goto("/contact/");

      const f = fields(page);
      const width = (await f.submit.boundingBox()).width;

      await fill(f);
      await f.submit.click();
      await expect(errorFor(page, "email")).toHaveText(refused);
      await expect(f.email).toHaveAttribute("aria-invalid", "true");
      await expect(f.email).toBeFocused();
      await expect(f.alert).toBeHidden();
      await expectIdle(f.submit, { width });
    });

  test("a failure says so and keeps the message", async ({ page }) => {
    await holdRequests(page, "**/api/contact", { status: 500 })
      .then((hold) => hold.release());
    await page.goto("/contact/");

    const f = fields(page);

    await fill(f);
    await f.submit.click();
    await expect(f.alert).toBeVisible();
    await expect(f.alert).toHaveText("We couldn't send that just now. " +
      "Please try again, or email us directly.");
    await expect(f.message).toHaveValue("Do you have wings this week?");
    await expect(f.sent).toBeHidden();
  });

  // #178: past the limit the writer is told, not thanked.
  test("too many messages says so by Send and keeps the message",
    async ({ page }) => {
      await holdRequests(page, "**/api/contact", {
        status: 429, body: { message: LIMITED },
      }).then((hold) => hold.release());
      await page.goto("/contact/");

      const f = fields(page);
      const note = page.locator("#contact-form [data-contact-limit]");

      await fill(f);
      await f.submit.click();
      await expect(note).toBeVisible();
      await expect(note).toHaveText(LIMITED);
      await expect(note).toHaveAttribute("role", "alert");
      await expect(f.sent).toBeHidden();
      await expect(f.alert).toBeHidden();
      await expect(f.message).toHaveValue("Do you have wings this week?");
      await expect(f.submit).toBeEnabled();
    });
});

// #176: the order row is a choice of the customer's own orders, shown
// only to a signed-in customer who has some.
test.describe("contact: the order row (#176)", () => {
  test("signed out, there is no order row and no order is sent",
    async ({ page }) => {
      await signIn(page, null);
      await holdRequests(page, "**/api/contact")
        .then((hold) => hold.release());
      await page.goto("/contact/");

      const f = fields(page);

      await fill(f);
      await expect(f.orders).toBeHidden();

      const posted = page.waitForRequest("**/api/contact");

      await f.submit.click();
      expect((await posted).postDataJSON().orderId).toBe("");
    });

  test("signed in with no orders, the details fill and the row stays " +
    "hidden", async ({ page }) => {
    await signIn(page, []);
    await page.goto("/contact/");

    const f = fields(page);

    await expect(f.name).toHaveValue("Ada Hen");
    await expect(f.email).toHaveValue("qa-e2e-contact@example.com");
    await expect(f.orders).toBeHidden();
  });

  test("signed in with orders, a labelled list, newest first, sends the " +
    "one picked", async ({ page }) => {
    await signIn(page, ordersOf(2));
    await holdRequests(page, "**/api/contact")
      .then((hold) => hold.release());
    await page.goto("/contact/");

    const f = fields(page);

    await expect(f.orders).toBeVisible();
    await expect(page.getByLabel("Order (optional)")).toHaveJSProperty(
      "tagName", "SELECT"
    );
    await expect(f.order.locator("option")).toHaveText([
      "No particular order",
      "NFF-2611-QA1X, Sep 2, 2026, $21",
      "NFF-2610-QA0X, Sep 1, 2026, $20",
    ]);
    await expect(f.order).toHaveValue("");
    await expect(f.filter).toBeHidden();

    await f.message.fill("Can I add a dozen eggs?");
    await f.order.selectOption("NFF-2610-QA0X");

    const posted = page.waitForRequest("**/api/contact");

    await f.submit.click();
    expect((await posted).postDataJSON()).toMatchObject({
      name: "Ada Hen", email: "qa-e2e-contact@example.com",
      orderId: "NFF-2610-QA0X",
    });
  });

  test("six orders or more bring a filter that narrows the list",
    async ({ page }) => {
      const sent = countPosts(page);

      await signIn(page, ordersOf(7));
      await page.goto("/contact/");

      const f = fields(page);

      await expect(f.filter).toBeVisible();
      await expect(f.filter).toHaveAttribute("aria-label", "Find an order");
      await expect(f.order.locator("option")).toHaveCount(8);

      // The chosen order stays listed whatever the filter says.
      await f.order.selectOption("NFF-2612-QA2X");
      await f.filter.fill("QA5");
      await expect(f.order.locator("option")).toHaveText([
        "No particular order",
        "NFF-2615-QA5X, Sep 6, 2026, $25",
        "NFF-2612-QA2X, Sep 3, 2026, $22",
      ]);
      await expect(f.order).toHaveValue("NFF-2612-QA2X");
      await expect(f.filterStatus).toHaveText("1 order matches");

      await f.filter.fill("Sep");
      await expect(f.filterStatus).toHaveText("7 orders match");

      // Enter narrows; it never sends the form.
      await f.filter.press("Enter");
      await page.waitForTimeout(500);
      expect(sent).toHaveLength(0);
    });
});
