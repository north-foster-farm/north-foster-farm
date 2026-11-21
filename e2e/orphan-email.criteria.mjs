// Criteria test for #754's second box: at 390 px a long email address
// in the email-change confirmation (layouts/partials/email-confirm.html,
// on /login/ and /account/) and in the contact page's sent message
// (layouts/contact/single.html) stays inside its container. Both values
// are empty at build time and filled by a script, so the deployed
// build's orphan pass (bin/orphans/wrap.mjs) could trap them in a
// text-nowrap pair. bin/e2e/serve.mjs runs that pass, as Netlify does.
//
// Held out of every run by its name: the config takes *.spec.mjs only,
// so renaming it to orphan-email.spec.mjs turns it on. It runs in the
// phone project, which is 390 px wide.
//
// The address breaks after its hyphens, where the browser may break
// any line, so it fits once nothing holds it on one line.

import { expect, test, uniqueEmail } from "./support/order.mjs";
import {
  BACK_OFFICE_MISSING, backOffice, clearMail, clearSession, deleteCustomer,
  linkIn, teardown, waitForMail,
} from "./support/staging.mjs";
import { followLink } from "./support/request-error.mjs";

const SIGN_IN = "Your secure sign-in link to North Foster Farm";
const VERIFY = /\/api\/auth\/verify\?token=/;
const LONG = "qa-e2e-orphan-pass-long-mailbox-name"
  + "@north-foster-farm-example-domain.com";

// Half a pixel for subpixel rounding, no more.
const SLACK = 0.5;

// The value's line boxes beside its container's box.
const measure = (page, container, value) => page.evaluate(([c, v]) => {
  const box = (r) => ({ left: r.left, right: r.right });
  const outer = document.querySelector(c);
  const inner = outer.querySelector(v);

  return {
    container: box(outer.getBoundingClientRect()),
    lines: [...inner.getClientRects()]
      .filter((r) => r.width > 0 && r.height > 0).map(box),
  };
}, [container, value]);

const inside = (inner, outer) =>
  inner.left >= outer.left - SLACK && inner.right <= outer.right + SLACK;

const expectInside = async (page, container, value) => {
  await expect(page.locator(`${container} ${value}`)).toHaveText(LONG);

  const { container: box, lines } = await measure(page, container, value);

  expect(box.right - box.left, `${container}: its width`)
    .toBeLessThanOrEqual(390 + SLACK);
  expect(lines.length, `${container}: the address's lines`)
    .toBeGreaterThan(0);
  for (const line of lines) {
    expect.soft(inside(line, box),
      `${container}: the address's line ${JSON.stringify(line)} sits ` +
        `inside ${JSON.stringify(box)}`).toBe(true);
  }
};

test.describe("#754 a script-filled email address at 390 px", () => {
  test.skip(!backOffice().ready, BACK_OFFICE_MISSING);

  const from = uniqueEmail("orphan-email");
  let since;

  test.beforeAll(() => {
    since = new Date();
  });

  test.afterAll(() => teardown([
    () => deleteCustomer(from),
    () => clearMail({ to: from, since }),
  ]));

  test("At 390 px, a long email address in the email-change " +
    "confirmation and in the contact page's sent message stays inside " +
    "its container",
  async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "phone", "the 390 px check");
    await page.setViewportSize({ width: 390, height: 664 });

    // A change link that lands on the sign-in page (#345): the card
    // shows the new address from the fragment, and nothing is posted
    // until Confirm.
    const hash = `#confirm=orphan-pass&email=${encodeURIComponent(LONG)}`;

    await test.step("the confirmation on /login/", async () => {
      await clearSession(page.context());
      await page.goto(`/login/${hash}`);
      await expect(page.locator("#login-confirm")).toBeVisible();
      await expectInside(page, "#login-confirm", "[data-confirm-email]");
    });

    // The same link on the account page, signed in by emailed link.
    await test.step("the confirmation on /account/", async () => {
      const asked = new Date();

      await page.goto("/login/");
      await page.locator("#login-email").fill(from);
      await page.locator("#login-submit").click();
      await expect(page.locator("#login-sent")).toBeVisible();

      const mail = await waitForMail({ to: from, subject: SIGN_IN,
        since: asked });

      await followLink(page, linkIn(mail, VERIFY));
      await expect(page).toHaveURL(/\/account\/?/);
      await page.goto("about:blank");
      await page.goto(`/account/${hash}`);
      await expect(page.locator("#account-confirm")).toBeVisible();
      await expectInside(page, "#account-confirm", "[data-confirm-email]");
    });

    // The sent message, filled as assets/scripts/contact/main.js fills
    // it once /api/contact answers, so no message is sent.
    await test.step("the sent message on /contact/", async () => {
      await page.goto("/contact/");
      await expect(page.locator("#contact-form")).toBeVisible();
      await page.evaluate((email) => {
        const sent = document.getElementById("contact-sent");

        sent.querySelector("[data-contact-email]").textContent = email;
        document.getElementById("contact-form").hidden = true;
        sent.hidden = false;
      }, LONG);
      await expect(page.locator("#contact-sent")).toBeVisible();
      await expectInside(page, "#contact-sent", "[data-contact-email]");
    });
  });
});
