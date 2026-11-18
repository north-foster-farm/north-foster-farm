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

// The rounds as lib/membership.mjs's roundsNow gives them: the member's
// group with a next round, the hosted one without.
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

      // The member's own group: its rounds, no host's part.
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
      await expect(page.getByRole("region", { name: "Second Gym" }))
        .toBeVisible();
      await expect(hosted.getByRole("heading", { level: 3 })).toHaveText(
        ["Pickups", "Invite members", "Members (1)"]
      );
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

  // #602: each round is two lines, as James sketched them: the pickup's
  // date in bold, a dot and its window, then the pill at the start of
  // a smaller line that says when the round closes or opens. Two rounds
  // sit side by side from md up and stack on a phone, and only the open
  // one has the order button.
  test("sees each round as two lines, the pill leading the second",
    async ({ page, context, baseURL }) => {
      await signIn(page, context, baseURL);
      await page.route("**/api/membership/qr**", (route) => route.fulfill({
        contentType: "image/svg+xml", body: SVG,
      }));
      await page.goto("/account/#membership");

      const blocks = page.locator("#mem-groups [data-mem-group]");
      const own = blocks.nth(0);
      const hosted = blocks.nth(1);
      const lines = (block) => block.locator("[data-mem-round]").evaluateAll(
        (cols) => cols.map((col) => [
          col.dataset.memRound,
          col.querySelector(".account-round-when").textContent
            .replace(/\s+/g, " ").trim(),
          col.querySelector(".account-round-status").textContent
            .replace(/\s+/g, " ").trim(),
        ])
      );

      // The group's name, then its address on one line without the
      // name again, then Pickups as a heading under it.
      await expect(own.getByRole("heading", { level: 2 }))
        .toHaveText("The Village Family Fitness");
      await expect(own.locator("[data-mem='address']"))
        .toHaveText("Canned Gym, 1 Main St, Foster, RI 02825");
      await expect(own.getByRole("heading", { level: 3, name: "Pickups" }))
        .toBeVisible();

      // Ordinary spaces, never a no-break one (#598).
      expect(await lines(own)).toEqual([
        ["open", "Sunday, Nov 22 · 8:30 – 9:00 AM",
          "Open Closes at 11:59 PM on Sat, Nov 21"],
        ["next", "Sunday, Dec 6 · 8:30 – 9:00 AM",
          "Next Opens on Sun, Nov 22"],
      ]);
      // No next round: one round, and nothing of the other two.
      expect(await lines(hosted)).toEqual([
        ["open", "Sunday, Nov 22 · 8:30 – 9:00 AM",
          "Open Closes at 11:59 PM on Sat, Nov 21"],
      ]);

      // Gone (#602): the Rounds row and #597's subheadings.
      await expect(own).not.toContainText("Every 2 weeks");
      await expect(own).not.toContainText("This round");

      for (const width of [1280, 768, 390, 320]) {
        await page.setViewportSize({ width, height: 800 });

        const m = await own.locator("[data-mem-round]").evaluateAll(
          (cols) => cols.map((col) => {
            const box = (el) => el.getBoundingClientRect();
            const [date, window] = col.querySelectorAll(
              ".account-round-when > .text-nowrap"
            );
            const status = col.querySelector(".account-round-status");
            const pill = status.querySelector(".account-round-pill");

            return {
              left: box(col).left, top: box(col).top,
              // Whole: one box each, however the line wraps.
              date: date.getClientRects().length,
              window: window.getClientRects().length,
              // The pill starts the second line, at the column's left.
              pillAtStart: Math.abs(box(pill).left - box(status).left) < 1
                && box(pill).top - box(status).top < 8,
              inside: box(status).right <= box(col).right + 0.5,
            };
          })
        );

        for (const round of m) {
          expect(round.date, `the date whole at ${width}`).toBe(1);
          expect(round.window, `the window whole at ${width}`).toBe(1);
          expect(round.pillAtStart, `the pill first at ${width}`).toBe(true);
          expect(round.inside, `no overflow at ${width}`).toBe(true);
        }
        if (width >= 768) {
          expect(m[1].top, `side by side at ${width}`).toBe(m[0].top);
          expect(m[1].left).toBeGreaterThan(m[0].left);
        } else {
          expect(m[1].left, `stacked at ${width}`).toBe(m[0].left);
          expect(m[1].top).toBeGreaterThan(m[0].top);
        }
      }

      // The order button: on the open round alone, to the order page,
      // where the account's group brings its pickup and prices.
      await expect(own.getByRole("link", { name: "Order now" }))
        .toHaveCount(1);
      await expect(own.locator("[data-mem-round='next']")
        .getByRole("link")).toHaveCount(0);
      await own.getByRole("link", { name: "Order now" }).click();
      await expect(page).toHaveURL(/\/order\/$/);
    });

  // #600: between a round's close and its pickup, that pickup stays on
  // the tab, first, with its own pill, and takes no orders.
  test("sees a closed round's pickup until it has happened", async ({
    page, context, baseURL,
  }) => {
    const LATER = "2026-12-06T04:59:00.000Z";

    await signIn(page, context, baseURL);
    await page.route("**/api/membership", (route) => route.fulfill({
      json: {
        ...VIEW,
        member: {
          ...VIEW.member,
          rounds: {
            ...ROUNDS,
            closed: { date: "2026-11-22", closedAt: CLOSES },
            current: { date: "2026-12-06", closesAt: LATER },
            next: { date: "2026-12-20", opensAt: LATER },
          },
        },
      },
    }));
    await page.route("**/api/membership/qr**", (route) => route.fulfill({
      contentType: "image/svg+xml", body: SVG,
    }));
    await page.goto("/account/#membership");

    const own = page.locator("#mem-groups [data-mem-group]").nth(0);
    const rounds = own.locator("[data-mem-round]");

    await expect(rounds).toHaveCount(3);
    await expect(rounds.nth(0).locator(".account-round-when"))
      .toHaveText("Sunday, Nov 22 · 8:30 – 9:00 AM");
    await expect(rounds.nth(0).locator(".account-round-status"))
      .toHaveText("Closed Pickup is Sunday, Nov 22");
    await expect(rounds.nth(0).getByRole("link")).toHaveCount(0);
    await expect(rounds.nth(1).locator(".account-round-status"))
      .toHaveText("Open Closes at 11:59 PM on Sat, Dec 5");
    await expect(rounds.nth(1).getByRole("link", { name: "Order now" }))
      .toBeVisible();
    await expect(rounds.nth(2).locator(".account-round-status"))
      .toHaveText("Next Opens on Sun, Dec 6");
  });

  // A group with no rounds yet shows its name and address alone: no
  // Pickups heading and no rounds (#602).
  test("sees no Pickups for a group with no rounds", async ({
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
    await expect(own.locator("[data-mem='address']"))
      .toContainText(PLACE.street);
    await expect(own.getByRole("heading", { name: "Pickups" }))
      .toHaveCount(0);
    await expect(own.locator("[data-mem-round]")).toHaveCount(0);
  });

  // #602: the member's own sections sit in their group, each with the
  // page's gap above its heading, and the code is a QR code that is
  // coming soon: no code as text, no key tag, no download.
  test("sees the Membership QR code as coming soon", async ({
    page, context, baseURL,
  }) => {
    await signIn(page, context, baseURL);
    await page.route("**/api/membership", (route) => route.fulfill({
      json: {
        ...VIEW,
        member: { ...VIEW.member, code: { id: "NFM-7K4T9WXR" } },
      },
    }));
    await page.route("**/api/membership/**", (route) => route.fulfill({
      contentType: "image/svg+xml", body: SVG,
    }));
    await page.goto("/account/#membership");

    const own = page.locator("#mem-groups [data-mem-group]").nth(0);
    const code = own.locator("[data-mem-code]");

    await expect(code.getByRole("heading", { level: 3 }))
      .toHaveText("Membership QR code");
    await expect(code.locator("p").first()).toHaveText(
      "Coming soon: scan your code when you make a purchase in person "
      + "(like at a farmers market), and your membership benefits will "
      + "apply automatically. In the meantime, let us know you are a "
      + "member at checkout, and we'll look up your membership by name "
      + "or email."
    );
    await expect(code.locator("p strong")).toHaveText(
      "In the meantime, let us know you are a member at checkout, and "
      + "we'll look up your membership by name or email."
    );
    await expect(code.getByRole("img", { name: /not in use yet/ }))
      .toBeVisible();
    await expect(code.locator(".account-member-code-badge"))
      .toHaveText("Coming soon");
    await expect(page.locator("#acct-membership")).not.toContainText("NFM-");
    await expect(code.getByRole("link")).toHaveCount(0);
    await expect(code.getByRole("button")).toHaveCount(0);

    // The veil covers the code, and the badge sits in its middle.
    const m = await code.locator(".account-member-code-soon").evaluate(
      (box) => {
        const r = (el) => el.getBoundingClientRect();
        const img = box.querySelector("img");
        const badge = box.querySelector(".account-member-code-badge");
        const veil = getComputedStyle(box, "::after");

        return {
          covers: Math.abs(r(box).width - r(img).width) < 1
            && Math.abs(r(box).height - r(img).height) < 1,
          veil: veil.backgroundColor,
          dx: (r(badge).left + r(badge).right) / 2
            - (r(img).left + r(img).right) / 2,
          dy: (r(badge).top + r(badge).bottom) / 2
            - (r(img).top + r(img).bottom) / 2,
        };
      }
    );

    expect(m.covers).toBe(true);
    expect(m.veil).toMatch(/^rgba\(255, 255, 255, 0\.\d+\)$/);
    expect(Math.abs(m.dx)).toBeLessThan(1);
    expect(Math.abs(m.dy)).toBeLessThan(1);

    // Every section heading has the page's gap above it (#579), the
    // member's own two as much as the group's.
    const gaps = await own.evaluate((group) => {
      const gap = parseFloat(getComputedStyle(group)
        .getPropertyValue("--account-gap")) * 16;

      return Array.from(group.querySelectorAll("section.account-group"))
        .filter((s) => s.offsetParent)
        .map((s) => {
          // The block before it that shows: the host's part is hidden
          // for a member.
          let before = s.previousElementSibling;

          while (!before.offsetParent) before = before.previousElementSibling;

          const top = s.querySelector("h3").getBoundingClientRect().top;

          return Math.round(top - before.getBoundingClientRect().bottom
            - gap);
        });
    });

    expect(gaps).toEqual([0, 0, 0]);
    await expect(own.locator("[data-mem-leave]"))
      .toContainText("Leave the group");
  });
});
