// Criteria tests for three boxes James added after his staging review
// of 2026-11-21 ("the card order and grouping of text is incorrect for
// group orders"; "the validation on pick-up days is looking pretty
// sloppy, we should have a nice focus ring effect like we do on
// invalid text inputs"; "group orders is missing the outline
// validation altogether"): two at the end of #749's "Done when" (the
// round card's order; Group orders' ring) and one at the end of
// #703's (Pick-up days' ring). One test per box, named for it word for
// word, each run at 390 and at 1440 px. Then #749's two wording boxes
// from James's picks on #761: the status after "Use this date" and
// the message when no round is picked.
//
// Held out of every run by its name (playwright.config.mjs matches
// *.spec.mjs). The change that meets the boxes turns it on with
//
//   git mv e2e/round-card-ring.criteria.mjs \
//     e2e/round-card-ring.spec.mjs
//
// and maps it in e2e/dispatch.json wherever pickup-days.spec.mjs and
// group-orders.spec.mjs are, with e2e/support/vff.mjs.
//
// Every reference is read from the same page, never written out: a
// Pick-up days card (the Foster market, which has a place name) for
// the round card, an invalid text input (the first name, emptied once
// Pay has marked the errors) for the ring, and a pickup card for the
// ring's radius.
//
// The seam, what the tests rely on:
// - a card of either list is an `.order-pickup`, its parts as
//   e2e/pickup-days.spec.mjs names them: the title
//   `.order-pickup-name`, the time `.order-pickup-time`, the place
//   name `.order-pickup-place`, the address `.order-pickup-address`
//   and Copy `.order-pickup-copy`; a round card (tpl-round) has the
//   same parts;
// - Pick-up days' list is `#scheduled-pickups` and Group orders'
//   `#group-pickups`, the element that is marked and ringed;
// - the member, the group's real rounds and Group orders' body come
//   from e2e/support/vff.mjs, as in e2e/group-orders.spec.mjs;
// - Pay with the way chosen and no day or round picked marks the
//   list, as the #703 revision spec's validation test does; a text
//   input emptied and left after that shows its own error
//   (order-form.js's focusout), and its glow is its focused face;
// - "Use this date" puts its round on the form and says so in the
//   page's `[data-lapsed-status]`, as for a lapsed pickup; the
//   round's date there is its `label` as /api/group lists it
//   ("Sunday, December 6");
// - the message for a missing round shows inside Group orders' body.
//
// No order reaches the server: /api/orders is refused here, or canned
// as the lapsed round's 409, so a page that posts without a round
// fails at the ring, not at the server.

import { OrderPage, expect, test } from "./support/order.mjs";
import { FOSTER, cannedScheduled, datesWith } from "./support/scheduled.mjs";
import {
  GROUP_ORDERS, MEMBER, choose, openOrder, pick, rounds, signIn,
} from "./support/vff.mjs";

const SIZES = [
  { width: 390, height: 844 },
  { width: 1440, height: 900 },
];

// Pick-up days with the Foster market alone, whose card shows a place
// name above its address.
const lists = () => datesWith([{ place: FOSTER, days: [3] }]);

// No order reaches the server from these tests.
const noPosts = (page) => page.route("**/api/orders", (route) => (
  route.request().method() === "POST" ? route.abort() : route.fallback()
));

// Waits out every transition on `locator` and inside it.
const still = (locator) => locator.evaluate((el) => Promise.all(
  el.getAnimations({ subtree: true })
    .map((a) => a.finished.catch(() => null))
));

const STYLE = [
  "color", "fontFamily", "fontSize", "fontWeight", "lineHeight",
  "letterSpacing",
];

// A card's parts: each one's box, text and type, null where the card
// lacks it or hides it.
const partsOf = async (card) => {
  await still(card);

  return card.evaluate((el, keys) => {
    const part = (selector) => {
      const node = el.querySelector(selector);

      if (!node || node.closest("[hidden]")) return null;

      const at = node.getBoundingClientRect();
      const cs = getComputedStyle(node);

      return {
        text: node.innerText.replace(/\s+/g, " ").trim(),
        top: at.top, bottom: at.bottom, left: at.left, right: at.right,
        style: Object.fromEntries(keys.map((k) => [k, cs[k]])),
      };
    };

    return {
      name: part(".order-pickup-name"),
      time: part(".order-pickup-time"),
      place: part(".order-pickup-place"),
      address: part(".order-pickup-address"),
      copy: part(".order-pickup-copy"),
    };
  }, STYLE);
};

// Where Copy stands to the address block: beside it (to its right,
// level with its last line) or below it.
const copyAt = (parts) => {
  const { copy, address } = parts;

  if (copy.left >= address.right - 0.5 && copy.top < address.bottom) {
    return { where: "beside", gap: address.bottom - copy.bottom };
  }
  if (copy.top >= address.bottom - 0.5) {
    return { where: "below", gap: copy.top - address.bottom };
  }
  return { where: "over the block", gap: NaN };
};

