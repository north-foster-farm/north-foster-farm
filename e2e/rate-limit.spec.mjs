// PY-18 against the live endpoint: past its rate limit, /api/orders
// says so and the page keeps the order (#154). Reaching the limit
// locks this address out of /api/orders for ten minutes, so the spec
// runs only when asked, alone, as the last thing in a pass:
//
//   E2E_LOCKOUT=1 node_modules/.bin/playwright test \
//     -c playwright.config.mjs e2e/rate-limit.spec.mjs
//
// docs/qa-launch.md, "Payments".

import { eggOrder, postOrder } from "./support/api.mjs";
import {
  OrderPage, expect, test, uniqueEmail,
} from "./support/order.mjs";
import {
  BACK_OFFICE_MISSING, backOffice, closeOrder, deleteCustomer, nff,
  teardown,
} from "./support/staging.mjs";

const MESSAGE = "There have been too many tries from here. Wait a few " +
  "minutes and try again; your order is saved on this page.";

// The limit is 12 per address, but each function instance keeps its
// own count, so more may be needed when Netlify runs several.
const MAX_TRIES = 40;

test.describe.configure({ mode: "serial" });

test.describe("rate limit", () => {
  test.skip(!process.env.E2E_LOCKOUT,
    "Locks this address out for ten minutes; set E2E_LOCKOUT=1.");
  test.skip(!backOffice().cli, BACK_OFFICE_MISSING);

  const made = [];
  const emails = [];

  test.afterAll(() => teardown([
    ...made.map((id) => () => closeOrder(id)),
    ...emails.map((email) => () => deleteCustomer(email)),
  ]));

  test("past the limit the endpoint answers 429 with Retry-After",
    async ({ request }) => {
      // An order with no submission key is counted, then refused with
      // 422 before Square is asked for anything.
      const cheap = { ...await eggOrder(request, {
        email: uniqueEmail("limit"),
      }), idempotencyKey: "" };
      let tries = 0;
      let last;

      do {
        tries += 1;
        last = await request.post("/api/orders", { data: cheap });
      } while (last.status() !== 429 && tries < MAX_TRIES);

      test.info().annotations.push({
        type: "tries", description: `429 after ${tries} requests`,
      });
      expect(last.status(), `after ${tries} requests`).toBe(429);
      expect(last.headers()["retry-after"]).toBe("600");
      expect((await last.json()).message).toBe(MESSAGE);

      // The honeypot is still dropped silently, limit or not.
      const bot = await postOrder(request, await eggOrder(request, {
        email: uniqueEmail("limit-bot"), extra: { website: "http://spam" },
      }), { limited: true });

      expect(bot.status).toBe(204);
    });

  test("a card order past the limit is not placed, and the page says " +
    "why and keeps it", async ({ page }) => {
    const order = new OrderPage(page);
    const email = uniqueEmail("limit-page");

    emails.push(email);
    await order.open({ eggs: 1 });
    await order.method("onfarm");
    await order.contact({ first: "Limited", email });
    await order.firstDate("onfarm");
    await order.openCard();
    await order.card();

    const { status, body } = await order.pay({ limited: true });

    if (body && body.orderId) made.push(body.orderId);
    expect(status, JSON.stringify(body)).toBe(429);
    await expect(order.payError).toHaveText(MESSAGE);
    await expect(order.result).not.toContainText("Your order is placed");
    await expect(order.submit).toBeEnabled();
    await expect(order.qty("eggs")).toHaveValue("1");
    expect(await nff(["orders", "list", `--email=${email}`]))
      .toContain("No orders.");
  });
});
