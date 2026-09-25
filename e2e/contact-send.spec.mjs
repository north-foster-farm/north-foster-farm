// AR-15 and AR-16 (#140): the contact page's message for real, through
// /api/contact on staging, to the farm's email in the outbox and a
// messages/<id> record. contact.spec.mjs covers the page with the
// endpoint stubbed. The daily reminder and `bin/nff messages` wait on
// #167 (AR-17). docs/qa-launch.md, "The autumn refresh".

import { expect, test, uniqueEmail } from "./support/order.mjs";
import {
  BACK_OFFICE_MISSING, backOffice, clearMail, contactMessages,
  deleteContactMessages, mailTo, outbox, teardown, waitForMail,
} from "./support/staging.mjs";

test.describe.configure({ mode: "serial" });

test.describe("contact messages (#140)", () => {
  test.skip(!backOffice().cli, BACK_OFFICE_MISSING);

  const email = uniqueEmail("contact");
  const name = `QA Contact ${email.split("-").pop().split("@")[0]}`;
  let since;

  test.beforeAll(() => {
    since = new Date();
  });

  test.afterAll(() => teardown([
    () => deleteContactMessages(email),
    () => clearMail({ subject: `Message from ${name}`, since }),
    () => clearMail({ to: email, since }),
  ]));

  test("a message reaches the farm, answered by a plain reply",
    async ({ page }) => {
      await page.goto("/contact/");
      await page.locator("#contact-name").fill(name);
      await page.locator("#contact-email").fill(email);
      // Not this writer's order: the farm is told, the writer is not.
      await page.locator("#contact-order").fill("NFF-0000-QAQA");
      await page.locator("#contact-message").fill("Wings this week?");
      await page.locator("#contact-submit").click();

      await expect(page.locator("#contact-sent h2"))
        .toHaveText("Thanks, we have it");
      await expect(page.locator("#contact-sent")).not.toContainText(
        /no order/i
      );

      const mail = await waitForMail({
        subject: `Message from ${name} about NFF-0000-QAQA`, since,
      });

      expect(mail.replyTo).toBe(email);
      expect(mail.text).toContain("Wings this week?");
      expect(mail.text).toContain(
        "NFF-0000-QAQA: no order by that number with this email"
      );
      expect(mail.text).toContain("Reply to this email to answer them.");

      const kept = await contactMessages(email);

      expect(kept).toHaveLength(1);
      expect(kept[0]).toMatchObject({
        name, email, orderId: "NFF-0000-QAQA", order: false,
        message: "Wings this week?", status: "open",
      });
      expect(kept[0].mailed).toBeUndefined();
      // Nothing goes to the writer (an acknowledgement is #167's).
      expect(await mailTo(email, since)).toEqual([]);
    });

  test("the honeypot and bad fields are refused at the API",
    async ({ request }) => {
      const before = (await contactMessages(email)).length;
      const trap = await request.post("/api/contact", { data: {
        name, email, message: "Buy followers", website: "https://spam",
      } });

      expect(trap.status()).toBe(200);
      expect(await trap.json()).toEqual({ ok: true });

      const bad = await request.post("/api/contact", { data: {
        name: " ", email: "you@farm", message: "",
      } });

      expect(bad.status()).toBe(422);
      expect((await bad.json()).errors).toEqual({
        name: "Tell us your name.",
        email: "Enter a valid email address, like you@example.com.",
        message: "Write us a message first.",
      });

      const foreign = await request.post("/api/contact", {
        headers: { Origin: "https://example.org" },
        data: { name, email, message: "From elsewhere" },
      });

      expect(foreign.status()).toBe(403);
      expect(await contactMessages(email)).toHaveLength(before);
      // Give a stray send time to land, then look for it.
      await new Promise((r) => setTimeout(r, 5_000));
      expect((await outbox({ since })).filter(
        (m) => /Buy followers|From elsewhere/.test(m.text)
      )).toEqual([]);
    });
});