// The ring an element draws: its border, glow, radius and outline.
const ringOf = async (locator) => {
  await still(locator);

  return locator.evaluate((el) => {
    const s = getComputedStyle(el);
    const sides = ["Top", "Right", "Bottom", "Left"];

    return {
      colors: sides.map((d) => s[`border${d}Color`]),
      widths: sides.map((d) => s[`border${d}Width`]),
      styles: sides.map((d) => s[`border${d}Style`]),
      shadow: s.boxShadow,
      radii: ["TopLeft", "TopRight", "BottomRight", "BottomLeft"]
        .map((c) => s[`border${c}Radius`]),
      outline: s.outlineStyle === "none" ? "0px" : s.outlineWidth,
    };
  });
};

// An invalid text input's ring, read from the page: the first name,
// emptied and left once Pay has put errors on the page, then focused
// for its glow.
const invalidInput = async (page) => {
  const input = page.locator("#customer-first-name");

  await input.fill("");
  await input.blur();
  await expect(input, "the emptied first name is marked")
    .toHaveClass(/\bis-invalid\b/);
  await input.focus();

  return ringOf(input);
};

// The ring on `list`, against an invalid input's and the radius of
// the list's own cards, at the page's current width.
const holdsRing = async (page, list, width) => {
  const at = `at ${width}px`;

  await expect(list, `the list is marked invalid ${at}`)
    .toHaveClass(/\bis-invalid\b/);

  const ring = await ringOf(list);
  const radius = await list.locator(".order-pickup").first()
    .evaluate((el) => getComputedStyle(el).borderTopLeftRadius);
  const input = await invalidInput(page);

  expect(input.shadow, `an invalid input glows when focused ${at}`)
    .not.toBe("none");
  expect(ring.colors, `the list's border color is the input's ${at}`)
    .toEqual(input.colors);
  expect(ring.widths, `the list's border width is the input's ${at}`)
    .toEqual(input.widths);
  expect(ring.styles, `the list's border style is the input's ${at}`)
    .toEqual(input.styles);
  expect(ring.shadow, `the list's glow is the input's ${at}`)
    .toBe(input.shadow);
  expect(ring.radii, `the list's radius is its cards' ${at}`)
    .toEqual([radius, radius, radius, radius]);
  expect(ring.outline, `no outline is left on the list ${at}`)
    .toBe("0px");
};

// Pays with nothing missing but the day or round: the contact, then
// the card, then Pay.
const payWithoutChoice = async (order, email, phone) => {
  await order.contact({ email, phone });
  await order.openCard();
  await order.card();
  await order.submit.click();
};

