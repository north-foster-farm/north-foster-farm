// The order page's Contact information card (#704), measured in the
// browser. Criteria tests, written by a test agent from the issue's
// "Done when" list and James's mockup before the change; one test per
// box, each named for it. Box 4 (James signs off on staging) and the
// screenshots boxes 1 and 2 name are the coordinator's recorded checks.
//
// #704 undoes #666's card (2026-11-19), where the fieldset was the
// frame and the heading and sign-in line sat inside it. In the mockup
// the heading "Contact information" and "Have an account? Don't forget
// to sign in." sit above the card, as "Place your order" sits above
// its pane, and the card frames only the fields. The card is the
// shadowed frame that holds the First name field, whichever element
// draws it.
//
// desktop measures every width the issue names; phone (Chromium) and
// iphone (WebKit) measure their own. Box 1 is measured signed out and
// signed in, where the sign-in line is hidden (#521). Canned, so
// nothing is saved.
//
// Held out of every run by its name: rename it to
// contact-card.spec.mjs to turn it on.

import { expect, OrderPage, test } from "./support/order.mjs";
import { CUSTOMER } from "./support/canned.mjs";
import { signIn } from "./support/membership.mjs";

const NAME = "Contact information";
const WIDTHS = [390, 768, 1440];

// The widths each project measures: null is the project's own.
const widthsFor = (project) => (project === "desktop" ? WIDTHS : [null]);
const label = (w) => (w ? `${w} px` : "its own width");

const open = async (page, context, baseURL, width, signedIn) => {
  if (width) await page.setViewportSize({ width, height: 900 });
  if (signedIn) {
    await signIn(page, context, baseURL, {
      me: { signedIn: true, customer: CUSTOMER },
    });
  }
  await new OrderPage(page).open({ eggs: 1 });
  if (signedIn) {
    await expect(page.locator("#customer-first-name"))
      .toHaveValue(CUSTOMER.firstName);
    await expect(page.locator("[data-signin-prompt]")).toBeHidden();

    // The filled-in phone number brings in the "Prefer text or call?"
    // row, which slides as it fades in; measure it at rest.
    const row = page.locator("[data-contact-row]");

    await expect(row).toHaveAttribute("data-shown", "true");
    await expect(row).not.toHaveClass(/is-entering/);
    await row.evaluate((el) => Promise.all(
      el.getAnimations().map((a) => a.finished),
    ));
  } else {
    await expect(page.locator("[data-signin-prompt]")).toBeVisible();
  }
};

// The contact card and the Place your order pane, each with the
// heading above it: the frames, the headings, the sign-in line and
// what the contact card holds.
const measure = (page) => page.evaluate((name) => {
  const frame = (el) => {
    let node = el.parentElement;

    while (node && getComputedStyle(node).boxShadow === "none") {
      node = node.parentElement;
    }

    return node;
  };
  const legendOf = (text) => [...document.querySelectorAll("legend")]
    .find((l) => l.textContent.trim() === text);
  const words = (el) => {
    const range = document.createRange();

    range.selectNodeContents(el);

    const rects = [...range.getClientRects()].filter((r) => r.width > 0);

    return { left: Math.min(...rects.map((r) => r.left)) };
  };
  const box = (el) => {
    const r = el.getBoundingClientRect();

    return { top: r.top, bottom: r.bottom, left: r.left };
  };
  const card = frame(document.getElementById("customer-first-name"));
  const pane = frame(document.getElementById("order-submit"));
  const heading = legendOf(name);
  const placeHeading = legendOf("Place your order");
  const prompt = document.querySelector("[data-signin-prompt]");
  const shown = (el) => el && el.getClientRects().length > 0;
  const fields = [
    "customer-first-name", "customer-last-name", "customer-email",
    "customer-phone",
  ];
  const row = document.querySelector("[data-contact-row]");

  return {
    card: box(card),
    pane: box(pane),
    heading: { ...box(heading), words: words(heading).left },
    placeHeading: {
      ...box(placeHeading), words: words(placeHeading).left,
    },
    prompt: shown(prompt)
      ? { ...box(prompt), words: words(prompt).left } : null,
    headingInCard: card.contains(heading),
    promptInCard: card.contains(prompt),
    fieldsInCard: fields.every((id) => {
      const field = document.getElementById(id);
      const lbl = document.querySelector(`label[for='${id}']`);

      return card.contains(field) && card.contains(lbl);
    }),
    rowInCard: !shown(row) || card.contains(row),
  };
}, NAME);

