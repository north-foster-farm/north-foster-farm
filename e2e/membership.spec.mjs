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

// The rounds as lib/membership.mjs's roundsNow gives them (#597): the
// member's group with a next round, the hosted one without.
const CLOSES = "2026-11-22T04:59:00.000Z";
const ROUNDS = {
  every: 2, opens: "08:30", closes: "09:00",
  current: { date: "2026-11-22", closesAt: CLOSES },
  next: { date: "2026-12-06", opensAt: CLOSES },
};

const VIEW = {
  member: {
    key: "vff", group: { name: "The Village Family Fitness", place: PLACE },
    rounds: ROUNDS,
  },
  hosts: [{
    key: "gym2", group: { name: "Second Gym", place: PLACE },
    rounds: { ...ROUNDS, next: null },
    qr: { link: "http://localhost/gym2" },
    members: [{
      email: "rob@example.com", name: "Rob Example",
      joinedAt: "2026-10-28T00:00:00.000Z", via: "farm",
    }],
  }],
};

const signIn = async (page, context, baseURL) => {
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
  await cannedDates(page);
};

// A list's rows as [label, value], the value as the page wrote it.
const rowsOf = (list) => list.evaluate((dl) => Array.from(
  dl.querySelectorAll("dt"),
  (dt) => [dt.textContent, dt.nextElementSibling.textContent]
));

const SVG = "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 1 1\">"
  + "<rect width=\"1\" height=\"1\"/></svg>";

test.describe("a member of one group who hosts another", () => {
  test("sees both, and the host's part acts on the hosted group",
    async ({ page, context, baseURL }) => {
      const posted = [];

      await signIn(page, context, baseURL);
      await page.route("**/api/membership/qr**", (route) => {
        const req = route.request();

        if (req.method() !== "GET") posted.push(req.postDataJSON());

        return route.fulfill({ contentType: "image/svg+xml", body: SVG });
      });
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
        .toHaveAttribute("src", /\?group=gym2$/);
      await expect(hosted.locator("[data-mem='download']"))
        .toHaveAttribute("href", /\?group=gym2&download=1$/);

      // #589: the field holds the short link and Copy copies it, and
      // nothing in the pane replaces the code or the link.
      await expect(hosted.getByLabel("Join link"))
        .toHaveValue("http://localhost/gym2");
      await page.evaluate(() => {
        window.copiedText = [];
        Object.defineProperty(navigator, "clipboard", {
          configurable: true,
          value: { writeText: async (t) => { window.copiedText.push(t); } },
        });
      });
      await hosted.getByRole("button", { name: "Copy" }).click();
      await expect(hosted.locator("[data-mem='link-copied']"))
        .toHaveText("Link copied");
      expect(await page.evaluate(() => window.copiedText))
        .toEqual(["http://localhost/gym2"]);
      await expect(hosted.getByRole("button", { name: /Generate/ }))
        .toHaveCount(0);
      await expect(hosted.locator("[data-mem='rotate']")).toHaveCount(0);
      await expect(hosted).not.toContainText("/join/");
      expect(posted).toEqual([]);
    });

  // #597: This round and Next round as subheadings under the group's
  // name, each over its own rows with the short labels, and on a phone
  // each date and time on one line, its last two words kept together.
  test("sees each round under its own subheading", async ({
    page, context, baseURL,
  }) => {
    await signIn(page, context, baseURL);
    await page.route("**/api/membership/qr**", (route) => route.fulfill({
      contentType: "image/svg+xml", body: SVG,
    }));
    await page.goto("/account/#membership");

    const blocks = page.locator("#mem-groups [data-mem-group]");
    const own = blocks.nth(0);
    const hosted = blocks.nth(1);
    const round = (block, name) => block.locator(".account-membership-round")
      .filter({ has: page.getByRole("heading", { level: 3, name }) });
    const _ = " ";

    await expect(own.getByRole("heading", { level: 3 }))
      .toHaveText(["This round", "Next round"]);
    expect(await rowsOf(round(own, "This round").locator("dl"))).toEqual([
      ["Closes", `Saturday, November 21,${_}11:59${_}PM`],
      ["Pickup", `Sunday, November 22,${_}8:30${_}AM`],
    ]);
    expect(await rowsOf(round(own, "Next round").locator("dl"))).toEqual([
      ["Opens", `Saturday, November 21,${_}11:59${_}PM`],
      ["Pickup", `Sunday, December 6,${_}8:30${_}AM`],
    ]);

    // No next round: no Next round heading, nor its rows.
    await expect(hosted.getByRole("heading", { level: 3 }))
      .toHaveText(["This round"]);
    await expect(hosted.locator("[data-mem-round='next']")).toHaveCount(0);

    // Every round's value on one line, at the phone's 390 px as well.
    const lines = await own.locator(".account-membership-round dd")
      .evaluateAll((dds) => dds.map((dd) => Math.round(
        dd.getBoundingClientRect().height
          / parseFloat(getComputedStyle(dd).lineHeight)
      )));

    expect(lines).toEqual([1, 1, 1, 1]);

    // The rounds share the label column with Pickup and Rounds.
    const starts = await own.locator(".account-membership-value")
      .evaluateAll((dds) => dds.map((dd) => dd.getBoundingClientRect().left));

    expect(new Set(starts).size).toBe(1);
  });

  // A group with no rounds yet shows Pickup alone: no Rounds row, no
  // subheadings and no round rows (#597).
  test("sees only Pickup for a group with no rounds", async ({
    page, context, baseURL,
  }) => {
    await signIn(page, context, baseURL);
    // The last route wins, so this one answers instead of signIn's.
    await page.route("**/api/membership", (route) => route.fulfill({
      json: { ...VIEW, member: { ...VIEW.member, rounds: null } },
    }));
    await page.route("**/api/membership/qr**", (route) => route.fulfill({
      contentType: "image/svg+xml", body: SVG,
    }));
    await page.goto("/account/#membership");

    const own = page.locator("#mem-groups [data-mem-group]").nth(0);

    await expect(own.locator("[data-mem='name']"))
      .toHaveText("The Village Family Fitness");
    await expect(own.locator(".account-membership-term"))
      .toHaveText(["Pickup"]);
    await expect(own.locator(".account-membership-value")).toHaveCount(1);
    await expect(own.locator(".account-membership-value"))
      .toContainText(PLACE.name);
    await expect(own.getByRole("heading", { level: 3 })).toHaveCount(0);
    await expect(own.locator("[data-mem-round]")).toHaveCount(0);
  });
});
