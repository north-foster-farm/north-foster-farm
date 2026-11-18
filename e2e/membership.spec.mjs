// The Membership tab for a member of one group who hosts another
// (#495, QA item 4; James, 6458200999), and what the tab says and
// links to since its rebuild (#602, #600). Each #602 and #600 check
// proves a row of the test agent's criteria table; the layout is
// measured in membership-layout.spec.mjs. The account's endpoints are
// canned (support/membership.mjs), so this runs on a local build, and
// nothing is saved anywhere.

import { expect, test } from "./support/order.mjs";
import {
  CLOSED_ROUNDS, HOSTED_GROUP, MEMBER_GROUP, SVG, VIEW, groups, signIn,
} from "./support/membership.mjs";

// U+00A0 and U+202F (#598).
const NO_BREAK = new RegExp(`[${String.fromCharCode(0xa0, 0x202f)}]`);

// Each round's two lines as a reader sees them, spaces collapsed.
const roundLines = (block) => block.locator("[data-mem-round]").evaluateAll(
  (cols) => cols.map((col) => Array.from(col.querySelectorAll("p"),
    (p) => p.textContent.replace(/\s+/g, " ").trim()))
);

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

      const { blocks, own, hosted } = groups(page);

      await expect(blocks).toHaveCount(2);

      // The member's own group: no host's part.
      await expect(own.locator("[data-mem='name']")).toHaveText(MEMBER_GROUP);
      await expect(own.locator("[data-mem-host]")).toBeHidden();
      await expect(page.locator("[data-mem-leave]"))
        .toContainText("Leave the group");

      // The hosted group: its QR code and members, every request
      // naming it.
      await expect(hosted.locator("[data-mem='name']"))
        .toHaveText(HOSTED_GROUP);
      await expect(hosted.locator("[data-mem-host]")).toBeVisible();
      await expect(page.getByRole("region", { name: HOSTED_GROUP }))
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
});

