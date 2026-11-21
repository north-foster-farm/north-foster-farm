// Criteria tests for #718 (Invite links that grant a perk on sign-up),
// section "Staging review changes" (James's staging review of the
// invite page on #733, 2026-11-21), one test per box, each named for
// it. Held out of every run by its name until the change lands:
// renamed to invite-page.spec.mjs, it runs, in the desktop and phone
// projects. desktop measures at 390 and 1440 px; phone at its own
// width (390 px).
//
// The invite API is the site's own, stubbed with page.route as the
// server answers (netlify/functions/invite.mjs): POST /api/invite/check
// 200 { ok, perk: perkView(invite) }, POST /api/invite/request 200
// { ok: true }. No outside service is reached, so nothing is sent.
//
// The seam, what the tests rely on:
// - the page is /invite/?t=<token>, the field is #invite-email, its
//   button #invite-submit (the busy-button partial), and the message
//   after a send is #invite-sent, as on next (303ce018);
// - the footer's signup is the field and busy button in
//   `footer.site-footer [data-farm-list-form]`;
// - "the field and button share one row": their border boxes'
//   vertical centers within 1 px, the button's left edge at or past
//   the field's right edge (an input group overlaps them by the 1 px
//   border);
// - "the same styling" is the computed height, border width and style,
//   each corner's radius, font family, size, weight and line height,
//   and padding of the field and of the button, against the footer's.
//   Colors are left out: the footer's form is drawn for its dark band
//   (_footer.scss), the page's on a light one;
// - "the page's usual section spacing" below the form is the sign-in
//   page's: on /login/, the same kind of form (the field and button in
//   one row, then nothing) on the same section and container. The gap
//   is measured from the bottom of the field and button's row to the
//   top of the footer, on both pages at the same width, within 4 px
//   (an empty error line under the row, 0.25 rem, may sit on either);
// - "in view and focused" after a send: #invite-sent's border box lies
//   inside the viewport, and document.activeElement is #invite-sent or
//   inside it. Before the send the page is scrolled to its bottom, as
//   a phone's keyboard leaves it (James's phone ended at the footer's
//   "Ready to order?" section).

import { perkName, perkParts } from "../assets/scripts/order/lib/perks.mjs";
import { expect, test } from "./support/order.mjs";

const PHONE_HEIGHT = 664;
const DESKTOP_HEIGHT = 900;
const CENTER_TOLERANCE = 1;
const GAP_TOLERANCE = 4;
const TOKEN = "qa-invite-criteria";

// What /api/invite/check sends for an open invite (invite.mjs
// perkView), a friends and family perk with no end.
const PERK = {
  type: "friends", name: perkName("friends"), parts: perkParts("friends"),
  end: null,
};

const widthsFor = (project) => (project === "desktop" ? [390, 1440] : [null]);
const label = (w) => (w ? `${w} px` : "the phone's width");

const atWidth = async (page, width) => {
  if (width) {
    await page.setViewportSize({
      width, height: width > 700 ? DESKTOP_HEIGHT : PHONE_HEIGHT,
    });
  }
};

const stubCheck = (page) => page.route("**/api/invite/check",
  (route) => route.fulfill({ json: { ok: true, perk: PERK } }));

// The invite page, open on an invite that is open, its form showing.
const openInvite = async (page) => {
  await stubCheck(page);
  await page.goto(`/invite/?t=${TOKEN}`);
  await expect(page.locator("#invite-email")).toBeVisible();
};

const footerForm = (page) => page
  .locator("footer.site-footer [data-farm-list-form]");

// The computed styles the boxes compare, and the border box.
const measure = (el) => {
  const s = getComputedStyle(el);
  const r = el.getBoundingClientRect();

  return {
    box: { left: r.left, right: r.right, top: r.top, bottom: r.bottom,
      height: r.height },
    style: {
      height: Math.round(r.height * 2) / 2,
      borderTopWidth: s.borderTopWidth,
      borderBottomWidth: s.borderBottomWidth,
      borderStyle: s.borderTopStyle,
      radiusTopLeft: s.borderTopLeftRadius,
      radiusTopRight: s.borderTopRightRadius,
      radiusBottomLeft: s.borderBottomLeftRadius,
      radiusBottomRight: s.borderBottomRightRadius,
      fontFamily: s.fontFamily,
      fontSize: s.fontSize,
      fontWeight: s.fontWeight,
      lineHeight: s.lineHeight,
      paddingTop: s.paddingTop,
      paddingRight: s.paddingRight,
      paddingBottom: s.paddingBottom,
      paddingLeft: s.paddingLeft,
    },
  };
};

const center = (b) => (b.top + b.bottom) / 2;

// The gap from the bottom of a field and its button's row to the top
// of the footer.
const gapBelow = (field, button) => field.evaluate((el, btn) => {
  const rowBottom = Math.max(el.getBoundingClientRect().bottom,
    btn.getBoundingClientRect().bottom);
  const footer = document.querySelector("footer.site-footer");

  return footer.getBoundingClientRect().top - rowBottom;
}, button);

