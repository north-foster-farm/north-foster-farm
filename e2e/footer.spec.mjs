// The footer as #141 and #226 land it: one centered column with the
// sign-up (an input group with one focus ring and an egg spinner),
// the APPPA mark, one line of links, one of ways to reach the farm and
// the copyright. The sign-up request is
// stubbed here; farm news end to end is news.spec.mjs.
// docs/qa-launch.md, "The autumn refresh".

import { expectBusy, expectIdle, holdRequests } from "./support/busy.mjs";
import { expect, test } from "./support/order.mjs";

const LINKS = [
  "About", "Account", "News", "Accessibility", "Privacy", "Delivery",
  "Contact", "Order", "llms.txt",
];

// Each dotted line's items, grouped by the row they sit on, with the
// dot each one draws before itself ("none" for no dot).
const rows = (list) => list.evaluate((ul) => {
  const byTop = new Map();

  for (const li of ul.children) {
    const top = li.offsetTop;

    if (!byTop.has(top)) byTop.set(top, []);
    byTop.get(top).push({
      text: li.textContent.trim(),
      dot: getComputedStyle(li, "::before").content,
    });
  }

  return [...byTop.values()];
});

// James, 2026-10-18 (#267): the delivery policy has no link in the main
// navigation. The page, its footer link and the order page's links stay.
test.describe("the delivery policy's links (#267)", () => {
  const policy = "a[href$='/delivery-policy/']";

  test("not in the main navigation, in the footer and on the order page",
    async ({ page }) => {
      for (const width of [1280, 390]) {
        await page.setViewportSize({ width, height: 900 });
        await page.goto("/");
        await expect(page.locator(`nav[aria-label='Main'] ${policy}`))
          .toHaveCount(0);
        await expect(page.locator(`nav[aria-label='Footer'] ${policy}`))
          .toHaveCount(1);
      }
      await page.goto("/order/");
      expect(await page.locator(`main ${policy}`).count())
        .toBeGreaterThan(0);
      expect((await page.request.get("/delivery-policy/")).ok()).toBe(true);
    });
});

