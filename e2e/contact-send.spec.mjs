// AR-15 and AR-16 (#140, #176): the contact page's message for real,
// through /api/contact on staging, to the farm's email in the outbox
// and a messages/<id> record. contact.spec.mjs covers the page with
// the endpoint stubbed. The daily reminder and `bin/nff messages` wait
// on #167 (AR-17). docs/qa-launch.md, "The autumn refresh".

import { NONCE, eggOrder, postOrder } from "./support/api.mjs";
import { expect, test, uniqueEmail } from "./support/order.mjs";
import {
  BACK_OFFICE_MISSING, backOffice, clearMail, closeOrder, contactMessages,
  deleteContactMessages, deleteCustomer, linkIn, mailTo, outbox, teardown,
  waitForMail,
} from "./support/staging.mjs";

test.describe.configure({ mode: "serial" });

test.describe("contact messages (#140)", () => {
  test.skip(!backOffice().cli, BACK_OFFICE_MISSING);

  const email = uniqueEmail("contact");
  const tag = email.split("-").pop().split("@")[0];
  const name = `QA Contact ${tag}`;
  const orders = [];
  let since;

  test.beforeAll(() => {
    since = new Date();
  });

  test.afterAll(() => teardown([
    ...orders.map((id) => () => closeOrder(id)),
    () => deleteContactMessages(email),
    () => deleteCustomer(email),
    () => clearMail({ subject: `Message from ${name}`, since }),
    () => clearMail({ to: email, since }),
  ]));

  test("signed out, a message reaches the farm, answered by a plain reply",
    async ({ page }) => {
      await page.goto("/contact/");
      await page.locator("#contact-name").fill(name);
      await page.locator("#contact-email").fill(email);
      await page.locator("#contact-message").fill("Wings this week?");
      await expect(page.locator("[data-contact-orders]")).toBeHidden();
      await page.locator("#contact-submit").click();

      await expect(page.locator("#contact-sent h2"))
        .toHaveText("Thanks, we have it");

      const mail = await waitForMail({
        subject: new RegExp(`^Message from ${name}$`), since,
      });

      expect(mail.replyTo).toBe(email);
      expect(mail.text).toContain("Wings this week?");
      expect(mail.text).toContain("Reply to this email to answer them.");

      const kept = await contactMessages(email);

      expect(kept).toHaveLength(1);
      expect(kept[0]).toMatchObject({
        name, email, orderId: "", order: null,
        message: "Wings this week?", status: "open",
      });
      expect(kept[0].mailed).toBeUndefined();
      // Nothing goes to the writer (an acknowledgement is #167's).
      expect(await mailTo(email, since)).toEqual([]);
    });

  test("someone else's order number is named to the farm only",
    async ({ request }) => {
      const res = await request.post("/api/contact", { data: {
        name, email, orderId: "NFF-0000-QAQA", message: "Whose is this?",
      } });

      expect(res.status()).toBe(200);
      expect(await res.json()).toEqual({ ok: true });

      const mail = await waitForMail({
        subject: `Message from ${name} about NFF-0000-QAQA`, since,
      });

      expect(mail.text).toContain(
        "NFF-0000-QAQA: no order by that number with this email"
      );
      expect((await contactMessages(email))
        .find((m) => m.orderId === "NFF-0000-QAQA")).toMatchObject({
        order: false,
      });
    });

  // #176: a signed-in customer picks one of their own orders.
  test("signed in, the customer picks their order, and the farm sees it",
    async ({ page, request }) => {
      const { status, body } = await postOrder(request, await eggOrder(
        request, { email, nonce: NONCE.ok }
      ));

      expect(status, JSON.stringify(body)).toBe(200);
      orders.push(body.orderId);

      const asked = new Date();

      await page.goto("/login/");
      await page.locator("#login-email").fill(email);
      await page.locator("#login-submit").click();

      const link = linkIn(await waitForMail({
        to: email, subject: "Your secure sign-in link", since: asked,
      }), /\/api\/auth\/verify\?token=/);

      // As from the email: a new tab, whose session storage has not
      // cached the signed-out answer /login/ got.
      const tab = await page.context().newPage();

      await tab.goto(link);
      await expect(tab).toHaveURL(/\/account\/?/);

      await tab.goto("/contact/");

      const order = tab.locator("#contact-order");

      await expect(tab.locator("[data-contact-orders]")).toBeVisible();
      await expect(tab.locator("#contact-email")).toHaveValue(email);
      await expect(order.locator("option")).toHaveText([
        "No particular order", new RegExp(`^${body.orderId}, .+, \\$7$`),
      ]);
      await tab.locator("#contact-name").fill(name);
      await tab.locator("#contact-message").fill("Can I add wings?");
      await order.selectOption(body.orderId);
      await tab.locator("#contact-submit").click();
      await expect(tab.locator("#contact-sent h2"))
        .toHaveText("Thanks, we have it");

      const mail = await waitForMail({
        subject: `Message from ${name} about ${body.orderId}`, since,
      });

      expect(mail.text).toContain(
        `Order ${body.orderId}, placed with this email`
      );
      expect((await contactMessages(email))
        .find((m) => m.orderId === body.orderId)).toMatchObject({
        order: true, message: "Can I add wings?",
      });
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
