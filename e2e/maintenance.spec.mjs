// The maintenance rehearsal (#267, docs/maintenance.md): flips the
// staging deploy's switch, which closes ordering for everyone using
// staging, so it runs only when asked:
//
//   E2E_MAINTENANCE=1 npx playwright test e2e/maintenance.spec.mjs \
//     --project=desktop
//
// Needs .env.staging (bin/nff --staging) and STAGING_TOKEN. The phone
// links and the Square webhook run when MAINTENANCE_SECRET and
// SQUARE_WEBHOOK_SIGNATURE_KEY are in .env.staging and on the deploy.
// The switch is turned off again whatever happens. Venmo cannot be
// scripted (PayPal's own approval); docs/maintenance.md has the steps.

import { createHmac } from "node:crypto";

import { eggOrder, postOrder } from "./support/api.mjs";
import { expect, test, uniqueEmail } from "./support/order.mjs";
import {
  BACK_OFFICE_MISSING, BASE_URL, backOffice, clearMail, closeOrder, nff,
  stagingEnv, teardown, waitForMail,
} from "./support/staging.mjs";

const MESSAGE = "Our site is currently under maintenance. Online ordering " +
  "and account access are temporarily unavailable, but we'll be up and " +
  "running again soon. We apologize for the inconvenience.";

const flip = (state) => nff(["maintenance", state]);
const status = async () => /ON/.test(await nff(["maintenance", "status"]));

test.describe("maintenance mode", () => {
  test.describe.configure({ mode: "serial" });
  test.skip(!process.env.E2E_MAINTENANCE,
    "Flips staging's maintenance switch; set E2E_MAINTENANCE=1.");
  test.skip(!backOffice().cli, BACK_OFFICE_MISSING);

  test.afterAll(async () => {
    await flip("off");
  });

  // Signs a customer in the way an email link would, on `request`.
  const signIn = async (request, email) => {
    const link = (await nff(["login", email])).trim().split("\n").at(-1);

    await request.get(link);
    const me = await (await request.get("/api/me")).json();

    expect(me.signedIn, "signed in").toBe(true);
  };

  test("an open tab is refused, nothing goes through, and the " +
    "session carries on after", async ({ request }) => {
    const email = uniqueEmail("maint-open");
    const since = new Date();

    await flip("off");
    await signIn(request, email);
    expect((await request.get("/api/account/orders")).status()).toBe(200);

    await flip("on");

    const refused = async (res) => {
      expect(res.status()).toBe(503);
      expect((await res.json()).message).toBe(MESSAGE);
    };

    await refused(await request.get("/api/account/orders"));
    await refused(await request.patch("/api/account/profile", {
      data: { firstName: "Changed" },
    }));
    await refused(await request.post("/api/auth/request", {
      data: { email, next: "/account/" },
    }));
    await refused(await request.post("/api/news/subscribe", {
      data: { email },
    }));

    const order = await postOrder(request, await eggOrder(request, { email }));

    expect(order.status).toBe(503);
    expect(order.body.message).toBe(MESSAGE);
    expect(await nff(["orders", "list", `--email=${email}`]))
      .toContain("No orders.");

    // Still signed in, told so; reads that never change anything go on.
    const me = await (await request.get("/api/me")).json();

    expect(me.signedIn).toBe(true);
    expect(me.maintenance).toBe(true);
    expect((await request.get("/api/stock")).status()).toBe(200);
    expect((await request.get("/api/checkout/config")).status()).toBe(200);

    await flip("off");
    expect((await request.get("/api/account/orders")).status()).toBe(200);
    await teardown([
      () => nff(["customers", "delete", email], { allowFail: true }),
      () => clearMail({ to: email, since }),
    ]);
  });

  test("a payment made just before the flip is kept", async ({ request }) => {
    const email = uniqueEmail("maint-paid");
    let id;

    try {
      await flip("off");
      await signIn(request, email);

      const placed = await postOrder(request, await eggOrder(request, {
        email,
      }));

      expect(placed.status, JSON.stringify(placed.body)).toBe(200);
      id = placed.body.orderId;

      await flip("on");
      expect(JSON.parse(await nff(["orders", "show", id])).status)
        .toBe("paid");
      expect((await request.get("/api/account/orders")).status()).toBe(503);

      await flip("off");

      const mine = await (await request.get("/api/account/orders")).json();

      expect(mine.orders.map((o) => o.id)).toContain(id);
    } finally {
      await flip("off");
      if (id) await closeOrder(id);
      await nff(["customers", "delete", email], { allowFail: true });
    }
  });

  test("a Square webhook arriving during maintenance is taken",
    async ({ request }) => {
      const key = stagingEnv("SQUARE_WEBHOOK_SIGNATURE_KEY");

      test.skip(!key, "No SQUARE_WEBHOOK_SIGNATURE_KEY in .env.staging.");

      const url = stagingEnv("SQUARE_WEBHOOK_URL")
        || `${BASE_URL}/api/square/webhook`;
      const body = JSON.stringify({ type: "payment.updated", data: {} });
      const signature = createHmac("sha256", key).update(url + body)
        .digest("base64");

      await flip("on");

      const res = await request.post("/api/square/webhook", {
        headers: {
          "content-type": "application/json",
          "x-square-hmacsha256-signature": signature,
        },
        data: body,
      });

      expect(res.status(), await res.text()).toBe(200);
      await flip("off");
    });

  test("every flip emails the farm", async () => {
    const since = new Date();

    await flip("on");
    await waitForMail({ subject: /Maintenance mode is ON/, since });
    await flip("off");
    await waitForMail({ subject: /Maintenance mode is OFF/, since });
    await clearMail({ subject: "Maintenance mode is", since });
  });

  test("the phone links ask first, then flip", async ({ page }) => {
    test.skip(!stagingEnv("MAINTENANCE_SECRET"),
      "No MAINTENANCE_SECRET in .env.staging.");

    await flip("off");

    const links = await nff(["maintenance", "links"]);
    const on = links.match(/ON:\s+(\S+)/)[1];
    const off = links.match(/OFF:\s+(\S+)/)[1];

    await page.goto(on);
    await expect(page.getByRole("button", { name: "Turn maintenance ON" }))
      .toBeVisible();
    expect(await status(), "opening the link flips nothing").toBe(false);

    await page.getByRole("button", { name: "Turn maintenance ON" }).click();
    await expect(page.getByText("Maintenance is now ON")).toBeVisible();
    expect(await status()).toBe(true);

    await page.goto(off);
    await page.getByRole("button", { name: "Turn maintenance OFF" }).click();
    await expect(page.getByText("Maintenance is now OFF")).toBeVisible();
    expect(await status()).toBe(false);
  });
});
