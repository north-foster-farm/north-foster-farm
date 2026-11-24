// The order page's Place your order pane (#705), in the browser.
// Criteria tests, written by a test agent from the issue's "Done when"
// list and James's mockup before the change; one test per box, each
// named for it. Box 2 (the wording) is read off the built page in
// test/place-order-copy.criteria.mjs; box 4 (the widths against the
// mockup, and James's sign-off on staging) is the coordinator's
// recorded check.
//
// In the mockup the pane holds, top to bottom: the bold question
// "Interested in pasture-raised news and updates?", the news checkbox,
// the Place your order button the full width of the pane, then the
// delivery policy line. James's revision (in chat, 2026-11-21 16:23
// ET) moved the question and the checkbox into a card of their own
// directly above the pane, so they are read in that card, in the same
// order, and the pane keeps the button and the policy line
// (e2e/optin-card.spec.mjs checks the card). His second revision
// (2026-11-21, in the code chat) made the question the heading of a
// section of its own over that card, so the question is read in the
// page's main, still in the same order (e2e/optin-section.spec.mjs
// checks the section). The pane is the shadowed frame that holds the
// button, the card the one that holds the checkbox, whichever element
// draws each.

import { CUSTOMER } from "./support/canned.mjs";
import { signIn } from "./support/membership.mjs";
import { expect, OrderPage, test } from "./support/order.mjs";

const QUESTION = "Interested in pasture-raised news and updates?";
const POLICY = "By placing an order you agree to our delivery policy.";
const WIDTHS = [390, 768, 1440];

const widthsFor = (project) => (project === "desktop" ? WIDTHS : [null]);
const label = (w) => (w ? `${w} px` : "its own width");

test.describe("the Place your order pane (#705)", () => {
  for (const width of [...WIDTHS, null]) {
    // Done when 1.
    test("the pane reads as the mockup, in its order: the bold " +
      "question, the checkbox, the full-width button, then the policy " +
      `line, at ${label(width)}`, async ({ page }, info) => {
      test.skip(!widthsFor(info.project.name).includes(width),
        "another project's width");
      if (width) await page.setViewportSize({ width, height: 900 });
      await new OrderPage(page).open({ eggs: 1 });
      await expect(page.locator("#order-submit")).toBeVisible();

      const m = await page.evaluate(({ question, policy }) => {
        const pay = document.getElementById("order-submit");
        const tick = document.getElementById("customer-marketing");
        const framed = (el) => {
          let node = el.parentElement;

          while (node && getComputedStyle(node).boxShadow === "none") {
            node = node.parentElement;
          }

          return node;
        };
        const pane = framed(pay);
        const card = framed(tick);

        // The innermost element in root whose words are exactly these.
        const byText = (root, text) => [...root.querySelectorAll("*")]
          .filter((el) => el.textContent.replace(/\s+/g, " ").trim()
            === text)
          .find((el) => ![...el.children].some((child) =>
            child.textContent.replace(/\s+/g, " ").trim() === text))
          ?? null;
        const box = (el) => {
          const r = el.getBoundingClientRect();

          return { top: r.top, bottom: r.bottom, left: r.left,
            right: r.right, width: r.width };
        };
        // The question heads the opt-in's section, over its card.
        const asked = byText(document.querySelector("main"), question);
        const agree = byText(pane, policy);
        const tickLabel = document.querySelector(
          "label[for='customer-marketing']",
        );
        const c = getComputedStyle(pane);
        const inner = pane.getBoundingClientRect();
        const content = {
          left: inner.left + parseFloat(c.borderLeftWidth)
            + parseFloat(c.paddingLeft),
          right: inner.right - parseFloat(c.borderRightWidth)
            - parseFloat(c.paddingRight),
        };
        const order = [asked, tick, pay, agree];

        return {
          found: {
            question: Boolean(asked),
            checkbox: Boolean(card) && card !== pane
              && !card.contains(pay),
            policy: Boolean(agree),
          },
          inDocumentOrder: order.every(Boolean) && order.slice(1)
            .every((el, i) => order[i].compareDocumentPosition(el)
              & Node.DOCUMENT_POSITION_FOLLOWING),
          weight: asked ? Number(getComputedStyle(asked).fontWeight) : 0,
          question: asked && box(asked),
          tick: box(tickLabel),
          pay: box(pay),
          agree: agree && box(agree),
          content,
        };
      }, { question: QUESTION, policy: POLICY });

      expect(m.found, "the question is on the page, the checkbox in its " +
        "card apart from the pane, and the policy line in the pane")
        .toEqual({ question: true, checkbox: true, policy: true });
      expect.soft(m.inDocumentOrder, "question, checkbox, button, " +
        "policy line, in that order").toBe(true);

      // Bold, as the mockup sets it.
      expect.soft(m.weight, "the question's font weight")
        .toBeGreaterThanOrEqual(600);

      // Down the card and the pane in that order.
      expect.soft(m.question.bottom, "the question above the checkbox")
        .toBeLessThanOrEqual(m.tick.top);
      expect.soft(m.tick.bottom, "the checkbox above the button")
        .toBeLessThanOrEqual(m.pay.top);
      expect.soft(m.pay.bottom, "the button above the policy line")
        .toBeLessThanOrEqual(m.agree.top);

      // The button spans the pane, edge to edge of its padding.
      expect.soft(Math.abs(m.pay.left - m.content.left),
        `the button's left edge (${m.pay.left}) against the pane's ` +
        `(${m.content.left})`).toBeLessThanOrEqual(1);
      expect.soft(Math.abs(m.pay.right - m.content.right),
        `the button's right edge (${m.pay.right}) against the pane's ` +
        `(${m.content.right})`).toBeLessThanOrEqual(1);
    });
  }

  // Done when 3 (#391): news/hide.js still hides the block, now the
  // question with the box. The question is shown first to a visitor
  // with no flag, so a page without it does not pass by hiding
  // nothing.
  test("a customer already on the list still sees neither the " +
    "question nor the checkbox", async ({ page, context, baseURL }) => {
    const question = page.getByText(QUESTION, { exact: true });
    const box = page.locator("#customer-marketing");

    await page.goto("/order/");
    await expect(question, "shown to a visitor with no flag")
      .toBeVisible();
    await expect(box, "shown to a visitor with no flag").toBeVisible();

    // This browser has joined.
    await page.evaluate(() => localStorage.setItem("nff-news", "joined"));
    await page.reload();
    await expect(question, "hidden once this browser has joined")
      .toBeHidden();
    await expect(box, "hidden once this browser has joined").toBeHidden();

    // A signed-in customer the server has on the list.
    await page.evaluate(() => localStorage.removeItem("nff-news"));
    await signIn(page, context, baseURL, {
      me: { signedIn: true, customer: { ...CUSTOMER, marketing: true } },
    });
    await page.goto("/order/");
    await expect(page.locator("#customer-first-name"))
      .toHaveValue(CUSTOMER.firstName);
    await expect(question, "hidden for a signed-in customer on the list")
      .toBeHidden();
    await expect(box, "hidden for a signed-in customer on the list")
      .toBeHidden();
  });
});
