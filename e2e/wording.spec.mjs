// AO-13 (#150): the invoice era's words are gone from what a customer
// or a search engine reads: each page's text, its description and its
// share card, and llms.txt. docs/qa-launch.md, "After the order".

import { expect, test } from "./support/order.mjs";

const INVOICE_ERA = /invoices?\b|payment link|pay to confirm/i;

const PAGES = [
  "/", "/order/", "/login/", "/account/", "/delivery-policy/", "/privacy/",
  "/about/", "/contact/", "/news/", "/accessibility/",
];

test.describe("no invoice-era words (#150)", () => {
  for (const path of PAGES) {
    test(`${path} reads without them`, async ({ page }) => {
      await page.goto(path);

      const said = await page.evaluate(() => {
        const meta = (sel) => {
          const el = document.querySelector(sel);

          return el ? el.getAttribute("content") : "";
        };

        return {
          text: document.body.innerText,
          description: meta("meta[name='description']"),
          share: meta("meta[property='og:description']"),
        };
      });

      for (const [where, text] of Object.entries(said)) {
        const hit = text.match(new RegExp(`.{0,50}${INVOICE_ERA.source}.{0,30}`,
          "i"));

        expect(hit && hit[0], `${path} ${where}`).toBeNull();
      }
    });
  }

  test("llms.txt reads without them", async ({ request }) => {
    const text = await (await request.get("/llms.txt")).text();
    const hit = text.match(new RegExp(`.{0,50}${INVOICE_ERA.source}.{0,30}`,
      "i"));

    expect(hit && hit[0]).toBeNull();
  });

  test("llms.txt offers no market pickup", async ({ request }) => {
    const text = await (await request.get("/llms.txt")).text();

    expect(text).not.toMatch(/market pickup/i);
  });

  test("the paper order form leads to the order page", async ({
    request,
  }) => {
    const res = await request.get("/order-form.pdf", { maxRedirects: 0 });

    expect(res.status()).toBe(301);
    expect(new URL(res.headers().location, res.url()).pathname)
      .toBe("/order/");
  });
});
