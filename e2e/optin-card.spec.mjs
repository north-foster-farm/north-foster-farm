// Criteria test for #705's revision from James (in chat, 2026-11-21
// 16:23 ET): the Farm News opt-in leaves the Place your order pane and
// becomes a card of its own, framed like the other cards, directly
// above the pane. The pane keeps the Place your order button and the
// policy line, and a customer already on the list sees no opt-in card.
// Written by a test agent from the box alone, before the change.
//
// A card is the nearest element that draws a shadow, as the pane is in
// e2e/place-order-pane.spec.mjs: the opt-in's card is the one around
// its checkbox, the contact card the one around the first name, the
// pane the one around the button. "Framed like the other cards" is the
// frame the contact card and the pane share: border, radius and
// background, with the shadow of either.
//
// James's second revision (2026-11-21, in the code chat) made the
// opt-in its own section above the "Place your order" heading: the
// question is a heading over the card, not in it, and the card holds
// the checkbox (e2e/optin-section.spec.mjs checks the section). So the
// card ends above the "Place your order" heading, and that heading is
// all that is shown between the card and the pane in the pane's
// column.
//
// Held out of every run by its name: the config takes *.spec.mjs only,
// so renaming it to optin-card.spec.mjs turns it on. It runs in the
// desktop project, which it sizes to 390 and 1440 px itself.

import { CUSTOMER } from "./support/canned.mjs";
import { signIn } from "./support/membership.mjs";
import { expect, OrderPage, test } from "./support/order.mjs";

const QUESTION = "Interested in pasture-raised news and updates?";
const POLICY = "By placing an order you agree to our delivery policy.";
const WIDTHS = [390, 1440];

const PLACE = "Place your order";

// Half a pixel for subpixel rounding.
const SLACK = 0.5;

// What the page shows of the three cards.
const measure = (page) => page.evaluate(({
  question, policy, place, slack,
}) => {
  // The nearest ancestor of el that draws a shadow.
  const framed = (el) => {
    let node = el && el.parentElement;

    while (node && getComputedStyle(node).boxShadow === "none") {
      node = node.parentElement;
    }

    return node;
  };
  const words = (el) => el.textContent.replace(/\s+/g, " ").trim();
  // The innermost element whose words are exactly these.
  const byText = (text) => [...document.body.querySelectorAll("*")]
    .filter((el) => words(el) === text)
    .find((el) => ![...el.children].some((c) => words(c) === text))
    ?? null;
  const box = (r) => ({
    top: r.top, bottom: r.bottom, left: r.left, right: r.right,
  });
  const frame = (el) => {
    const c = getComputedStyle(el);

    return {
      border: [c.borderTopWidth, c.borderTopStyle, c.borderTopColor]
        .join(" "),
      radius: c.borderTopLeftRadius,
      background: c.backgroundColor,
      shadow: c.boxShadow,
    };
  };
  // A bar pinned to the screen is not between two cards.
  const pinned = (el) => {
    for (let n = el; n; n = n.parentElement) {
      if (["fixed", "sticky"].includes(getComputedStyle(n).position)) {
        return true;
      }
    }

    return false;
  };
  // Every line of words and every control shown inside root, as
  // boxes, leaving out what skip holds.
  const shown = (root, skip) => {
    const out = [];
    const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);

    for (let t = walk.nextNode(); t; t = walk.nextNode()) {
      if (!t.textContent.trim() || (skip && skip.contains(t))) continue;
      if (pinned(t.parentElement)) continue;

      const range = document.createRange();

      range.selectNodeContents(t);
      for (const r of range.getClientRects()) {
        if (r.width > 0 && r.height > 0) {
          out.push({ text: t.textContent.trim(), ...box(r) });
        }
      }
    }
    for (const el of root.querySelectorAll("input, select, textarea, " +
      "button, img, svg")) {
      if ((skip && skip.contains(el)) || pinned(el)) continue;

      const r = el.getBoundingClientRect();

      if (r.width > 0 && r.height > 0 && el.checkVisibility({
        visibilityProperty: true, opacityProperty: true,
      })) out.push({ text: `${el.localName}#${el.id}`, ...box(r) });
    }

    return out;
  };

  const tick = document.getElementById("customer-marketing");
  const pay = document.getElementById("order-submit");
  const asked = byText(question);
  const agree = byText(policy);
  // The section heading, not the button's label or a link.
  const heading = [...document.body.querySelectorAll("*")]
    .filter((el) => words(el) === place && !el.closest("a, button"))
    .find((el) => ![...el.children].some((c) => words(c) === place))
    ?? null;
  const card = framed(tick);
  const contact = framed(document.getElementById("customer-first-name"));
  const pane = framed(pay);

  if (!card || !pane || !contact) {
    return { found: { card: Boolean(card), contact: Boolean(contact),
      pane: Boolean(pane) } };
  }

  const cardBox = box(card.getBoundingClientRect());
  const paneBox = box(pane.getBoundingClientRect());
  const payTop = pay.getBoundingClientRect().top;

  return {
    found: { card: true, contact: true, pane: true },
    own: card !== pane && !card.contains(pane) && !pane.contains(card),
    holds: {
      question: Boolean(asked && card.contains(asked)),
      checkbox: true,
      button: card.contains(pay),
      policy: Boolean(agree && card.contains(agree)),
    },
    paneHolds: {
      question: Boolean(asked && pane.contains(asked)),
      checkbox: pane.contains(tick),
      button: true,
      policy: Boolean(agree && pane.contains(agree)),
    },
    frames: { card: frame(card), contact: frame(contact),
      pane: frame(pane) },
    card: cardBox,
    pane: paneBox,
    heading: heading && box(heading.getBoundingClientRect()),
    // Anything shown in the pane's column between the card and it.
    between: shown(document.body).filter((r) =>
      r.top >= cardBox.bottom - slack && r.bottom <= paneBox.top + slack
      && r.right > paneBox.left && r.left < paneBox.right)
      .map((r) => r.text),
    // What the pane shows that starts above the button.
    abovePay: shown(pane, pay).filter((r) => r.top < payTop - slack)
      .map((r) => r.text),
  };
}, { question: QUESTION, policy: POLICY, place: PLACE, slack: SLACK });