test.describe(`the ${NAME} card (#704)`, () => {
  for (const signedIn of [false, true]) {
    const state = signedIn ? "signed in" : "signed out";

    for (const width of [...WIDTHS, null]) {
      // Done when 1 (the measurable part; the screenshots are the
      // coordinator's recorded check).
      test("the heading and the sign-in line sit above the card, and " +
        `the card frames only the fields, at ${label(width)}, ${state}`,
      async ({ page, context, baseURL }, info) => {
        test.skip(!widthsFor(info.project.name).includes(width),
          "another project's width");
        await open(page, context, baseURL, width, signedIn);

        const m = await measure(page);

        // Only the fields inside the card.
        expect.soft(m.headingInCard, "the heading is inside the card")
          .toBe(false);
        expect.soft(m.promptInCard, "the sign-in line is inside the card")
          .toBe(false);
        expect.soft(m.fieldsInCard,
          "First name, Last name, Email address and Phone, label and " +
          "field, are in the card").toBe(true);
        expect.soft(m.rowInCard, "the Prefer text or call? row is in " +
          "the card").toBe(true);

        // Above it, the heading first.
        expect.soft(m.heading.bottom, `the heading's bottom (${
          m.heading.bottom}) against the card's top (${m.card.top})`)
          .toBeLessThanOrEqual(m.card.top);

        // Placed against its card as "Place your order" is against its
        // pane: its words start as far in from the card's left edge.
        const inset = m.heading.words - m.card.left;
        const placeInset = m.placeHeading.words - m.pane.left;

        expect.soft(Math.abs(inset - placeInset), `the heading's words ${
          inset} px in from the card's left edge, Place your order's ${
          placeInset} px from its pane's`).toBeLessThanOrEqual(1);

        if (m.prompt) {
          expect.soft(m.prompt.top, "the sign-in line starts under the " +
            "heading").toBeGreaterThanOrEqual(m.heading.bottom);
          expect.soft(m.prompt.bottom, `the sign-in line's bottom (${
            m.prompt.bottom}) against the card's top (${m.card.top})`)
            .toBeLessThanOrEqual(m.card.top);
          expect.soft(Math.abs(m.prompt.words - m.heading.words),
            "the sign-in line starts where the heading does")
            .toBeLessThanOrEqual(1);
        } else {
          // Nothing between them, so the heading stands above its card
          // as Place your order stands above its pane.
          const gap = m.card.top - m.heading.bottom;
          const placeGap = m.pane.top - m.placeHeading.bottom;

          expect.soft(Math.abs(gap - placeGap),
            `${gap} px from the heading to the card, ${placeGap} px ` +
            "from Place your order to its pane").toBeLessThanOrEqual(2);
        }
      });
    }
  }

  // Done when 2 (the measurable part; the screenshot is the
  // coordinator's recorded check). The card's border, radius and
  // padding are the Place your order pane's, the card-style area the
  // mockup sets it beside; its shadow and border are the Pickup or
  // delivery cards' (#666 kept that), and the pane's from 1200 px,
  // where the pane's shadow is the lighter one alone.
  for (const width of [...WIDTHS, null]) {
    test("the card matches the other card-style areas on the page " +
      `(border, radius, padding, shadow), at ${label(width)}`, async ({
      page, context, baseURL,
    }, info) => {
      test.skip(!widthsFor(info.project.name).includes(width),
        "another project's width");
      await open(page, context, baseURL, width, false);

      const s = await page.evaluate(() => {
        const frame = (el) => {
          let node = el.parentElement;

          while (node && getComputedStyle(node).boxShadow === "none") {
            node = node.parentElement;
          }

          return node;
        };
        const look = (el) => {
          const c = getComputedStyle(el);

          return {
            border: ["Top", "Right", "Bottom", "Left"].map((side) => [
              c[`border${side}Width`], c[`border${side}Style`],
              c[`border${side}Color`],
            ].join(" ")).join(", "),
            radius: ["TopLeft", "TopRight", "BottomRight", "BottomLeft"]
              .map((corner) => c[`border${corner}Radius`]).join(" "),
            padding: [c.paddingTop, c.paddingRight, c.paddingBottom,
              c.paddingLeft].join(" "),
            shadow: c.boxShadow,
          };
        };

        return {
          width: window.innerWidth,
          card: look(frame(document.getElementById("customer-first-name"))),
          pane: look(frame(document.getElementById("order-submit"))),
          // One at rest: the chosen card wears the green border and bar.
          method: look([...document.querySelectorAll(".order-method")]
            .find((el) => !el.querySelector(":scope > input:checked"))),
        };
      });

      expect.soft(s.card.border, "border, against the pane's")
        .toBe(s.pane.border);
      expect.soft(s.card.border, "border, against Pickup or delivery's")
        .toBe(s.method.border);
      expect.soft(s.card.radius, "radius, against the pane's")
        .toBe(s.pane.radius);
      expect.soft(s.card.radius, "radius, against Pickup or delivery's")
        .toBe(s.method.radius);
      expect.soft(s.card.padding, "padding, against the pane's")
        .toBe(s.pane.padding);
      expect.soft(s.card.shadow, "shadow, against Pickup or delivery's")
        .toBe(s.method.shadow);
      if (s.width >= 1200) {
        expect.soft(s.card.shadow, "shadow, against the pane's")
          .toBe(s.pane.shadow);
      }
    });
  }

  // Done when 3: what #666 kept. The heading is still the fieldset's
  // legend, so the group is still named by it, and the page's focus on
  // a section's legend still lands on it.
  test("the fieldset still exposes Contact information as its name, " +
    "and focus sent to the heading lands on it", async ({
    page, context, baseURL,
  }) => {
    await open(page, context, baseURL, null, false);

    const group = page.getByRole("group", { name: NAME, exact: true });

    await expect(group).toHaveCount(1);
    await expect(group).toHaveJSProperty("tagName", "FIELDSET");
    await expect(group.locator("#customer-first-name")).toHaveCount(1);

    const heading = group.locator(":scope > legend");

    await expect(heading).toHaveCount(1);
    await expect(heading).toHaveText(NAME);
    await expect(heading).toHaveAttribute("tabindex", "-1");

    await heading.evaluate((el) => el.focus());
    await expect(heading).toBeFocused();
  });
});
