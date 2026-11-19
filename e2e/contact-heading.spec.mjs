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
// "Inset on all sides" (the coordinator, 2026-11-19, on #666): the
// heading sits inside its card, its words starting where First name's
// do, and the space from the card's top edge to its words is the space
// from the last field's bottom edge to the card's bottom edge. The
// bottom is the reference because the card's padding is one value top
// and bottom by construction, and not one on all sides (12 px by 16 px
// on a phone, 16 by 20 at 768). The card is the frame with the shadow
// that holds the First name field, whichever element draws it.
//
// Held out of every project until the fix lands: playwright.config.mjs
// lists this file in `held`; deleting that line turns it on.

import { expect, OrderPage, test } from "./support/order.mjs";
import { CUSTOMER } from "./support/canned.mjs";
import { signIn } from "./support/membership.mjs";

const NAME = "Contact information";
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

    // A wait, added by the implementer (2026-11-19): the filled-in
    // phone number brings in the "Prefer text or call?" row, which
    // slides down a quarter rem as it fades in (order-form.js
    // showContact). Measured mid-slide, as WebKit did in Actions, its
    // radios stand 4 px high. So the row is let come to rest.
    const row = page.locator("[data-contact-row]");

    await expect(row).toHaveAttribute("data-shown", "true");
    await expect(row).not.toHaveClass(/is-entering/);
    await row.evaluate((el) => Promise.all(
      el.getAnimations().map((a) => a.finished),
    ));
  }
};

// The heading's words against the card's edges: where they start
// beside First name's, how far below the card's top edge they begin,
// and how far the last field's bottom edge sits above the card's
// bottom edge.
const measure = (page) => page.evaluate((name) => {
  const words = (el) => {
    const range = document.createRange();

    range.selectNodeContents(el);

    const rects = [...range.getClientRects()].filter((r) => r.width > 0);

    return {
      left: Math.min(...rects.map((r) => r.left)),
      top: Math.min(...rects.map((r) => r.top)),
    };
  };
  const section = [...document.querySelectorAll("fieldset")].find((f) => {
    const legend = f.querySelector(":scope > legend");

    return legend && legend.textContent.trim() === name;
  });
  const field = document.getElementById("customer-first-name");
  let card = field.parentElement;

  while (card && getComputedStyle(card).boxShadow === "none") {
    card = card.parentElement;
  }

  const box = card.getBoundingClientRect();
  const fields = [...card.querySelectorAll("input, select, textarea")]
    .filter((el) => el.getClientRects().length
      && getComputedStyle(el).visibility !== "hidden");
  const heading = words(section.querySelector(":scope > legend"));

  return {
    left: heading.left,
    firstName: words(
      document.querySelector("label[for='customer-first-name']"),
    ).left,
    above: heading.top - box.top,
    below: box.bottom - fields.at(-1).getBoundingClientRect().bottom,
  };
}, NAME);

test.describe(`the ${NAME} heading (#666)`, () => {
  for (const signedIn of [false, true]) {
    const state = signedIn ? "signed in" : "signed out";

    for (const width of [...WIDTHS, null]) {
      // Done when 1 (the measurable part; the screenshots at 375 and
      // 1440 px are the coordinator's recorded check).
      test(`sits inside its card, inset on all sides like the fields, at ${
        label(width)}, ${state}`, async ({
        page, context, baseURL,
      }, info) => {
        test.skip(!widthsFor(info.project.name).includes(width),
          "another project's width");
        await open(page, context, baseURL, width, signedIn);

        const m = await measure(page);

        expect.soft(Math.abs(m.left - m.firstName),
          `its left edge (${m.left}) against First name's (${
            m.firstName})`).toBeLessThanOrEqual(1);
        expect.soft(Math.abs(m.above - m.below),
          `the space from the card's top edge to its words (${
            m.above}) against the last field's to the card's bottom (${
            m.below})`).toBeLessThanOrEqual(2);
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
