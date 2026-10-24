// The staging toolbar itself: on the staging branch deploy only, and
// for a person's gate session, never the suite's machine cookie (#294).
// docs/qa-launch.md, "Staging".

import { expect, test } from "./support/order.mjs";
import { orderLimitHeaders } from "./support/staging.mjs";

// A pull request preview is deploy-preview-<n>--<site>, and a branch
// deploy <branch>--<site>; the toolbar is for the staging branch deploy
// alone (#255), never a preview or a local server.
const preview = (baseURL) =>
  new URL(baseURL).hostname.startsWith("deploy-preview-");
const branch = (baseURL) =>
  new URL(baseURL).hostname.includes("--") && !preview(baseURL);

test.describe("staging toolbar", () => {
  test.use({ hideToolbar: false });

  test("a deploy preview carries no toolbar", async ({ page, baseURL }) => {
    test.skip(!preview(baseURL), "only on a deploy preview");
    await page.goto("/");
    await expect(page.locator("body")).toBeVisible();
    expect(await page.locator("#staging").count()).toBe(0);
    expect(await page.locator("script[src*='staging']").count()).toBe(0);
  });

  // The toolbar opens for any gate session (#294). The suite's machine
  // cookie passes the gate but is no session, so for it the page
  // carries no toolbar and the staging API refuses.
  test("the suite's machine gets no toolbar, and the API refuses",
    async ({ page, request, baseURL }) => {
      test.skip(!branch(baseURL), "only on a branch deploy");
      await page.goto("/");
      await page.waitForLoadState("networkidle");
      await expect(page.locator("#staging")).toBeHidden();
      expect((await request.get("/api/staging/info")).status()).toBe(401);
      expect((await request.get("/api/staging/outbox")).status()).toBe(401);
    });

  // The packing slips (#334): the suite's machine cookie is no session,
  // so the endpoint refuses it like the rest.
  test("the packing slips refuse the suite's machine",
    async ({ request, baseURL }) => {
      test.skip(!branch(baseURL), "only on a branch deploy");
      expect((await request.get("/api/staging/slips")).status()).toBe(401);
      expect((await request.get("/api/staging/slips/card")).status())
        .toBe(401);
    });

  // The packing slips view (#334): ten pages and today's packet, and
  // the reader's Open alone and Download each lead to a PDF.
  //
  // Runs only with a gate session cookie in E2E_GATE_SESSION, as the
  // reset test below does.
  test("the packing slips list every page and open as PDFs",
    async ({ page, context, baseURL }) => {
      test.skip(!branch(baseURL), "only on a branch deploy");
      test.skip(!process.env.E2E_GATE_SESSION,
        "needs the toolbar owner's gate session");
      await context.addCookies([
        {
          name: "nff_gate", value: process.env.E2E_GATE_SESSION,
          domain: new URL(baseURL).hostname, path: "/",
          httpOnly: true, secure: true, sameSite: "Lax",
        },
      ]);
      await page.goto("/about/#slips");

      const items = page.locator("[data-staging-slips-list] a[data-id]");

      await expect(items).toHaveCount(11);
      await expect(items.last()).toContainText("Today's packet");

      await items.first().click();

      const alone = page.locator("[data-staging-slips-alone]");
      const download = page.locator("[data-staging-slips-download]");
      const id = await items.first().getAttribute("data-id");

      await expect(alone).toHaveAttribute("href", `/api/staging/slips/${id}`);
      await expect(download).toHaveAttribute("download", `${id}.pdf`);

      for (const link of [alone, download]) {
        const res = await page.request.get(await link.getAttribute("href"));

        expect(res.status()).toBe(200);
        expect(res.headers()["content-type"]).toBe("application/pdf");
        expect((await res.body()).subarray(0, 5).toString()).toBe("%PDF-");
      }
    });

  // A page after the reset is the page a stranger gets: nothing the
  // site keeps in the browser survives, and the farm news forms,
  // hidden for someone on the list, are back (#267).
  //
  // This runs only with a gate session cookie in E2E_GATE_SESSION (the
  // nff_gate cookie's value, from a browser signed in to the gate).
  test("Reset to first visit leaves a fresh browser",
    async ({ page, context, baseURL }) => {
      test.skip(!branch(baseURL), "only on a branch deploy");
      test.skip(!process.env.E2E_GATE_SESSION,
        "needs the toolbar owner's gate session");
      await context.addCookies([
        {
          name: "nff_gate", value: process.env.E2E_GATE_SESSION,
          domain: new URL(baseURL).hostname, path: "/",
          httpOnly: true, secure: true, sameSite: "Lax",
        },
        { name: "nff_signed_in", value: "1", url: baseURL },
      ]);
      await page.goto("/about/");
      await page.evaluate(() => {
        localStorage.setItem("nff-news", "joined");
        localStorage.setItem("nff-venmo", "1");
        localStorage.setItem("nff-order-draft", "{}");
        localStorage.setItem("nff:autoplay", "off");
        sessionStorage.setItem("nff-me", "seeded");
      });
      await page.reload();
      await page.locator("[data-staging-open]").click();
      // The click clears, then reloads. Waiting for "load" alone passes
      // at once on the page being left, so wait for the new document.
      await Promise.all([
        page.waitForEvent("load"),
        page.locator("[data-staging-forget]").click(),
      ]);

      const kept = await page.evaluate(() => ({
        local: Object.keys(localStorage)
          .filter((k) => !k.startsWith("staging.")),
        // The new page caches who is signed in again, as a first visit
        // does; the seeded value must be gone.
        session: sessionStorage.getItem("nff-me") === "seeded",
        cookie: document.cookie,
      }));

      expect(kept).toEqual({ local: [], session: false, cookie: "" });
      await expect(page.locator("footer [data-farm-list-block]")).toBeVisible();
    });

  // #350: the reset empties the cart on the order page, signed in or
  // not, and starts the toolbar's list of this session's emails afresh.
  // The gate session and the open toolbar stay. Written, not run here:
  // it needs a gate session and the staging deploy.
  test.describe("Reset to first visit (#350)", () => {
    const EGGS = "NFF-CHK-EGG-LG";
    const WIDTHS = [
      { name: "phone", width: 375, height: 800 },
      { name: "tablet", width: 768, height: 1000 },
      { name: "desktop", width: 1280, height: 900 },
    ];
    const qty = (page) => page.locator(`#order-form [data-qty="${EGGS}"]`);

    const enter = async (context, baseURL) => {
      await context.addCookies([{
        name: "nff_gate", value: process.env.E2E_GATE_SESSION,
        domain: new URL(baseURL).hostname, path: "/",
        httpOnly: true, secure: true, sameSite: "Lax",
      }]);
    };

    // One email filed under this gate session: a contact message, whose
    // copy to the farm lands in the outbox.
    const seedMail = async (page) => {
      const sent = await page.request.post("/api/contact", {
        headers: orderLimitHeaders(),
        data: {
          name: "Reset QA", email: "qa-e2e-reset@example.com",
          message: "Seed for the staging reset test",
        },
      });

      expect(sent.status()).toBe(200);
      await page.locator("[data-staging-refresh]").click();
      await expect(page.locator("[data-staging-list] li").first())
        .toBeVisible({ timeout: 15_000 });
    };

    const resetAndReload = async (page) => {
      await Promise.all([
        page.waitForEvent("load"),
        page.locator("[data-staging-forget]").click(),
      ]);
    };

    // What must hold after any reset: the gate session answers, the
    // toolbar is still open and its list of this session's emails is
    // empty.
    const stays = async (page) => {
      await expect(page.locator("[data-staging-panel]")).toBeVisible();
      expect((await page.request.get("/api/staging/info")).status())
        .toBe(200);
      await page.locator("[data-staging-refresh]").click();
      await expect(page.locator("[data-staging-list] li")).toHaveCount(0);
    };

    for (const size of WIDTHS) {
      test(`empties the draft cart and the session's mail at ${size.name}`,
        async ({ page, context, baseURL }) => {
          test.skip(!branch(baseURL), "only on a branch deploy");
          test.skip(!process.env.E2E_GATE_SESSION,
            "needs the toolbar owner's gate session");
          await page.setViewportSize(size);
          await enter(context, baseURL);
          await page.goto("/order/");
          await page.evaluate(() => {
            localStorage.setItem("staging.open", "1");
          });
          await page.reload();
          await seedMail(page);
          await page.evaluate((sku) => {
            localStorage.setItem("nff-order-draft", JSON.stringify({
              payload: { lines: [{ sku, qty: 2 }] }, savedAt: Date.now(),
            }));
          }, EGGS);
          await page.reload();
          await resetAndReload(page);

          expect(await page.evaluate(() => localStorage.getItem(
            "nff-order-draft"))).toBeNull();
          await expect(qty(page)).toHaveValue("0");
          await stays(page);
        });
    }

    // The form-memory cause: a quantity typed into the box, with no
    // draft stored, is put back by the browser on a plain reload.
    test("empties a quantity the browser remembers, with no draft",
      async ({ page, context, baseURL }) => {
        test.skip(!branch(baseURL), "only on a branch deploy");
        test.skip(!process.env.E2E_GATE_SESSION,
          "needs the toolbar owner's gate session");
        await enter(context, baseURL);
        await page.goto("/order/");
        await page.evaluate(() => {
          localStorage.setItem("staging.open", "1");
        });
        await page.reload();
        await qty(page).fill("3");
        await qty(page).press("Tab");
        await page.evaluate(() => {
          localStorage.removeItem("nff-order-draft");
        });
        await resetAndReload(page);

        expect(await page.evaluate(() => localStorage.getItem(
          "nff-order-draft"))).toBeNull();
        await expect(qty(page)).toHaveValue("0");
        await stays(page);
      });

    // Signed in: the account's cart comes back on a reload while the
    // session lives, so the reset must end it first. The account's
    // endpoints are canned and flip to signed out once the sign-out
    // POST has been made.
    for (const size of WIDTHS) {
      test(`signs out and empties the account's cart at ${size.name}`,
        async ({ page, context, baseURL }) => {
          test.skip(!branch(baseURL), "only on a branch deploy");
          test.skip(!process.env.E2E_GATE_SESSION,
            "needs the toolbar owner's gate session");

          let signedIn = true;
          let signOuts = 0;

          await page.setViewportSize(size);
          await enter(context, baseURL);
          await context.addCookies([{
            name: "nff_signed_in", value: "1", url: baseURL,
          }]);
          await page.route("**/api/me", (route) => route.fulfill({
            json: signedIn
              ? {
                signedIn: true,
                customer: {
                  email: "qa-e2e-reset@example.com",
                  firstName: "Ada", lastName: "Hen",
                },
              }
              : { signedIn: false },
          }));
          await page.route("**/api/account/cart", (route) => {
            if (route.request().method() === "PUT") {
              return route.fulfill({ json: { ok: true, kept: true } });
            }

            return route.fulfill({
              json: {
                ok: true,
                cart: signedIn ? {
                  payload: {
                    lines: [{ sku: EGGS, qty: 2 }],
                    fulfilment: { method: "onfarm" }, code: "",
                  },
                  savedAt: Date.now(),
                } : null,
              },
            });
          });
          await page.route("**/api/auth/signout", (route) => {
            signedIn = false;
            signOuts += 1;

            return route.fulfill({ json: { ok: true } });
          });
          await page.goto("/order/");
          await page.evaluate(() => {
            localStorage.setItem("staging.open", "1");
          });
          await page.reload();
          await expect(qty(page)).toHaveValue("2");
          await resetAndReload(page);

          expect(signOuts).toBe(1);
          await expect(qty(page)).toHaveValue("0");
          expect((await context.cookies()).some(
            (c) => c.name === "nff_signed_in")).toBe(false);
          await expect(page.locator("[data-staging-panel]")).toBeVisible();
        });
    }

    test("says so, and keeps the page, when the server refuses",
      async ({ page, context, baseURL }) => {
        test.skip(!branch(baseURL), "only on a branch deploy");
        test.skip(!process.env.E2E_GATE_SESSION,
          "needs the toolbar owner's gate session");
        await enter(context, baseURL);
        await page.route("**/api/auth/signout", (route) => route.fulfill({
          status: 403, json: { ok: false },
        }));
        await page.route("**/api/staging/outbox", (route) => (
          route.request().method() === "DELETE"
            ? route.fulfill({ status: 403, json: { ok: false } })
            : route.continue()));
        await page.goto("/order/");
        await page.evaluate(() => {
          localStorage.setItem("staging.open", "1");
        });
        await page.reload();
        await page.locator("[data-staging-forget]").click();
        await expect(page.locator("[data-staging-out]")).toHaveText(
          "The browser is reset, but the server did not end the " +
          "sign-in or empty this session's emails."
        );
      });
  });

  // #294 §4: the first time a gate session opens the order page, the
  // sandbox card takes the page as a modal until it is closed; it
  // stays closed for the session, and Reset to first visit brings
  // it back.
  test("the card overlay shows once per gate session",
    async ({ page, context, baseURL, browserName }) => {
      test.skip(preview(baseURL), "never on a preview");
      test.skip(!process.env.E2E_GATE_SESSION, "needs a gate session");
      await asSession(context, baseURL);
      const dialog = page.locator("[data-staging-card-dialog]");

      await page.goto("/order/");
      await expect(dialog).toBeVisible();
      expect(await dialog.evaluate((d) => d.matches(":modal"))).toBe(true);
      await expect(dialog).toContainText("Simulate an order in staging: " +
        "pay by card and use the Square sandbox card details:");
      await expect(dialog).toContainText("4111 1111 1111 1111");
      await expect(dialog).toContainText("Open the staging toolbar " +
        "(bottom right) if you want to see these card details again.");
      // Focus starts inside and Tab keeps it out of the page behind.
      const inside = () => page.evaluate(() => !!document.activeElement
        .closest("[data-staging-card-dialog]"));
      const outside = () => page.evaluate(() => !!document.activeElement
        .closest("main, header, footer"));

      expect(await inside()).toBe(true);
      for (let i = 0; i < 8; i += 1) {
        await page.keyboard.press("Tab");
        expect(await outside()).toBe(false);
      }

      if (browserName === "chromium") {
        await context.grantPermissions(["clipboard-read", "clipboard-write"]);
        await dialog.getByRole("button", { name: "Copy" }).nth(1).click();
        await expect(dialog.locator(".staging-copied").nth(1))
          .toHaveText("Copied");
        expect(await page.evaluate(() => navigator.clipboard.readText()))
          .toBe("4111111111111111");
      }

      await dialog.getByRole("button", { name: "Copy" }).first().focus();
      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
      expect(await outside()).toBe(true);

      await page.reload();
      await expect(page.locator("#staging")).toBeVisible();
      await expect(dialog).toBeHidden();

      // The toolbar keeps the same details; Reset brings the overlay
      // back.
      await page.locator("[data-staging-open]").click();
      await expect(page.locator("#staging .staging-card"))
        .toContainText("4111 1111 1111 1111");
      await Promise.all([
        page.waitForEvent("load"),
        page.locator("[data-staging-forget]").click(),
      ]);
      await expect(dialog).toBeVisible();
      await dialog.locator("[data-staging-card-close]").click();
      await expect(dialog).toBeHidden();
    });

  // #294 §3: the clock moves the server's time for this browser alone,
  // and shows while it is set.
  test("the clock moves the site's time for this browser alone",
    async ({ page, context, browser, baseURL }) => {
      test.skip(preview(baseURL), "never on a preview");
      test.skip(!process.env.E2E_GATE_SESSION, "needs a gate session");
      await asSession(context, baseURL);
      const datesNow = async (p) => (await (await p.request
        .get("/api/dates")).json()).now;

      await page.goto("/");
      await page.locator("[data-staging-open]").click();
      await page.locator("#staging-clock-at").fill("2027-01-07T06:00");
      await Promise.all([
        page.waitForEvent("load"),
        page.locator("[data-staging-clock] [type=submit]").click(),
      ]);
      try {
        await expect(page.locator("[data-staging-clock-now]"))
          .toHaveText(/Currently: Thu, Jan 7, 2027, 6:00\sAM/);
        await expect(page.locator("[data-staging-badge-time]"))
          .toBeVisible();
        await expect(page.locator("[data-staging-open]"))
          .toContainText("Jan 7, 2027");
        expect(await datesNow(page)).toMatch(/^2027-01-07T11:0/);

        // Another browser on the same gate session keeps the real time.
        const other = await browser.newContext();

        await asSession(other, baseURL);
        const elsewhere = await datesNow(await other.newPage());

        await other.close();
        expect(Math.abs(Date.parse(elsewhere) - Date.now()))
          .toBeLessThan(10 * 60_000);
      } finally {
        await page.request.delete("/api/staging/clock");
      }
      await page.reload();
      await expect(page.locator("[data-staging-badge-time]")).toBeHidden();
    });
});

// Signs `context` in to the gate with E2E_GATE_SESSION.
const asSession = (context, baseURL) => context.addCookies([{
  name: "nff_gate", value: process.env.E2E_GATE_SESSION,
  domain: new URL(baseURL).hostname, path: "/",
  httpOnly: true, secure: true, sameSite: "Lax",
}]);
