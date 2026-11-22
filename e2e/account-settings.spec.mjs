// The account page's saving settings, pinned before account/main.js is
// split (#832, docs/refactors/account.md, phase 0, criteria 1 to 5):
// phases 5 and 6 move the autosave and the saves, and nothing else
// would catch them breaking. Canned answers (support/account-page.mjs),
// so this runs on a local build. Passes against today's page.

import {
  CUSTOMER, hold, leave, openAccount, saved, shown, writes,
} from "./support/account-page.mjs";
import { expect, test } from "./support/order.mjs";

const PROFILE = "/api/account/profile";
const ADDRESS = "/api/account/address";
const REASON = "Enter a phone number we can call or text.";
const FAILED = "Something went wrong. Please try again.";
const PENDING = "This address is outside our usual area. We're checking "
  + "whether we can deliver here and will email you.";

// The status text beside the heading of the group `field` is in.
const statusOf = (page, field) => page.locator(".account-group", {
  has: page.locator(field),
}).locator("[data-autosave] [data-save-text]");

const settings = async (page, setup, hash = "settings") => {
  const state = await openAccount(page, setup);

  await page.goto(`/account/#${hash}`);
  await shown(page);

  return state;
};

// Gives the write time to go out, if it were going to.
const settle = (page) => page.waitForTimeout(500);

test.describe("the account page's settings (#832)", () => {
  test("a field that changes shows Saving…, then Saved, and the line "
    + "clears; a refused save shows the server's reason",
  async ({ page, context, baseURL }) => {
    await page.clock.install();

    const state = await settings(page, { context, baseURL });
    const status = statusOf(page, "#prof-phone");
    const release = hold(state);

    await leave(page, "#prof-phone", "401 555 0199");
    await expect(status).toHaveText("Saving…");
    release({ json: saved({ phone: "4015550199" }) });
    await expect(status).toHaveText("Saved 👍");
    await page.clock.fastForward(11_000);
    await expect(status).toHaveText("");

    state.answer = (route) => route.fulfill({
      status: 400, json: { ok: false, errors: { phone: REASON } },
    });
    await leave(page, "#prof-phone", "12");
    await expect(status).toHaveText(`We couldn't save that. ${REASON}`);
  });

  test("the names save only once both are filled in",
    async ({ page, context, baseURL }) => {
      const state = await settings(page, { context, baseURL });

      await leave(page, "#prof-last", "");
      await leave(page, "#prof-first", "Adele");
      await settle(page);
      expect(writes(state, "PATCH", PROFILE), "a name blank").toHaveLength(0);

      await leave(page, "#prof-last", "Hen");
      await expect.poll(() => writes(state, "PATCH", PROFILE).length)
        .toBe(1);
      expect(writes(state, "PATCH", PROFILE)[0].body)
        .toMatchObject({ firstName: "Adele", lastName: "Hen" });
    });

  test("the address saves once the street, town and a five-digit ZIP are "
    + "there, and the status line follows the answer",
  async ({ page, context, baseURL }) => {
    const state = await settings(page, { context, baseURL }, "address");
    const address = { address1: "1 Main St", town: "Foster", zip: "02825" };

    state.answer = (route) => route.fulfill({ json: saved({
      address: { ...address, status: "pending" },
    }) });
    await leave(page, "#addr-address1", address.address1);
    await leave(page, "#addr-town", address.town);
    await leave(page, "#addr-zip", "0282");
    await settle(page);
    expect(writes(state, "PUT", ADDRESS), "four digits").toHaveLength(0);

    await leave(page, "#addr-zip", address.zip);
    await expect.poll(() => writes(state, "PUT", ADDRESS).length).toBe(1);
    expect(writes(state, "PUT", ADDRESS)[0].body).toMatchObject(address);
    await expect(page.locator("#address-status")).toHaveText(PENDING);
  });

  test("a chicken picked saves on its own and changes the head's and the "
    + "header's at once", async ({ page, context, baseURL }) => {
    const state = await settings(page, { context, baseURL });
    const release = hold(state);
    const radio = page.locator("#avatar-picker input[type='radio']").nth(1);
    const pick = await radio.getAttribute("value");

    await radio.check({ force: true });
    // Before the save answers: at once.
    await expect(page.locator("#account-avatar use"))
      .toHaveAttribute("href", `#avatar-${pick}`);
    await expect(page.locator("[data-account-chick] use").first())
      .toHaveAttribute("href", `#avatar-${pick}`);
    await expect.poll(() => writes(state, "PATCH", PROFILE).length).toBe(1);
    expect(writes(state, "PATCH", PROFILE)[0].body).toEqual({ avatar: pick });
    release({ json: saved({ avatar: pick }) });
  });

  test("Dismiss hides the review, and it stays hidden after a reload; a "
    + "failed save brings it back", async ({ page, context, baseURL }) => {
    const state = await settings(page, { context, baseURL });
    const review = page.locator("#account-review");

    state.answer = (route) => route.fulfill({ status: 500,
      json: { ok: false, error: "Something went wrong." } });
    await page.locator("#account-review-dismiss").click();
    await expect(review).toBeVisible();
    await expect(page.locator("#account-flash")).toHaveText(FAILED);

    state.answer = (route) => {
      state.me = { signedIn: true,
        customer: { ...CUSTOMER, reviewDismissed: true } };

      return route.fulfill({ json: saved({ reviewDismissed: true }) });
    };
    await page.locator("#account-review-dismiss").click();
    await expect(review).toBeHidden();
    expect(writes(state, "PATCH", PROFILE).at(-1).body)
      .toEqual({ reviewDismissed: true });
    await page.reload();
    await shown(page);
    await expect(review).toBeHidden();
  });
});