test.describe("footer (#141)", () => {
  test("the links, then how to reach the farm, then the copyright",
    async ({ page, request }) => {
      // Contact joins the links once its page exists (#140).
      const contact = (await request.get("/contact/")).ok();
      const expected = LINKS.filter((name) => contact || name !== "Contact");

      await page.goto("/");

      const footer = page.locator("footer.site-footer");
      const links = footer.locator("nav[aria-label='Footer'] > ul > li");
      const reach = footer.locator(".footer-contact > li");

      await expect(links).toHaveText(expected);
      await expect(reach).toHaveText([
        "(401) 578-3713", "sales@northfosterfarm.com", "@northfosterfarm",
      ]);
      await expect(reach.nth(0).locator("a"))
        .toHaveAttribute("href", "tel:+14015783713");
      await expect(reach.nth(1).locator("a"))
        .toHaveAttribute("href", "mailto:sales@northfosterfarm.com");
      await expect(reach.nth(2).locator("a"))
        .toHaveAttribute("href", /instagram\.com\/northfosterfarm$/);

      // In reading order (#226, R-FT, #303): sign-up, links, contact
      // line, copyright. The APPPA mark is gone.
      const order = await footer.evaluate((el) => [
        "[data-farm-list-form]", "nav[aria-label='Footer']",
        ".footer-contact", "#copyright-year",
      ].map((sel) => {
        const all = [...el.querySelectorAll("*")];

        return all.indexOf(el.querySelector(sel));
      }));

      expect(order.every((i) => i >= 0)).toBe(true);
      await expect(footer.locator(".apppa-logo")).toHaveCount(0);
      expect([...order].sort((a, b) => a - b)).toEqual(order);
      await expect(footer.locator("#copyright-year"))
        .toHaveText(String(new Date().getFullYear()));
    });

  test("no row of the dotted lines opens with a dot, at any width",
    async ({ page }) => {
      await page.goto("/");

      const lists = page.locator("footer.site-footer [data-dot-list]");
      let wrapped = 0;

      for (const width of [1500, 990, 575, 390, 320]) {
        await page.setViewportSize({ width, height: 800 });
        await page.waitForTimeout(200);

        for (const list of await lists.all()) {
          const lines = await rows(list);

          if (lines.length > 1) wrapped += 1;
          for (const [i, line] of lines.entries()) {
            expect(line[0].dot, `${width}px row ${i + 1} opens with ` +
              `"${line[0].text}"`).toBe("none");
            for (const item of line.slice(1)) {
              expect(item.dot, `${width}px "${item.text}"`).toBe("\"·\"");
            }
          }
        }
      }
      expect(wrapped, "some line wraps, or this proves nothing")
        .toBeGreaterThan(0);
    });

  test("a bad address is marked at the field, and fixing it clears it",
    async ({ page }) => {
      const form = page.locator("footer [data-farm-list-form]");
      const input = form.locator("input[type='email']");
      const note = form.locator("[data-farm-list-note]");

      await page.goto("/");
      await expect(form.locator("label"))
        .toHaveText("Farm news by email");
      await expect(note, "nothing under the field until an answer")
        .toHaveText("");

      await form.getByRole("button").click();
      await expect(note).toHaveText("Please enter an email address.");

      // A bare type="email" would let "you@farm" through.
      for (const bad of ["nope", "you@farm"]) {
        await input.fill(bad);
        await form.getByRole("button").click();
        await expect(note)
          .toHaveText("Please enter a valid email address.");
        await expect(input).toHaveClass(/\bis-invalid\b/);
        await expect(input).toHaveAttribute("aria-invalid", "true");
        await expect(input).toBeFocused();
      }

      await input.fill("you@example.com");
      await expect(input).not.toHaveClass(/\bis-invalid\b/);
      await expect(note).toHaveText("");
    });

  test("the focus ring goes round the field and its button (#226)",
    async ({ page }) => {
      const form = page.locator("footer [data-farm-list-form]");
      const input = form.locator("input[type='email']");
      const shadow = (el) =>
        el.evaluate((node) => getComputedStyle(node).boxShadow);

      await page.goto("/");
      await input.focus();
      expect(await shadow(form.locator(".input-group"))).not.toBe("none");
      expect(await shadow(input), "no ring of its own").toBe("none");

      await input.blur();
      expect(await shadow(form.locator(".input-group"))).toBe("none");
    });

  // James, #280: on the dark band the invalid outline, and the ring
  // when focused, take the red of the message under the field.
  test("an invalid field is outlined in the message's red (#280)",
    async ({ page }) => {
      const form = page.locator("footer [data-farm-list-form]");
      const input = form.locator("input[type='email']");
      const note = form.locator("[data-farm-list-note]");
      const style = (el, prop) =>
        el.evaluate((node, p) => getComputedStyle(node)[p], prop);

      await page.goto("/");
      await input.fill("nope");
      await form.getByRole("button").click();
      await expect(input).toHaveClass(/\bis-invalid\b/);

      const red = await style(note, "color");

      await expect.poll(() => style(input, "borderTopColor"),
        "focused: the border").toBe(red);
      expect(await style(form.locator(".input-group"), "boxShadow"),
        "focused: the ring").toContain(red);

      await input.blur();
      await expect.poll(() => style(input, "borderTopColor"),
        "at rest: the border").toBe(red);
      expect(await style(form.locator(".input-group"), "boxShadow"),
        "at rest: the ring wraps the field and the button (#393)")
        .toContain(red);
      expect(await style(input, "boxShadow"), "no ring of its own")
        .toBe("none");
      expect(await style(input, "backgroundImage"), "no warning icon")
        .toBe("none");
    });

  test("while it sends, the button shows the egg, grows and settles back",
    async ({ page }) => {
      const form = page.locator("footer [data-farm-list-form]");
      const button = form.locator(".busy-button");
      const hold = await holdRequests(page, "**/api/news/subscribe");

      await page.goto("/");

      const email = "qa-e2e-footer@example.com";
      // At rest the button fits "Sign up" (#223); while it sends, it fits
      // the spinner and "Sending".
      const width = (await button.boundingBox()).width;
      const busyWidth = await button.evaluate((el) => {
        const face = el.querySelector(".busy-button-busy");
        const style = getComputedStyle(el);

        return face.getBoundingClientRect().width
          + parseFloat(style.paddingLeft) + parseFloat(style.paddingRight)
          + parseFloat(style.borderLeftWidth)
          + parseFloat(style.borderRightWidth);
      });

      expect(busyWidth, "the busy face is wider").toBeGreaterThan(width);
      await form.locator("input[type='email']").fill(email);
      await button.click();
      await expectBusy(page, button, {
        busyWord: "Sending", width: busyWidth,
      });
      await expect(form.locator("[data-farm-list-note]")).toHaveText("");

      // A second press while it sends sends nothing more. The button is
      // only aria-disabled, so a person can still press it.
      await button.click({ force: true });
      hold.release();

      await expect(form.locator("[data-farm-list-note]"))
        .toHaveText("You're on the list. Thanks!");
      await page.waitForTimeout(400);
      await expectIdle(button, { width });
      await expect(button).not.toHaveAttribute("style", /width/);
      expect(hold.calls()).toBe(1);
    });
});

// James, 2026-10-20 and 2026-10-22 (#226): no ornament row between a
// page and its dark band, and nothing left in its place.
test.describe("above the footer (#226)", () => {
  for (const path of ["/about/", "/order/"]) {
    test(`no ornament row on ${path}`, async ({ page }) => {
      await page.goto(path);
      await expect(page.locator(".ticker-slot")).toHaveCount(0);
      await expect(page.locator(".site-footer")).toHaveCount(1);
    });
  }
});

// #313: the Shop now band's lead names the drop site (#400: "pickup",
// not the internal "scheduled pickup", in prose).
test("the Shop now lead names the three ways", async ({ page }) => {
  await page.goto("/about/");
  await expect(page.locator(".touch-shop .touch-lead")).toHaveText(
    new RegExp("Delivery on Thursdays, on-farm pickup, or pickup at our " +
      "drop site in Scituate\\.")
  );
});
