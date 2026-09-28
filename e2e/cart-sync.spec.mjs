// #149: a signed-in customer's cart follows them across devices. The
// account's cart endpoint and /api/me are canned, so this runs on a
// local build as on staging, and no cart is saved anywhere.

import { cannedDates } from "./support/canned.mjs";
import { expect, test } from "./support/order.mjs";

const EMAIL = "qa-e2e-cartsync@example.com";
const EGGS = "NFF-CHK-EGG-LG";
const WHOLE = "NFF-CHK-WHL-0200-0250";

const cart = (lines, savedAt) => ({
  payload: {
    customer: { email: EMAIL }, lines, fulfilment: { method: "onfarm" },
    code: "",
  },
  savedAt,
});

// `remote` is the account's cart; `local` the draft already in this
// browser; `hold`, a promise the account's answer waits on. Returns
// what the page PUT, and how often it asked.
const setUp = async (page, context, baseURL, {
  remote, local, signedIn = true, hold = null,
}) => {
  const puts = [];
  let gets = 0;

  if (signedIn) {
    // The page asks for the account's cart only with this hint.
    await context.addCookies([{
      name: "nff_signed_in", value: "1", url: baseURL,
    }]);
  }
  await page.route("**/api/me", (route) => route.fulfill({
    json: signedIn
      ? {
        signedIn: true,
        customer: { email: EMAIL, firstName: "Ada", lastName: "Hen" },
      }
      : { signedIn: false },
  }));
  await page.route("**/api/account/cart", async (route) => {
    if (route.request().method() === "PUT") {
      const body = route.request().postDataJSON();

      puts.push(body);

      return route.fulfill({ json: { ok: true, kept: true, cart: body } });
    }
    gets += 1;
    if (hold) await hold;

    return route.fulfill({ json: { ok: true, cart: remote } });
  });
  await cannedDates(page);
  await page.addInitScript((draft) => {
    if (draft && !sessionStorage.getItem("seeded")) {
      sessionStorage.setItem("seeded", "1");
      localStorage.setItem("nff-order-draft", JSON.stringify(draft));
    }
  }, local);

  return { puts, gets: () => gets };
};

const qty = (page, sku) => page.locator(`#order-form [data-qty="${sku}"]`);

const change = async (page, sku, value) => {
  await qty(page, sku).fill(value);
  await qty(page, sku).dispatchEvent("input");
};

test.describe("the cart across devices (#149)", () => {
  test("the order page takes the account's newer cart",
    async ({ page, context, baseURL }) => {
      await setUp(page, context, baseURL, {
        remote: cart([{ sku: WHOLE, qty: 3 }], Date.now() - 1000),
        local: { key: "k", ...cart([{ sku: EGGS, qty: 1 }], 5) },
      });
      await page.goto("/order/");
      await expect(qty(page, WHOLE)).toHaveValue("3");
      await expect(qty(page, EGGS)).toHaveValue("0");

      // This browser's payment key stays its own.
      const draft = await page.evaluate(() => JSON.parse(
        localStorage.getItem("nff-order-draft")
      ));

      expect(draft.key).toBe("k");
    });

  test("a newer cart here goes up, and again after a change",
    async ({ page, context, baseURL }) => {
      const { puts } = await setUp(page, context, baseURL, {
        remote: cart([{ sku: WHOLE, qty: 3 }], 5),
        local: cart([{ sku: EGGS, qty: 1 }], Date.now() - 1000),
      });

      await page.goto("/order/");
      await expect(qty(page, EGGS)).toHaveValue("1");
      await expect.poll(() => puts.length).toBeGreaterThan(0);

      const before = puts.length;

      await change(page, EGGS, "4");
      await expect.poll(() => puts.length, { timeout: 5_000 })
        .toBeGreaterThan(before);
      expect(puts.at(-1).payload.lines).toContainEqual({ sku: EGGS, qty: 4 });
      // The payment key never leaves the browser.
      expect(puts.at(-1).payload.idempotencyKey).toBeUndefined();
    });

  test("another page asks once and shows the count",
    async ({ page, context, baseURL }) => {
      const state = await setUp(page, context, baseURL, {
        remote: cart([{ sku: WHOLE, qty: 3 }], Date.now() - 1000),
        local: null,
      });

      await page.goto("/");
      await expect(page.locator("[data-cart-badge]:visible").first())
        .toHaveText("3");
      await page.goto("/news/");
      await page.waitForLoadState("networkidle");
      expect(state.gets()).toBe(1);
    });

  test("a change while the account's copy is on its way keeps this " +
    "browser's cart", async ({ page, context, baseURL }) => {
    let release;
    const hold = new Promise((resolve) => {
      release = resolve;
    });
    const { puts, gets } = await setUp(page, context, baseURL, {
      remote: cart([{ sku: WHOLE, qty: 3 }], Date.now() - 1000),
      local: cart([{ sku: EGGS, qty: 1 }], 5),
      hold,
    });

    await page.goto("/order/");
    // The browser's draft shows while the account's copy is held, well
    // before the page would give up on it (2 s), and a tap adds to it.
    await expect.poll(gets).toBe(1);
    await expect(qty(page, EGGS)).toHaveValue("1", { timeout: 1_000 });
    await change(page, EGGS, "2");
    release();
    await expect.poll(() => puts.length, { timeout: 5_000 })
      .toBeGreaterThan(0);
    expect(puts.at(-1).payload.lines).toEqual([{ sku: EGGS, qty: 2 }]);
    await expect(qty(page, EGGS)).toHaveValue("2");
    await expect(qty(page, WHOLE)).toHaveValue("0");
  });

  test("signing out leaves no address for the next account",
    async ({ page, context, baseURL }) => {
      const local = cart([{ sku: EGGS, qty: 1 }], 5);

      local.payload.fulfilment = {
        method: "delivery", delivery: {
          address1: "1 Elm St", town: "Scituate", zip: "02857",
          cooler: "By the door", notes: "Gate code 1234",
        },
      };
      await setUp(page, context, baseURL, { remote: null, local });
      await page.route("**/api/account/orders", (route) => route.fulfill({
        json: { orders: [] },
      }));
      await page.route("**/api/auth/signout", async (route) => {
        await context.clearCookies();

        return route.fulfill({ json: {} });
      });
      await page.goto("/account/");
      await page.locator("#account-signout").click();
      await page.waitForURL((url) => url.pathname === "/");

      const draft = await page.evaluate(() => JSON.parse(
        localStorage.getItem("nff-order-draft")
      ));

      expect(draft.payload.customer).toEqual({});
      expect(draft.payload.fulfilment.delivery).toEqual({});
      expect(draft.payload.lines).toEqual([{ sku: EGGS, qty: 1 }]);
    });

  test("a guest's cart stays in the browser",
    async ({ page, context, baseURL }) => {
      const state = await setUp(page, context, baseURL, {
        signedIn: false, remote: null,
        local: cart([{ sku: EGGS, qty: 1 }], 5),
      });

      await page.goto("/order/");
      await expect(qty(page, EGGS)).toHaveValue("1");
      await change(page, EGGS, "2");
      await page.waitForTimeout(2_500);
      expect(state.gets()).toBe(0);
      expect(state.puts).toEqual([]);
    });
});
