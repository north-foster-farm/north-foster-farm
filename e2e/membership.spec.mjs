// The Membership tab for a member of one group who hosts another
// (#495, QA item 4; James, 6458200999): the member's own group in the
// member's part, the hosted one with its QR code and members, and the
// host's requests naming the hosted group. The account's endpoints are
// canned, so this runs on a local build, and nothing is saved anywhere.

import { CUSTOMER, cannedDates } from "./support/canned.mjs";
import { expect, test } from "./support/order.mjs";

const PLACE = {
  name: "Canned Gym", street: "1 Main St", city: "Foster", state: "RI",
  zip: "02825",
};

const VIEW = {
  member: {
    key: "vff", group: { name: "The Village Family Fitness", place: PLACE },
    rounds: null,
  },
  hosts: [{
    key: "gym2", group: { name: "Second Gym", place: PLACE }, rounds: null,
    qr: { setAt: "2026-10-28T00:00:00.000Z" },
    members: [{
      email: "rob@example.com", name: "Rob Example",
      joinedAt: "2026-10-28T00:00:00.000Z", via: "farm",
    }],
  }],
};

const SVG = "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 1 1\">"
  + "<rect width=\"1\" height=\"1\"/></svg>";

test.describe("a member of one group who hosts another", () => {
  test("sees both, and the host's part acts on the hosted group",
    async ({ page, context, baseURL }) => {
      const posted = [];

      await context.addCookies([{
        name: "nff_signed_in", value: "1", url: baseURL,
      }]);
      await page.route("**/api/me", (route) => route.fulfill({
        json: { signedIn: true, customer: CUSTOMER, membership: true },
      }));
      await page.route("**/api/account/orders", (route) => route.fulfill({
        json: { orders: [] },
      }));
      await page.route("**/api/account/cart", (route) => route.fulfill({
        json: { ok: true, cart: null },
      }));
      await page.route("**/api/membership", (route) => route.fulfill({
        json: VIEW,
      }));
      await page.route("**/api/membership/qr**", (route) => {
        const req = route.request();

        if (req.method() === "POST") {
          posted.push(req.postDataJSON());

          return route.fulfill({
            json: { ok: true, qr: { setAt: "2026-10-28T01:00:00.000Z" } },
          });
        }

        return route.fulfill({ contentType: "image/svg+xml", body: SVG });
      });
      await cannedDates(page);
      await page.goto("/account/#membership");

      const blocks = page.locator("#mem-groups [data-mem-group]");

      await expect(blocks).toHaveCount(2);

      // The member's own group: its facts, no host's part.
      const own = blocks.nth(0);

      await expect(own.locator("[data-mem='name']"))
        .toHaveText("The Village Family Fitness");
      await expect(own.locator("[data-mem-host]")).toBeHidden();
      await expect(page.locator("[data-mem-leave]"))
        .toContainText("Leave the group");

      // The hosted group: its QR code and members, every request
      // naming it.
      const hosted = blocks.nth(1);

      await expect(hosted.locator("[data-mem='name']"))
        .toHaveText("Second Gym");
      await expect(hosted.locator("[data-mem-host]")).toBeVisible();
      await expect(hosted.getByRole("region", { name: "Second Gym" }))
        .toBeVisible();
      await expect(hosted.locator("[data-member]"))
        .toContainText("Rob Example");
      await expect(hosted.locator("[data-mem='qr']"))
        .toHaveAttribute("src", /[?&]group=gym2&/);
      await expect(hosted.locator("[data-mem='download']"))
        .toHaveAttribute("href", /\?group=gym2&download=1$/);

      await hosted.getByRole("button", { name: "Generate new QR code" })
        .first().click();
      await hosted.locator("[data-mem='rotate']").click();
      await expect(hosted.locator("[data-mem='qr-status']"))
        .toContainText("Here's your new QR code");
      expect(posted).toEqual([{ group: "gym2", rotate: true }]);
    });
});
