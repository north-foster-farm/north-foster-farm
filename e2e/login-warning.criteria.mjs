// Criteria tests for #756 (Sign-in page: show the dead-link warning
// as the block quote banner), its two (test) boxes, one test each,
// named for it. Held out of every run by its name until the change
// lands: renamed to login-warning.spec.mjs, it runs, in the desktop
// and phone projects. desktop measures at 390 and 1440 px; phone at
// its own width (390 px).
//
// The model is the order page's delivery cutoff notice in its warning
// state: /api/dates answered as e2e/countdown-date.spec.mjs answers
// it, `now` 5 hours 50 minutes before the cutoff, so the countdown
// shows its "soon" (yellow) banner. No order is placed.
//
// The seam, what the tests rely on:
// - the sign-in page's notice for a link that failed is
//   `[data-login-notice]` on /login/?error=<reason>, as on next
//   (303ce018), the reasons those login/main.js ERRORS names;
// - the cutoff notice is the order page's `[data-countdown]`;
// - "the same banner styling" is the computed border on each side
//   (width, style, color), each corner's radius, background color and
//   padding of the banner's box, and the color, size and weight of its
//   text (measured on the element that holds the first of its text);
// - "the old boxed style" is Bootstrap's alert (`.alert`), the class
//   the notice carries on next. The confirm card for a change of email
//   address (partials/email-confirm.html, red, shared with the account
//   page) is not one of the sign-in page's warnings and is left out.

import { readFileSync } from "node:fs";

import { dates } from "./support/canned.mjs";
import { OrderPage, expect, test } from "./support/order.mjs";
import { deliveryDates } from "../assets/scripts/order/lib/dates.mjs";

const TERMS = JSON.parse(readFileSync(
  new URL("../data/delivery.json", import.meta.url), "utf8",
));

// Wednesday 18 November 2026, 6:09:30 AM: 5 h 50 m before the cutoff.
const NOW = "2026-11-18T11:09:30.000Z";
const PHONE_HEIGHT = 664;
const DESKTOP_HEIGHT = 900;

// #756's warning, word for word (login/main.js ERRORS.unknown).
const USED = "That sign-in link was already used or isn't valid. Ask for "
  + "a new one below.";
// Every other reason the page explains (login/main.js ERRORS).
const OTHER_REASONS = [
  "expired", "invalid", "change-expired", "change-taken", "change-failed",
];

const widthsFor = (project) => (project === "desktop" ? [390, 1440] : [null]);
const label = (w) => (w ? `${w} px` : "the phone's width");

const atWidth = async (page, width) => {
  if (width) {
    await page.setViewportSize({
      width, height: width > 700 ? DESKTOP_HEIGHT : PHONE_HEIGHT,
    });
  }
};

const pinned = (page) => page.route("**/api/dates", (route) =>
  route.fulfill({
    json: {
      ...dates(), now: NOW, delivery: deliveryDates(new Date(NOW), TERMS),
    },
  }));

// The banner's box and its text, as computed.
const bannerStyle = (el) => {
  const s = getComputedStyle(el);
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT,
    { acceptNode: (n) => (n.textContent.trim()
      ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP) });
  const first = walker.nextNode();
  const t = getComputedStyle(first ? first.parentElement : el);
  const sides = ["Top", "Right", "Bottom", "Left"];
  const out = {};

  for (const side of sides) {
    out[`border${side}Width`] = s[`border${side}Width`];
    out[`border${side}Style`] = s[`border${side}Style`];
    out[`border${side}Color`] = s[`border${side}Width`] === "0px"
      ? "none" : s[`border${side}Color`];
    out[`padding${side}`] = s[`padding${side}`];
  }
  for (const corner of ["TopLeft", "TopRight", "BottomLeft", "BottomRight"]) {
    out[`radius${corner}`] = s[`border${corner}Radius`];
  }
  out.backgroundColor = s.backgroundColor;
  out.textColor = t.color;
  out.fontSize = t.fontSize;
  out.fontWeight = t.fontWeight;

  return out;
};

// The cutoff notice's warning banner, measured at the page's width.
const cutoffBanner = async (page) => {
  const order = new OrderPage(page);
  const countdown = page.locator("[data-countdown]");

  await pinned(page);
  await order.open({ wings: 5 }, { method: "delivery" });
  await expect(countdown).toBeVisible();
  await expect(countdown, "the countdown in its warning state")
    .toHaveAttribute("data-urgency", "soon");

  return countdown.evaluate(bannerStyle);
};

// The sign-in page's notice for `reason`, shown and measured.
const loginNotice = async (page, reason) => {
  await page.goto(`/login/?error=${reason}`);

  const notice = page.locator("[data-login-notice]");

  await expect(notice, `the notice for ${reason}`).toBeVisible();

  return {
    notice,
    style: await notice.evaluate(bannerStyle),
    boxed: await notice.evaluate((el) => !!el.closest(".alert")
      || !!el.querySelector(".alert")),
  };
};

test.describe("sign-in page warnings as the block quote banner (#756)", () => {
  test("The sign-in page's used or invalid link warning uses the same " +
    "block quote warning banner component and styling as the delivery " +
    "cutoff notice on the order page, on phone and desktop", async ({
    page,
  }, testInfo) => {
    for (const width of widthsFor(testInfo.project.name)) {
      const where = label(width);

      await atWidth(page, width);

      const model = await cutoffBanner(page);
      const got = await loginNotice(page, "unknown");

      await expect(got.notice, `${where}: the wording`).toHaveText(USED);
      expect(got.boxed, `${where}: not in Bootstrap's alert box`)
        .toBe(false);
      expect(got.style, `${where}: styled as the cutoff banner`)
        .toEqual(model);
    }
  });

  test("Any other notice on the sign-in page that uses the old boxed " +
    "style gets the same change, so the page has one warning style",
  async ({ page }, testInfo) => {
    const off = [];

    for (const width of widthsFor(testInfo.project.name)) {
      const where = label(width);

      await atWidth(page, width);

      const model = await cutoffBanner(page);

      for (const reason of OTHER_REASONS) {
        const got = await loginNotice(page, reason);

        await expect(got.notice, `${where}, ${reason}: has its words`)
          .not.toHaveText("");
        if (got.boxed) off.push(`${where}, ${reason}: in an alert box`);
        try {
          expect(got.style).toEqual(model);
        } catch {
          off.push(`${where}, ${reason}: not styled as the cutoff banner`);
        }
      }
    }

    expect(off, "sign-in notices in the old boxed style").toEqual([]);
  });
});
