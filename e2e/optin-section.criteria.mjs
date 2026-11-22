// Criteria test for #705's second revision (James, 2026-11-21, in the
// code chat): the Farm News opt-in becomes its own section above the
// "Place your order" heading. Its question is an h2 styled like the
// page's other section headings, with "pasture-raised" in italics and
// the primary green; the checkbox sits in a card framed like the other
// cards under that heading; a customer already on the list sees
// neither the heading nor the card. Written by a test agent from the
// box alone, before the change.
//
// The page's other section headings are "Place your order" and
// "Contact information", the legend or heading with those words.
// "Styled like" them is their computed font, size, weight, line
// height, color, spacing and case, which the two share. The
// primary green is read off the page, as the background of the Place
// your order button (btn-primary), never written here. A card is the
// nearest element that draws a shadow, as in e2e/optin-card.spec.mjs:
// the opt-in's is the one around its checkbox, the contact card the
// one around the first name. "Framed like the contact card" is its
// border, radius, background and padding.
//
// Held out of every run by its name: the config takes *.spec.mjs only,
// so renaming it to optin-section.spec.mjs turns it on. It runs in the
// desktop project, which it sizes to 390, 768 and 1440 px itself.

import { CUSTOMER } from "./support/canned.mjs";
import { signIn } from "./support/membership.mjs";
import { expect, OrderPage, test } from "./support/order.mjs";

const QUESTION = "Interested in pasture-raised news and updates?";
const STRESS = "pasture-raised";
const WIDTHS = [390, 768, 1440];

// Half a pixel for subpixel rounding.
const SLACK = 0.5;

// The heading, the card and the headings and card they are held to.
const measure = (page) => page.evaluate(({ question, stress, slack }) => {
  const words = (el) => el.textContent.replace(/\s+/g, " ").trim();
  // The innermost element in root whose words are exactly these,
  // outside any link or button.
  const byText = (root, text) => [...root.querySelectorAll("*")]
    .filter((el) => words(el) === text && !el.closest("a, button"))
    .find((el) => ![...el.children].some((c) => words(c) === text))
    ?? null;
  // The nearest ancestor of el that draws a shadow.
  const framed = (el) => {
    let node = el && el.parentElement;

    while (node && getComputedStyle(node).boxShadow === "none") {
      node = node.parentElement;
    }

    return node;
  };
  const box = (el) => {
    const r = el.getBoundingClientRect();

    return { top: r.top, bottom: r.bottom };
  };
  const font = (el) => {
    const c = getComputedStyle(el);

    return {
      family: c.fontFamily, size: c.fontSize, weight: c.fontWeight,
      lineHeight: c.lineHeight, color: c.color,
      letterSpacing: c.letterSpacing, textTransform: c.textTransform,
    };
  };
  const frame = (el) => {
    const c = getComputedStyle(el);

    return {
      border: [c.borderTopWidth, c.borderTopStyle, c.borderTopColor]
        .join(" "),
      radius: c.borderTopLeftRadius,
      background: c.backgroundColor,
      padding: [c.paddingTop, c.paddingRight, c.paddingBottom,
        c.paddingLeft].join(" "),
    };
  };
  const following = (a, b) => Boolean(a.compareDocumentPosition(b)
    & Node.DOCUMENT_POSITION_FOLLOWING);

  const main = document.querySelector("main");
  const asked = byText(main, question);
  const heading = asked && asked.closest("h2, [role='heading']");
  // A section heading: a legend or heading with these words, not a
  // jump link's or a menu's copy of them.
  const section = (text) => [...main.querySelectorAll("legend, h1, h2, " +
    "h3, h4, h5, h6, [role='heading']")]
    .find((el) => words(el) === text) ?? null;
  const place = section("Place your order");
  const contact = section("Contact information");
  const tick = document.getElementById("customer-marketing");
  const card = framed(tick);
  const contactCard = framed(document.getElementById(
    "customer-first-name"));
  const pay = document.getElementById("order-submit");

  const found = {
    question: Boolean(asked), place: Boolean(place),
    contact: Boolean(contact), card: Boolean(card),
    contactCard: Boolean(contactCard),
  };

  if (Object.values(found).some((v) => !v)) return { found };

  const stressed = byText(asked, stress);
  const level = heading && (heading.localName === "h2" ? 2
    : Number(heading.getAttribute("aria-level")));
  const asBox = box(asked);
  const cardBox = box(card);
  const placeBox = box(place);
  const c = stressed && getComputedStyle(stressed);

  return {
    found,
    level,
    font: { question: font(heading ?? asked), place: font(place),
      contact: font(contact) },
    stress: stressed ? { style: c.fontStyle, color: c.color }
      : null,
    primary: getComputedStyle(pay).backgroundColor,
    frames: { card: frame(card), contact: frame(contactCard) },
    cardIsContact: card === contactCard,
    // The heading is over the card, not in it.
    headingInCard: card.contains(asked),
    headingAboveCard: asBox.bottom <= cardBox.top + slack,
    // Before Place your order, in the document and on screen.
    beforeInDocument: {
      question: following(asked, place),
      card: following(card, place) && !card.contains(place),
    },
    aboveOnScreen: {
      question: asBox.bottom <= placeBox.top + slack,
      card: cardBox.bottom <= placeBox.top + slack,
    },
    boxes: { question: asBox, card: cardBox, place: placeBox },
  };
}, { question: QUESTION, stress: STRESS, slack: SLACK });