test.describe("the rebuilt Membership tab (#602)", () => {
  test.beforeEach(async ({ page, context, baseURL }) => {
    await signIn(page, context, baseURL);
  });

  // Criteria 3, 4 and 5: the group's name over its sections, which are
  // headings under it, and its address without the name again.
  test("lists the group's sections in order", async ({ page }) => {
    await page.goto("/account/#membership");

    const { own, hosted } = groups(page);

    await expect(own.getByRole("heading", { level: 2 }))
      .toHaveText(MEMBER_GROUP);
    await expect(own.getByRole("heading", { level: 3 })).toHaveText(
      ["Pickups", "Membership QR code", "Leave the group"]
    );
    await expect(hosted.getByRole("heading", { level: 2 }))
      .toHaveText(HOSTED_GROUP);
    await expect(hosted.getByRole("heading", { level: 3 })).toHaveText(
      ["Pickups", "Invite members", /^Members\b/]
    );

    // The place is named as the group, so the address leaves it out.
    const address = own.locator("[data-mem='address']");

    await expect(address).toBeVisible();
    await expect(address).toContainText("1 Main St");
    await expect(address).toContainText("RI 02825");
    await expect(address).not.toContainText(MEMBER_GROUP);
  });

  // Criteria 6, 11 and 12: James's sketch, the pill first in line 2.
  test("shows each round as two lines", async ({ page }) => {
    await page.goto("/account/#membership");

    const { own, hosted } = groups(page);

    expect(await roundLines(own)).toEqual([
      ["Sunday, Nov 22 · 8:30 – 9:00 AM",
        "Open Closes at 11:59 PM on Sat, Nov 21"],
      ["Sunday, Dec 6 · 8:30 – 9:00 AM", "Next Opens on Sun, Nov 22"],
    ]);
    // A group with no next round has the open one alone.
    expect(await roundLines(hosted)).toEqual([
      ["Sunday, Nov 22 · 8:30 – 9:00 AM",
        "Open Closes at 11:59 PM on Sat, Nov 21"],
    ]);
  });

  // Criteria 17 and 18.
  test("puts the order button on the open round alone", async ({ page }) => {
    await page.goto("/account/#membership");

    const { own } = groups(page);
    const order = own.getByRole("link", { name: "Order now" });

    await expect(order).toHaveCount(1);
    await expect(order).toBeVisible();
    await expect(own.locator("[data-mem-round='open']")
      .getByRole("link", { name: "Order now" })).toHaveCount(1);
    for (const role of ["link", "button"]) {
      await expect(own.locator("[data-mem-round='next']").getByRole(role))
        .toHaveCount(0);
    }
  });

  // Criterion 19: the order page, with the account's own group asked
  // for (the page then brings its pickup and prices, as the group's
  // link does). The answer is canned as a miss: what /api/group
  // gives is test/group-membership.test.mjs's to check.
  test("takes a member to the order page with the group applied", async ({
    page,
  }) => {
    const asked = [];

    await page.route("**/api/group", (route) => {
      if (route.request().method() === "POST") {
        asked.push(route.request().postDataJSON());
      }

      return route.fulfill({ status: 404,
        json: { ok: false, message: "That code isn't valid." } });
    });
    await page.goto("/account/#membership");

    const { own } = groups(page);

    await own.getByRole("link", { name: "Order now" }).click();
    await expect(page).toHaveURL(/\/order\/(\?[^#]*)?(#.*)?$/);
    await expect.poll(() => asked.length).toBeGreaterThan(0);
    // The account's group, or the group's own code: either applies it.
    expect(asked.some((body) => !body.code
      || /^[A-Z0-9-]{6,}$/i.test(body.code))).toBe(true);
  });

  // Criteria 20, 21 and 22.
  test("drops what direction C took out", async ({ page }) => {
    await page.goto("/account/#membership");

    const tab = page.locator("#acct-membership");
    const { own } = groups(page);

    await expect(own.locator("[data-mem-round]").first()).toBeVisible();
    await expect(tab).not.toContainText(/every (\d+ )?weeks?/i);
    await expect(tab).not.toContainText(/runs every/i);
    await expect(tab).not.toContainText(/(This|Next) round/);
    await expect(tab).not.toContainText(/\bRounds\b/);
    // No label column.
    await expect(own.locator("dt:visible")).toHaveCount(0);
  });

  // Criteria 23, 24 and 26 to 29: the member's own code, coming soon.
  test("shows the Membership QR code as coming soon", async ({ page }) => {
    await page.goto("/account/#membership");

    const { own } = groups(page);
    const code = own.getByRole("region", { name: "Membership QR code" });
    const first = "Coming soon: scan your code when you make a purchase in "
      + "person (like at a farmers market), and your membership benefits "
      + "will apply automatically.";
    const second = "In the meantime, let us know you are a member at "
      + "checkout, and we'll look up your membership by name or email.";

    await expect(code).toBeVisible();
    await expect(code.locator("p", { hasText: "Coming soon: scan" }))
      .toHaveText(`${first} ${second}`);
    // Bold, and nothing else is: the build may split the bold run
    // where it keeps the last two words together (build:orphans).
    expect((await code.locator("strong").allTextContents()).join("")
      .replace(/\s+/g, " ").trim()).toBe(second);

    const img = code.getByRole("img");

    await expect(img).toHaveCount(1);
    await expect(img).toBeVisible();
    await expect(img).toHaveAccessibleName(/\bnot\b.*\byet\b/i);
    await expect(code.getByText("Coming soon", { exact: true }))
      .toBeVisible();

    // No code as text, no line about reading it aloud, no key tag and
    // no download.
    const tab = page.locator("#acct-membership");

    await expect(tab).not.toContainText("NFM-");
    await expect(tab).not.toContainText(/letters and numbers/i);
    await expect(code.getByRole("link")).toHaveCount(0);
    await expect(code.getByRole("button")).toHaveCount(0);
    await expect(own.getByRole("link", { name: /key tag/i })).toHaveCount(0);
    await expect(own.getByRole("button", { name: /key tag/i }))
      .toHaveCount(0);
    await expect(own.getByRole("link", { name: /download/i })).toHaveCount(0);
  });

  // Criterion 32, with every kind of round on the tab.
  test("has no no-break space anywhere", async ({ page }) => {
    await page.route("**/api/membership", (route) => route.fulfill({
      json: { ...VIEW, member: { ...VIEW.member, rounds: CLOSED_ROUNDS } },
    }));
    await page.goto("/account/#membership");

    const { own } = groups(page);

    await expect(own.locator("[data-mem-round]")).toHaveCount(3);
    expect(await page.locator("#acct-membership").textContent())
      .not.toMatch(NO_BREAK);
  });
});

const openClosed = async (page, context, baseURL) => {
  await signIn(page, context, baseURL, {
    view: { ...VIEW, member: { ...VIEW.member, rounds: CLOSED_ROUNDS } },
  });
  await page.goto("/account/#membership");

  const { own } = groups(page);

  await expect(own.locator("[data-mem-round]")).toHaveCount(3);

  return own;
};

// #602, criterion 43 (James's review, 2026-11-18): "The closed line
// should actually say 'Next pickup is Sunday, Nov 22'", the pickup's
// own date, with the pill "Closed".
test("writes the closed round's line as Next pickup is its date", async ({
  page, context, baseURL,
}) => {
  const own = await openClosed(page, context, baseURL);
  const [closed] = await roundLines(own);

  expect(closed[1]).toBe("Closed Next pickup is Sunday, Nov 22");
  await expect(own.locator("[data-mem-round]").first()
    .locator(".account-round-pill")).toHaveText("Closed");
});

// #600, criterion 42: between a round's close and its pickup, that
// pickup stays on the tab, first, with its own pill, and takes no
// orders. Its sentence is criterion 43's.
test("keeps the closed pickup first, until it has happened", async ({
  page, context, baseURL,
}) => {
  const own = await openClosed(page, context, baseURL);
  const rounds = own.locator("[data-mem-round]");
  const lines = await roundLines(own);

  expect(lines[0][0]).toBe("Sunday, Nov 22 · 8:30 – 9:00 AM");
  expect(lines[0][1]).toMatch(/^Closed /);
  expect(lines.slice(1)).toEqual([
    ["Sunday, Dec 6 · 8:30 – 9:00 AM",
      "Open Closes at 11:59 PM on Sat, Dec 5"],
    ["Sunday, Dec 20 · 8:30 – 9:00 AM", "Next Opens on Sun, Dec 6"],
  ]);
  for (const role of ["link", "button"]) {
    await expect(rounds.nth(0).getByRole(role)).toHaveCount(0);
  }
  await expect(rounds.nth(1).getByRole("link", { name: "Order now" }))
    .toBeVisible();
  // Where: the group's address, above its rounds.
  await expect(own.locator("[data-mem='address']")).toContainText("1 Main St");
});
