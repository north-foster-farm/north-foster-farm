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

const fields = (page) => ({
  name: page.locator("#contact-name"),
  email: page.locator("#contact-email"),
  order: page.locator("#contact-order"),
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
      await f.order.fill("NFF-2610-K3WM");

      const posted = page.waitForRequest("**/api/contact");

      await f.submit.click();

      const body = (await posted).postDataJSON();

      expect(body).toMatchObject({
        name: "QA Contact", orderId: "NFF-2610-K3WM",
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
      await holdRequests(page, "**/api/contact", {
        status: 422,
        body: { errors: { orderId: "We can't find that order." } },
      }).then((hold) => hold.release());
      await page.goto("/contact/");

      const f = fields(page);
      const width = (await f.submit.boundingBox()).width;

      await fill(f);
      await f.order.fill("NFF-0000-XXXX");
      await f.submit.click();
      await expect(errorFor(page, "orderId"))
        .toHaveText("We can't find that order.");
      await expect(f.order).toHaveAttribute("aria-invalid", "true");
      await expect(f.order).toBeFocused();
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
});