// Whether the opt-in's card is shown: the checkbox's nearest framed
// ancestor, as measure finds it, which may be hidden itself or inside
// a hidden block.
const cardShown = (page) => page.evaluate(() => {
  let card = document.getElementById("customer-marketing").parentElement;

  while (card && getComputedStyle(card).boxShadow === "none") {
    card = card.parentElement;
  }

  return Boolean(card) && card.checkVisibility({
    visibilityProperty: true,
  });
});

test.describe("#705 the Farm News opt-in in a card of its own", () => {
  test("The Farm News opt-in is a card of its own, framed like the " +
    "other cards, above the Place your order heading and pane; the pane " +
    "holds the Place your order button and the policy line, and a " +
    "customer already on the list sees no opt-in card",
  async ({ page, context, baseURL }, info) => {
    test.skip(info.project.name !== "desktop",
      "sized to 390 and 1440 px in the desktop project");

    const order = new OrderPage(page);

    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 900 });
      await order.open({ eggs: 1 });
      await expect(page.locator("#order-submit")).toBeVisible();
      await expect(page.locator("#customer-marketing")).toBeVisible();
      await page.locator("#order-submit").scrollIntoViewIfNeeded();

      const m = await measure(page);
      const at = `${width} px`;

      expect(m.found, `${at}: the opt-in's, the contact's and the ` +
        "button's cards").toEqual({ card: true, contact: true,
        pane: true });

      // Its own card, holding the question and the checkbox only.
      expect.soft(m.own, `${at}: the opt-in's card is not the pane, ` +
        "and neither holds the other").toBe(true);
      expect.soft(m.holds, `${at}: what the opt-in's card holds`)
        .toEqual({ question: false, checkbox: true, button: false,
          policy: false });
      expect.soft(m.paneHolds, `${at}: what the pane holds`)
        .toEqual({ question: false, checkbox: false, button: true,
          policy: true });

      // The same frame as the contact card and the pane.
      const { shadow, ...frame } = m.frames.card;
      const { shadow: contactShadow, ...contact } = m.frames.contact;
      const { shadow: paneShadow, ...pane } = m.frames.pane;

      expect.soft(contact, `${at}: the contact card and the pane share ` +
        "a frame").toEqual(pane);
      expect.soft(frame, `${at}: the opt-in card's frame`)
        .toEqual(contact);
      expect.soft([contactShadow, paneShadow], `${at}: the opt-in ` +
        `card's shadow (${shadow}) is the contact card's or the pane's`)
        .toContain(shadow);

      // Above the Place your order heading, which is all that stands
      // between the card and the pane.
      expect(m.heading, `${at}: the ${PLACE} heading`).not.toBeNull();
      expect.soft(m.card.bottom, `${at}: the opt-in card's bottom ` +
        `against the ${PLACE} heading's top (${m.heading.top})`)
        .toBeLessThanOrEqual(m.heading.top + SLACK);
      expect.soft(m.heading.bottom, `${at}: the ${PLACE} heading's ` +
        `bottom against the pane's top (${m.pane.top})`)
        .toBeLessThanOrEqual(m.pane.top + SLACK);
      expect.soft(m.between, `${at}: only the ${PLACE} heading shown ` +
        "between the card and the pane").toEqual([PLACE]);

      // The pane opens with the button.
      expect.soft(m.abovePay, `${at}: what the pane shows above the ` +
        "Place your order button").toEqual([]);
    }

    // This browser has joined: no card, frame and all.
    await page.evaluate(() => localStorage.setItem("nff-news", "joined"));
    await page.reload();
    await expect(page.locator("#order-submit")).toBeVisible();
    await expect(page.locator("#customer-marketing"),
      "the checkbox, once this browser has joined").toBeHidden();
    await expect(page.getByText(QUESTION, { exact: true }),
      "the question, once this browser has joined").toBeHidden();
    await expect.poll(() => cardShown(page),
      "the opt-in's card, once this browser has joined").toBe(false);

    // A signed-in customer the server has on the list.
    await page.evaluate(() => localStorage.removeItem("nff-news"));
    await signIn(page, context, baseURL, {
      me: { signedIn: true, customer: { ...CUSTOMER, marketing: true } },
    });
    await page.goto("/order/");
    await expect(page.locator("#customer-first-name"))
      .toHaveValue(CUSTOMER.firstName);
    await expect(page.locator("#customer-marketing"),
      "the checkbox, for a signed-in customer on the list").toBeHidden();
    await expect(page.getByText(QUESTION, { exact: true }),
      "the question, for a signed-in customer on the list").toBeHidden();
    await expect.poll(() => cardShown(page),
      "the opt-in's card, for a signed-in customer on the list")
      .toBe(false);
  });
});
