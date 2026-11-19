// The order page's "Contact information" heading (#666), measured in
// the browser. Criteria tests, written by a test agent from the
// issue's "Done when" list before the fix; one test per box, each
// named for it. The boxes these do not cover are recorded checks for
// the coordinator (the shadow, the screenshots, production), listed
// in the lane's report.
//
// desktop measures every width the issue names; phone (Chromium) and
// iphone (WebKit) measure their own width and 375 px. Each width is
// measured signed out and signed in: James saw the fault signed in,
// where the "Have an account?" line is gone. Canned, so nothing is
// saved.
//
// Held out of every project until the fix lands: playwright.config.mjs
// lists this file in `held`; deleting that line turns it on.

import { expect, OrderPage, test } from "./support/order.mjs";
import { CUSTOMER } from "./support/canned.mjs";
import { signIn } from "./support/membership.mjs";

const NAME = "Contact information";
// The section before it, whose heading it must sit like.
const BEFORE = "Pickup or delivery";
const WIDTHS = [375, 390, 768, 992, 1440];

// The widths each project measures: null is the project's own.
const widthsFor = (project) => (project === "desktop"
  ? WIDTHS : [null, 375]);
const label = (w) => (w ? `${w} px` : "its own width");

const open = async (page, context, baseURL, width, signedIn) => {
  if (width) await page.setViewportSize({ width, height: 900 });
  if (signedIn) {
    await signIn(page, context, baseURL, {
      me: { signedIn: true, customer: CUSTOMER },
    });
  }
  await new OrderPage(page).open();
  if (signedIn) {
    await expect(page.locator("#customer-first-name"))
      .toHaveValue(CUSTOMER.firstName);
    await expect(page.locator("[data-signin-prompt]")).toBeHidden();
  }
};

// Each section heading's place: the left edge of its words, and how
// far its top sits below the top of its section. The First name
// label's words, for the left edge they must share.
const measure = (page) => page.evaluate(([name, before]) => {
  const sectionOf = (title) => [...document.querySelectorAll("fieldset")]
    .find((f) => {
      const legend = f.querySelector(":scope > legend");

      return legend && legend.textContent.trim() === title;
    });
  const wordsLeft = (el) => {
    const range = document.createRange();

    range.selectNodeContents(el);

    return Math.min(...[...range.getClientRects()]
      .filter((r) => r.width > 0).map((r) => r.left));
  };
  const heading = (title) => {
    const section = sectionOf(title);
    const legend = section.querySelector(":scope > legend");

    return {
      left: wordsLeft(legend),
      below: legend.getBoundingClientRect().top
        - section.getBoundingClientRect().top,
    };
  };

  return {
    contact: heading(name),
    before: heading(before),
    firstName: wordsLeft(
      document.querySelector("label[for='customer-first-name']"),
    ),
  };
}, [NAME, BEFORE]);

test.describe(`the ${NAME} heading (#666)`, () => {
  for (const signedIn of [false, true]) {
    const state = signedIn ? "signed in" : "signed out";

    for (const width of [...WIDTHS, null]) {
      // Done when 1 (the measurable part; the screenshots at 375 and
      // 1440 px are the coordinator's recorded check).
      test(`lines up with First name and has the space above of the ${
        BEFORE} heading at ${label(width)}, ${state}`, async ({
        page, context, baseURL,
      }, info) => {
        test.skip(!widthsFor(info.project.name).includes(width),
          "another project's width");
        await open(page, context, baseURL, width, signedIn);

        const m = await measure(page);

        expect(Math.abs(m.contact.left - m.firstName),
          `its left edge (${m.contact.left}) against First name's (${
            m.firstName})`).toBeLessThanOrEqual(1);
        expect(Math.abs(m.contact.below - m.before.below),
          `the space above it (${m.contact.below}) against the ${
            BEFORE} heading's (${m.before.below})`)
          .toBeLessThanOrEqual(1);
      });
    }
  }

  // Done when 3.
  test("still names its fieldset and still takes focus", async ({
    page, context, baseURL,
  }) => {
    await open(page, context, baseURL, null, false);

    const group = page.getByRole("group", { name: NAME, exact: true });

    await expect(group).toHaveCount(1);
    await expect(group).toHaveJSProperty("tagName", "FIELDSET");
    await expect(group.locator("#customer-first-name")).toHaveCount(1);

    // The name comes from the legend, which is the heading.
    const heading = group.locator(":scope > legend");

    await expect(heading).toHaveCount(1);
    await expect(heading).toHaveText(NAME);
    await expect(heading).toHaveAttribute("tabindex", "-1");

    // Focus sent to it, as the page sends it to a section's legend.
    await heading.evaluate((el) => el.focus());
    await expect(heading).toBeFocused();
  });
});
