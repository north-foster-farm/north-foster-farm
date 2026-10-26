// AO-13 (#150): the invoice era's words are gone from what a customer
// or a search engine reads: each page's text as served and as shown,
// its description and its share card, and llms.txt. So is "the
// Scituate drop site": it is the drop site, and Scituate only the
// place (James, 2026-09-25, 540c9e1).
// docs/qa-launch.md, "After the order".
//
// The patterns James has rejected since (#379, A1 to A21 in the voice
// guide) join here where a pattern can be matched: A7 brand-deck
// clichés, A8 a team signing for two people, A14 an em dash in site
// copy (the sign-off "— James and Jim" keeps its dash, #211), A16
// filler transitions. The rest (an unbacked claim, a number we don't
// measure, a riddle, copy that knocks the market, jargon, a fragment
// after a fragment...) are judgment, and live in the guide alone.
// "Premium" is on A7's list but stays off this test: About's "We raise
// a premium chicken" is James's own line.

import { expect, test } from "./support/order.mjs";

const RETIRED = /invoices?\b|payment link|pay to confirm|scituate drop site/i;

// Each with the guide's number, so a failure names the rule.
const REJECTED = [
  ["A9 retired words", RETIRED],
  ["A7 brand-deck cliché", new RegExp([
    "ethically raised", "raised the right way", "as nature intended",
    "natural behaviou?rs", "fresh air and sunshine", "stress-free",
    "healthy land, healthy animals", "regenerative",
    "know where your food comes from", "farm[- ]to[- ]table",
    "higher standards", "the finest", "nutrient-dense",
    "stay connected to the farm",
  ].join("|"), "i")],
  ["A8 a team for two people", /\b(the )?(nff|north foster farm) team\b/i],
  ["A14 em dash", /—(?! James and Jim)/],
  ["A16 filler", new RegExp([
    "\\bat its core\\b", "\\bthat said\\b", "\\bultimately\\b",
    "\\bin today's world\\b", "\\bit's important to note\\b",
  ].join("|"), "i")],
];

const firstHit = (text) => {
  for (const [rule, re] of REJECTED) {
    const hit = text.match(new RegExp(`.{0,50}(?:${re.source}).{0,30}`,
      re.flags));

    if (hit) return `${rule}: ${hit[0]}`;
  }

  return null;
};

const PAGES = [
  "/", "/order/", "/login/", "/account/", "/delivery-policy/", "/privacy/",
  "/about/", "/contact/", "/news/", "/accessibility/",
  "/news/three-quarters-of-the-way/",
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
      // Tags become spaces and runs of space one, so a retired phrase
      // split by the orphan pass's span (#303) still reads as one.
      const said = {
        served: html
          .replace(/<(script|style|svg)\b[\s\S]*?<\/\1>/gi, " ")
          .replace(/<[^>]+>/g, " ")
          .replace(/\s+/g, " "),
        description: meta("name", "description"),
        share: meta("property", "og:description"),
      };

      // And what the page says once its scripts have run.
      await page.goto(path);
      await page.waitForLoadState("networkidle");
      said.text = await page.locator("body").innerText();

      for (const [where, text] of Object.entries(said)) {
        expect(firstHit(text), `${path} ${where}`).toBeNull();
      }
    });
  }

  test("llms.txt reads without them", async ({ request }) => {
    const text = await (await request.get("/llms.txt")).text();

    expect(firstHit(text)).toBeNull();
  });

  // #313: scheduled pickup is a way to get an order, and llms.txt
  // says so from the data. Markets and pop-ups appear on the order
  // page when the farm opens them; no market's dates are listed.
  test("llms.txt has a Pickup days section", async ({ request }) => {
    const text = await (await request.get("/llms.txt")).text();
    const section = text.match(/\n## Pickup days\n([\s\S]*?)\n## /);

    expect(section, "a Pickup days section").toBeTruthy();
    expect(section[1]).toMatch(/drop site: Saturdays, 10:00 – 11:00 AM/i);
    expect(section[1]).toMatch(/46 Institute Lane/);
    expect(section[1]).toMatch(/11:59 PM the day before/);
    expect(section[1]).toMatch(/Markets and pop-ups appear on the order page/);
    expect(section[1]).not.toMatch(/Foster Farmers Market|Tilted Barn/);
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
