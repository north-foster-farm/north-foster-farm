// #489: with maintenance on, the maintenance bar shows as soon as the
// order, account or sign-in page loads, wherever /api/me already says
// `maintenance: true`, not only once the API refuses something. An
// admin's session sees no bar, and the refusal paths (#267) still
// show it.
//
// No switch is flipped. Every answer the pages get is made by the
// site's own handlers, run here in memory: /api/me by netlify/
// functions/auth.mjs over test stores whose setting says maintenance
// is on, and the refusal by lib/maintenance.mjs's refusal(). So the
// shape and the farm's words are the server's, and the bar's text is
// MESSAGE, read from its one source.
//
// Desktop only: the Pay test fills a card, which on staging is the
// sandbox, and the bar has no layout of its own to check on a phone.

import { ORDER } from "./support/canned.mjs";
import {
  OrderPage, expect, test, uniqueEmail,
} from "./support/order.mjs";
import { handle as authApi } from "../netlify/functions/auth.mjs";
import { createSession } from "../netlify/functions/lib/auth.mjs";
import {
  MESSAGE, refusal,
} from "../netlify/functions/lib/maintenance.mjs";
import { saveCustomer } from "../netlify/functions/lib/records.mjs";
import { testStores } from "../netlify/functions/lib/store.mjs";

// Made-up addresses on example.com; ADMIN is the admin by env, as
// DEV_NOTIFICATIONS_EMAIL makes one on a deploy.
const CUSTOMER_EMAIL = "qa-e2e-maint-bar@example.com";
const ADMIN = "qa-e2e-maint-admin@example.com";
const env = { DEV_NOTIFICATIONS_EMAIL: ADMIN, SITE_CONTEXT: "branch-deploy" };

const customerOf = (email) => ({
  email, name: "Pat Example", firstName: "Pat", lastName: "Example",
  phone: "", avatar: null, discountGroup: null, address: null,
  createdAt: "2026-09-01T00:00:00.000Z", lastOrderAt: null,
});

// What /api/me answers, from auth.mjs itself: `on` is the
// maintenance switch, `who` the signed-in address or null.
const meAnswer = async ({ on, who = null }) => {
  const stores = testStores();
  const now = new Date();
  const headers = {};

  if (on) await stores.jobs.set("setting/maintenance", { on: true, epoch: 1 });
  if (who) {
    await saveCustomer(stores, customerOf(who));

    const session = await createSession(stores, who, { now });

    headers.cookie = `nff_session=${session.id}`;
  }

  const res = await authApi(
    new Request("https://x/api/me", { headers }), { stores, env, now },
  );

  return res.json();
};

// The answer maintenance gives a refused change: status, headers and
// body as lib/maintenance.mjs sends them.
const refused = async () => {
  const res = refusal();

  return {
    status: res.status,
    headers: Object.fromEntries(res.headers),
    body: await res.text(),
  };
};

const cannedMe = async (page, answer) => {
  await page.route("**/api/me", (route) => route.fulfill({ json: answer }));
};

// The account page's own reads, for a signed-in session.
const cannedAccount = (page) => page.route("**/api/account/orders",
  (route) => route.fulfill({ json: { orders: [ORDER] } }));

// Loads `path` and waits for the page's /api/me answer to be read.
// Not the whole `load` event, which the payment SDKs can hold on the
// order page (#506, support/order.mjs open()).
const load = async (page, path) => {
  const me = page.waitForResponse("**/api/me");

  await page.goto(path, { waitUntil: "domcontentloaded" });
  await (await me).finished();
};

const bar = (page) => page.locator("#maintenance-notice");

const expectBar = async (page) => {
  await expect(bar(page)).toBeVisible();
  await expect(bar(page)).toHaveText(MESSAGE);
};

test.describe("the maintenance bar on load (#489)", () => {
  test.describe("the bar shows on load on the order, account and " +
    "sign-in pages while maintenance is on", () => {
    test("the order page, signed out", async ({ page }) => {
      await cannedMe(page, await meAnswer({ on: true }));
      await load(page, "/order/");
      await expectBar(page);
    });

    test("the order page, signed in", async ({ page }) => {
      await cannedMe(page, await meAnswer({ on: true, who: CUSTOMER_EMAIL }));
      await load(page, "/order/");
      await expectBar(page);
    });

    test("the account page, signed in", async ({ page }) => {
      await cannedMe(page, await meAnswer({ on: true, who: CUSTOMER_EMAIL }));
      await cannedAccount(page);
      await load(page, "/account/");
      await expectBar(page);
    });

    test("the sign-in page, signed out", async ({ page }) => {
      await cannedMe(page, await meAnswer({ on: true }));
      await load(page, "/login/");
      await expectBar(page);
    });
  });

  test.describe("an admin's session sees no bar", () => {
    test("the order page", async ({ page }) => {
      const answer = await meAnswer({ on: true, who: ADMIN });

      // The server's bypass: an admin's /api/me carries no notice.
      expect(answer.maintenance).toBeUndefined();
      await cannedMe(page, answer);
      await load(page, "/order/");
      // The form is wired, as OrderPage.open() waits for it.
      await expect(page.locator("#onfarm-date")).toBeEnabled();
      await expect(bar(page)).toHaveCount(0);
    });

    test("the account page", async ({ page }) => {
      const answer = await meAnswer({ on: true, who: ADMIN });

      expect(answer.maintenance).toBeUndefined();
      await cannedMe(page, answer);
      await cannedAccount(page);
      await load(page, "/account/");
      await expect(page.getByText(ORDER.id).first()).toBeVisible();
      await expect(bar(page)).toHaveCount(0);
    });
  });

  // A tab opened before the switch flipped: /api/me said nothing, and
  // the change it then sends is refused.
  test.describe("a refused change still shows the bar", () => {
    test("a sign-in request", async ({ page }) => {
      const answer = await refused();

      await cannedMe(page, await meAnswer({ on: false }));
      await page.route("**/api/auth/request", (route) => route.fulfill(answer));
      await load(page, "/login/");
      await expect(bar(page)).toHaveCount(0);
      await page.locator("#login-email").fill(CUSTOMER_EMAIL);
      await page.locator("#login-submit").click();
      await expectBar(page);
    });

    test("an order's Pay", async ({ page }) => {
      const answer = await refused();

      await cannedMe(page, await meAnswer({ on: false }));
      await page.route("**/api/orders", (route) => (
        route.request().method() === "POST"
          ? route.fulfill(answer)
          : route.fallback()
      ));

      const order = new OrderPage(page);

      await order.open({ eggs: 1 });
      await expect(bar(page)).toHaveCount(0);
      await order.method("onfarm");
      await order.contact({ first: "Maint", email: uniqueEmail("maint-bar") });
      await order.firstDate("onfarm");
      await order.openCard();
      await order.card();
      await order.submit.click();
      await expectBar(page);
    });
  });
});