test.describe("round cards and the lists' ring (#749, #703)", () => {
  test("A round card reads as a Pick-up days card does: the date as " +
    "its title, the time first under it, then the place name and its " +
    "address together as one block in the address style, with Copy " +
    "beside the block", async ({ page, baseURL }) => {
    await signIn(page, baseURL, MEMBER, { lists: lists() });

    const order = await openOrder(page, MEMBER);

    for (const size of SIZES) {
      const at = `at ${size.width}px`;

      await page.setViewportSize(size);

      const days = await choose(order, "scheduled");
      const pickup = days.locator(".order-pickup").first();

      await expect(pickup).toBeVisible();
      await order.scrollSettled();

      const want = await partsOf(pickup);

      expect(want.place, `the Pick-up days card has a place name ${at}`)
        .not.toBeNull();

      const group = await choose(order, GROUP_ORDERS);
      const round = group.locator(".order-pickup").first();

      await expect(round).toBeVisible();
      await order.scrollSettled();

      const got = await partsOf(round);

      for (const key of ["name", "time", "place", "address", "copy"]) {
        expect(got[key], `the round card shows its ${key} ${at}`)
          .not.toBeNull();
      }

      expect(got.name.text, `the title is the round's date ${at}`)
        .toMatch(/^[A-Z][a-z]+day, [A-Z][a-z]+ \d{1,2}$/);
      expect(got.time.text, `the line under it is the time ${at}`)
        .toMatch(/\d{1,2}:\d{2}/);
      expect(got.time.top, `the time is under the title ${at}`)
        .toBeGreaterThanOrEqual(got.name.bottom - 0.5);
      expect(got.place.top, `the place name is under the time ${at}`)
        .toBeGreaterThanOrEqual(got.time.bottom - 0.5);
      expect(got.address.top, `the address is under the place ${at}`)
        .toBeGreaterThanOrEqual(got.place.bottom - 0.5);

      expect(got.place.style, `the place name's type is Pick-up days' ${at}`)
        .toEqual(want.place.style);
      expect(got.address.style, `the address's type is Pick-up days' ${at}`)
        .toEqual(want.address.style);
      expect(Math.abs((got.address.top - got.place.bottom)
        - (want.address.top - want.place.bottom)),
      `the place and address sit as close as Pick-up days' ${at}`)
        .toBeLessThanOrEqual(0.5);
      expect(Math.abs((got.place.top - got.time.bottom)
        - (want.place.top - want.time.bottom)),
      `the block stands from the time as Pick-up days' does ${at}`)
        .toBeLessThanOrEqual(0.5);

      const copy = copyAt(got);
      const wantCopy = copyAt(want);

      expect(copy.where, `Copy stands to the block as on Pick-up days ${at}`)
        .toBe(wantCopy.where);
      expect(Math.abs(copy.gap - wantCopy.gap),
        `Copy is as far from the block as on Pick-up days ${at}`)
        .toBeLessThanOrEqual(1);
    }
  });

  test("When Group orders is chosen with no round picked, the round " +
    "list shows the same ring as an invalid text input on the order " +
    "page (its border color, glow and radius, read from the page), " +
    "drawn around the list with the radius of its cards, in place of " +
    "the thin red outline, as Pick-up days does",
  async ({ page, baseURL }) => {
    for (const size of SIZES) {
      await page.setViewportSize(size);
      await signIn(page, baseURL, MEMBER, { lists: lists() });
      await noPosts(page);

      const order = await openOrder(page, MEMBER);
      const group = await choose(order, GROUP_ORDERS);
      const list = page.locator("#group-pickups");

      await expect(group.locator(".order-pickup").first()).toBeVisible();
      await payWithoutChoice(order, MEMBER.customer.email,
        MEMBER.customer.phone);
      await holdsRing(page, list, size.width);
    }
  });

  test("When Pick-up days is chosen with no day picked, the list shows " +
    "the same ring as an invalid text input on the order page (its " +
    "border color, glow and radius, read from the page), drawn around " +
    "the list with the radius of its cards, in place of the thin red " +
    "outline", async ({ page }) => {
    for (const size of SIZES) {
      await page.setViewportSize(size);
      await cannedScheduled(page, lists());
      await noPosts(page);

      const order = new OrderPage(page);
      const list = page.locator("#scheduled-pickups");

      await order.open({ eggs: 1 }, { method: "scheduled" });
      await expect(list.locator(".order-pickup").first()).toBeVisible();
      await order.scrollSettled();
      await payWithoutChoice(order, "ringed@example.com");
      await holdsRing(page, list, size.width);
    }
  });
});

// #749's two wording boxes from James's picks on #761 (1b and 2b),
// held word for word. They read no layout, so they run at one width.
test.describe("Group orders' wording (#749, picks 1b and 2b)", () => {
  test("After \"Use this date\" in the lapsed dialog, the status reads " +
    "\"Your group order is now for <the round's date>. Pay again to " +
    "place your order.\"", async ({ page, baseURL }) => {
    // The server has refused the round as lapsed and sent the rounds
    // open a fortnight on, as group-orders.spec.mjs's late member's.
    const now = new Date();
    const later = rounds(new Date(now.getTime() + 14 * 86_400_000));

    expect(later.length, "a later round to offer").toBeGreaterThan(0);
    await signIn(page, baseURL, MEMBER, { lists: lists(), now });
    await page.route("**/api/orders", (route) => (
      route.request().method() === "POST"
        ? route.fulfill({ status: 409, json: { ok: false, dates: later } })
        : route.fallback()
    ));

    const order = await openOrder(page, MEMBER);
    const group = await choose(order, GROUP_ORDERS);

    await pick(page, group.locator("input[type='radio']").first());
    await payWithoutChoice(order, MEMBER.customer.email,
      MEMBER.customer.phone);

    const dialog = page.locator("#order-lapsed");

    await expect(dialog).toBeVisible();

    // The dialog chooses the first round it offers.
    const offered = dialog.locator("input[type='radio']:checked");

    await expect(offered).toHaveValue(later[0].occurrence);
    await dialog.getByRole("button", { name: "Use this date" }).click();
    await expect(dialog).toBeHidden();
    await expect(page.locator("[data-lapsed-status]")).toHaveText(
      `Your group order is now for ${later[0].label}. Pay again to ` +
      "place your order."
    );
  });

  test("Group orders chosen with no round picked says \"Choose a group " +
    "order date.\"", async ({ page, baseURL }) => {
    await signIn(page, baseURL, MEMBER, { lists: lists() });
    await noPosts(page);

    const order = await openOrder(page, MEMBER);
    const group = await choose(order, GROUP_ORDERS);

    await expect(group.locator(".order-pickup").first()).toBeVisible();
    await payWithoutChoice(order, MEMBER.customer.email,
      MEMBER.customer.phone);
    await expect(group.getByText("Choose a group order date.",
      { exact: true })).toBeVisible();
  });
});
