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

// #601: beside a long group name the email address was squeezed to a
// letter a line at 320 px. Below md the head is one column (James):
// the avatar and the address, then the group and the credit as a row
// of their own, left aligned with the head.
test.describe("the account head of a long-named group's member", () => {
  for (const width of [390, 320]) {
    test(`keeps a short email address whole at ${width} px`, async ({
      page, context, baseURL,
    }) => {
      await page.setViewportSize({ width, height: 664 });
      await signIn(page, context, baseURL);
      await page.route("**/api/me", (route) => route.fulfill({
        json: {
          signedIn: true, membership: true,
          customer: { ...CUSTOMER, email: "member@james.com" },
          member: { name: "The Village Family Fitness", credit: 0 },
        },
      }));
      await page.goto("/account/#orders");

      const head = page.locator("#account-app .account-head");
      const email = page.locator("#account-email");

      await expect(email).toHaveText("member@james.com");
      await expect(page.locator("#account-member [data-member-group]"))
        .toHaveText("The Village Family Fitness");

      const m = await head.evaluate((node) => {
        const address = node.querySelector("#account-email");
        const group = node.querySelector("#account-member");
        const box = (el) => el.getBoundingClientRect();

        return {
          share: box(address).width / box(node).width,
          lines: Math.round(box(address).height
            / parseFloat(getComputedStyle(address).lineHeight)),
          under: box(group).top >= box(node.querySelector(
            ".account-who"
          )).bottom,
          atLeft: Math.abs(box(group).left - box(node).left) < 0.5,
          leftAligned: getComputedStyle(group).textAlign !== "right",
          inside: box(group).right <= box(node).right + 0.5,
        };
      });

      // The address has at least 60% of the head, on one line, with
      // the group in its own row under it, at the head's left edge,
      // and nothing past the head's right.
      expect(m.share).toBeGreaterThanOrEqual(0.6);
      expect(m.lines).toBe(1);
      expect(m.under).toBe(true);
      expect(m.atLeft).toBe(true);
      expect(m.leftAligned).toBe(true);
      expect(m.inside).toBe(true);
    });
  }
});

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

    await expect(own.getByRole("heading", { level: 3 }))
      .toHaveText(["This round", "Next round"]);
    // Ordinary spaces, never a no-break one (#598).
    expect(await rowsOf(round(own, "This round").locator("dl"))).toEqual([
      ["Closes", "Saturday, November 21, 11:59 PM"],
      ["Pickup", "Sunday, November 22, 8:30 AM"],
    ]);
    expect(await rowsOf(round(own, "Next round").locator("dl"))).toEqual([
      ["Opens", "Saturday, November 21, 11:59 PM"],
      ["Pickup", "Sunday, December 6, 8:30 AM"],
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