test.describe("invite page staging review changes (#718)", () => {
  test("The email field and \"Send my link\" sit in one inline form " +
    "that matches the footer newsletter signup (same layout, field and " +
    "button styling, and busy state), on phone and desktop",
  async ({ page }, testInfo) => {
    for (const width of widthsFor(testInfo.project.name)) {
      const where = label(width);

      await atWidth(page, width);
      await openInvite(page);

      const field = page.locator("#invite-email");
      const button = page.locator("#invite-submit");
      const footer = footerForm(page);
      const footField = footer.locator("input[type='email']");
      const footButton = footer.locator("button.busy-button");

      await expect(footField, `${where}: the footer's field`)
        .toHaveCount(1);
      await expect(footButton, `${where}: the footer's button`)
        .toHaveCount(1);

      const f = await field.evaluate(measure);
      const b = await button.evaluate(measure);
      const ff = await footField.evaluate(measure);
      const fb = await footButton.evaluate(measure);

      // One row: the button beside the field, to its right.
      expect(Math.abs(center(f.box) - center(b.box)),
        `${where}: the field's and button's vertical centers`)
        .toBeLessThanOrEqual(CENTER_TOLERANCE);
      expect(b.box.left, `${where}: the button right of the field`)
        .toBeGreaterThanOrEqual(f.box.right - 1.5);

      // Styled as the footer's.
      expect(f.style, `${where}: the field styled as the footer's`)
        .toEqual(ff.style);
      expect(b.style, `${where}: the button styled as the footer's`)
        .toEqual(fb.style);

      // Busy as the footer's: "Sending" while the request runs.
      const footBusy = (await footButton.locator(".busy-button-busy")
        .textContent()).trim();

      expect(footBusy, "the footer's busy word").toBe("Sending");

      let release;
      const held = new Promise((resolve) => {
        release = resolve;
      });

      await page.route("**/api/invite/request", async (route) => {
        await held;
        await route.fulfill({ json: { ok: true } });
      });
      await field.fill("qa-e2e-invite-form@example.com");
      await button.click();
      await expect(button, `${where}: busy`)
        .toHaveAttribute("data-busy", "true");
      await expect(button).toHaveAttribute("aria-busy", "true");
      await expect(button, `${where}: the busy word`)
        .toHaveAccessibleName(footBusy);
      await expect(button.locator(".busy-button-busy")).toHaveText(footBusy);
      await expect(button.locator(".busy-button-busy"))
        .toHaveCSS("opacity", "1");
      release();
      await expect(page.locator("#invite-sent")).toBeVisible();
      await page.unrouteAll({ behavior: "ignoreErrors" });
    }
  });

  test("The \"Welcome to the flock!\" closing paragraph is removed, " +
    "with no leftover gap below the form", async ({ page }, testInfo) => {
    for (const width of widthsFor(testInfo.project.name)) {
      const where = label(width);

      await atWidth(page, width);

      await page.goto("/login/");
      await expect(page.locator("#login-email")).toBeVisible();
      const usual = await gapBelow(page.locator("#login-email"),
        await page.locator("#login-submit").elementHandle());

      await openInvite(page);
      await expect(page.getByText("Welcome to the flock!"),
        `${where}: the closing paragraph`).toHaveCount(0);

      const gap = await gapBelow(page.locator("#invite-email"),
        await page.locator("#invite-submit").elementHandle());

      expect(Math.abs(gap - usual),
        `${where}: the gap below the form (${gap.toFixed(1)} px) against ` +
        `the sign-in page's (${usual.toFixed(1)} px)`)
        .toBeLessThanOrEqual(GAP_TOLERANCE);
      await page.unrouteAll({ behavior: "ignoreErrors" });
    }
  });

  test("After \"Send my link\" succeeds, the page scrolls so the " +
    "\"Check your email\" message is in view and focused", async ({
    page,
  }, testInfo) => {
    if (testInfo.project.name === "desktop") {
      await page.setViewportSize({ width: 390, height: PHONE_HEIGHT });
    }
    await openInvite(page);
    await page.route("**/api/invite/request",
      (route) => route.fulfill({ json: { ok: true } }));

    const field = page.locator("#invite-email");

    await field.fill("qa-e2e-invite-scroll@example.com");
    // Where a phone's keyboard leaves the page: scrolled down, the
    // field still focused.
    await field.evaluate((el) => {
      window.scrollTo(0, document.documentElement.scrollHeight);
      el.focus({ preventScroll: true });
    });
    await page.keyboard.press("Enter");

    const sent = page.locator("#invite-sent");

    await expect(sent).toBeVisible();
    await expect(sent).toContainText("Check your email");
    await expect.poll(() => sent.evaluate((el) => {
      const r = el.getBoundingClientRect();

      return r.top >= 0 && r.left >= 0 && r.bottom <= window.innerHeight
        && r.right <= window.innerWidth;
    }), { message: "the message's box inside the viewport" }).toBe(true);
    await expect.poll(() => sent.evaluate((el) => el
      .contains(document.activeElement)), {
      message: "focus on the message or inside it",
    }).toBe(true);
  });
});