// Whether the opt-in's card is shown: the checkbox's nearest framed
// ancestor, which may be hidden itself or inside a hidden block.
const cardShown = (page) => page.evaluate(() => {
  let card = document.getElementById("customer-marketing").parentElement;

  while (card && getComputedStyle(card).boxShadow === "none") {
    card = card.parentElement;
  }

  return Boolean(card) && card.checkVisibility({
    visibilityProperty: true,
  });
});

const heading = (page) => page.getByRole("heading", {
  level: 2, name: QUESTION,
});

test.describe("#705 the Farm News opt-in as its own section", () => {
  test("The opt-in is its own section above the \"Place your order\" " +
    "heading: its question, \"Interested in pasture-raised news and " +
    "updates?\", is an h2 styled like the page's other section " +
    "headings, with \"pasture-raised\" in italics and the primary " +
    "green; the checkbox sits in a card framed like the other cards " +
    "under that heading; and a customer already on the list sees " +
    "neither the heading nor the card",
  async ({ page, context, baseURL }, info) => {
    test.skip(info.project.name !== "desktop",
      "sized to 390, 768 and 1440 px in the desktop project");

    const order = new OrderPage(page);

    for (const width of WIDTHS) {
      const at = `${width} px`;

      await page.setViewportSize({ width, height: 900 });
      await order.open({ eggs: 1 });
      await expect(page.locator("#order-submit")).toBeVisible();
      await expect(page.locator("#customer-marketing")).toBeVisible();
      await page.locator("#customer-marketing").scrollIntoViewIfNeeded();

      // The question, word for word, as a level-two heading.
      await expect.soft(heading(page), `${at}: the question as a ` +
        "level-two heading").toBeVisible({ timeout: 5_000 });

      const m = await measure(page);

      expect(m.found, `${at}: the question, both section headings ` +
        "and both cards").toEqual({ question: true, place: true,
        contact: true, card: true, contactCard: true });
      expect.soft(m.level, `${at}: the question's heading level`)
        .toBe(2);

      // Styled like the page's other section headings.
      expect.soft(m.font.place, `${at}: the two section headings ` +
        "share a style").toEqual(m.font.contact);
      expect.soft(m.font.question, `${at}: the question's style`)
        .toEqual(m.font.place);

      // "pasture-raised" in italics, in the primary green.
      expect.soft(m.stress, `${at}: "${STRESS}" in an element of its ` +
        "own").not.toBeNull();
      expect.soft(m.stress?.style ?? "none", `${at}: "${STRESS}"'s font ` +
        "style").toMatch(/^(italic|oblique)/);
      expect.soft(m.stress?.color ?? "none", `${at}: "${STRESS}"'s color, ` +
        `against the primary button's (${m.primary})`).toBe(m.primary);

      // The checkbox in a card like the contact card, under the
      // heading and not around it.
      expect.soft(m.cardIsContact, `${at}: the opt-in's card is not ` +
        "the contact card").toBe(false);
      expect.soft(m.frames.card, `${at}: the opt-in card's frame`)
        .toEqual(m.frames.contact);
      expect.soft(m.headingInCard, `${at}: the heading stands over ` +
        "the card, not in it").toBe(false);
      expect.soft(m.headingAboveCard, `${at}: the heading ` +
        `(${JSON.stringify(m.boxes.question)}) above the card ` +
        `(${JSON.stringify(m.boxes.card)})`).toBe(true);

      // The section comes before Place your order.
      expect.soft(m.beforeInDocument, `${at}: the question and the ` +
        "card before the Place your order heading in the document")
        .toEqual({ question: true, card: true });
      expect.soft(m.aboveOnScreen, `${at}: the question and the card ` +
        "above the Place your order heading " +
        `(${JSON.stringify(m.boxes.place)}) on screen`)
        .toEqual({ question: true, card: true });
    }

    // This browser has joined: neither heading nor card.
    await page.evaluate(() => localStorage.setItem("nff-news", "joined"));
    await page.reload();
    await expect(page.locator("#order-submit")).toBeVisible();
    await expect(heading(page),
      "the heading, once this browser has joined").toBeHidden();
    await expect(page.getByText(QUESTION, { exact: true }),
      "the question, once this browser has joined").toBeHidden();
    await expect(page.locator("#customer-marketing"),
      "the checkbox, once this browser has joined").toBeHidden();
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
    await expect(heading(page),
      "the heading, for a signed-in customer on the list").toBeHidden();
    await expect(page.getByText(QUESTION, { exact: true }),
      "the question, for a signed-in customer on the list").toBeHidden();
    await expect(page.locator("#customer-marketing"),
      "the checkbox, for a signed-in customer on the list").toBeHidden();
    await expect.poll(() => cardShown(page),
      "the opt-in's card, for a signed-in customer on the list")
      .toBe(false);
  });
});
