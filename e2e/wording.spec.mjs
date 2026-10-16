// AO-13 (#150): the invoice era's words are gone from what a customer
// or a search engine reads: each page's text as served and as shown,
// its description and its share card, and llms.txt. So is "the
// Scituate drop site": it is the drop site, and Scituate only the
// place (James, 2026-09-25, 540c9e1).
// docs/qa-launch.md, "After the order".

import { expect, test } from "./support/order.mjs";

const RETIRED = /invoices?\b|payment link|pay to confirm|scituate drop site/i;

const PAGES = [
  "/", "/order/", "/login/", "/account/", "/delivery-policy/", "/privacy/",
  "/about/", "/contact/", "/news/", "/accessibility/",
  "/news/2026-09-22-september-update/",
];

test.describe("no retired words (#150)", () => {
  for (const path of PAGES) {
    test(`${path} reads without them`, async ({ page, request }) => {
      // The served page, every panel of it: /account/ sends a visitor
      // who is signed out on to /login/ before much can be read.
      const html = await (await request.get(path)).text();
      const meta = (attr, value) => {
        const tag = html.match(new RegExp(
          `<meta[^>]*${attr}=["']?${value}["']?[^>]*>`, "i"
        ));
        const content = tag && tag[0].match(/content="([^"]*)"/);

        return content ? content[1] : "";
      };
      const said = {
        served: html
          .replace(/<(script|style|svg)\b[\s\S]*?<\/\1>/gi, " ")
          .replace(/<[^>]+>/g, " "),
        description: meta("name", "description"),
        share: meta("property", "og:description"),
      };

      // And what the page says once its scripts have run.
      await page.goto(path);
      await page.waitForLoadState("networkidle");
      said.text = await page.locator("body").innerText();

      for (const [where, text] of Object.entries(said)) {
        const hit = text.match(new RegExp(`.{0,50}${RETIRED.source}.{0,30}`,
          "i"));

        expect(hit && hit[0], `${path} ${where}`).toBeNull();
      }
    });
  }

  test("llms.txt reads without them", async ({ request }) => {
    const text = await (await request.get("/llms.txt")).text();
    const hit = text.match(new RegExp(`.{0,50}${RETIRED.source}.{0,30}`,
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
