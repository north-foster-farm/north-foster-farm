// #947's criteria in a browser: the account page takes a link's order
// value as an order id only when it has the shape of one, so a crafted
// link cannot make the farm's own page show words the farm did not
// write. Written by the test agent from the issue's words, before the
// fix; the unit side is test/order-link-shape.criteria.mjs.
//
// The page's tests use canned answers (support/account-page.mjs), so
// they run on a local build as on staging. The redirect's test reads
// Netlify's own answer off the wire, so it runs against a deploy only
// (the issue's box says "on staging"); a local build skips it, since
// its server only imitates the rule.

import { PAID, openAccount, shown } from "./support/account-page.mjs";
import { expect, test } from "./support/order.mjs";

// What a crafted link might try to put on the page.
const FAKE = "Call 555-0100 to confirm your order";

const isLocal = (baseURL) => ["localhost", "127.0.0.1"]
  .includes(new URL(baseURL).hostname);

test.describe("an order link's value and the shape of an order id (#947)",
  () => {
    test("A link whose order value is not in the shape of an order id "
      + "opens the account page as if it carried no order, and none of "
      + "its text appears on the page", async ({ page, context, baseURL }) => {
      await openAccount(page, { context, baseURL }, { orders: [PAID] });

      for (const href of [
        `/account/?order=${encodeURIComponent(FAKE)}`,
        `/account/orders/${encodeURIComponent(FAKE)}/`,
      ]) {
        await page.goto(href);
        await shown(page);
        await expect(page.locator("#acct-orders"), href).toBeVisible();
        await expect(page.locator("#account-flash"), href)
          .not.toContainText("couldn't find order");
        await expect(page.locator("body"), href).not.toContainText("555-0100");
        await expect(page.locator(".is-linked"), href).toHaveCount(0);
      }
    });

    test("A link with a well-formed id that matches no order of the "
      + "session still says the order could not be found, naming that id",
    async ({ page, context, baseURL }) => {
      await openAccount(page, { context, baseURL }, { orders: [PAID] });

      for (const id of ["NFF-2611-ZZZZZZ", "NFF-2610-ZZZZ"]) {
        await page.goto(`/account/?order=${id}`);
        await shown(page);
        await expect(page.locator("#account-flash"), id).toHaveText(
          `We couldn't find order ${id} on this account. Here's `
          + "everything you've ordered."
        );
      }
    });

    test("The staging run checks that /account/orders/ followed by an "
      + "encoded CR and LF, an encoded //host, and an encoded & and # each "
      + "redirect to an address that begins /account/?order= and adds no "
      + "header", async ({ request, baseURL }) => {
      test.skip(isLocal(baseURL), "Netlify's own redirect: a deploy only");

      const get = (path) => request.get(path, { maxRedirects: 0 });
      const plain = await get(`/account/orders/${PAID.id}/`);
      const names = new Set(plain.headersArray()
        .map(({ name }) => name.toLowerCase()));

      expect(plain.status(), "the plain link redirects").toBe(302);

      for (const path of [
        "/account/orders/NFF-2611-ABCDEF%0D%0AX-Injected:%201/",
        "/account/orders/NFF-2611-ABCDEF%0D%0A%0D%0A%3Cb%3Ehi%3C/b%3E/",
        "/account/orders/%2F%2Fevil.example/",
        "/account/orders/%2F%2Fevil.example%2Fpath/",
        "/account/orders/NFF-2611-ABCDEF%26email%3Dx%23frag/",
        "/account/orders/%26next%3D%2F%2Fevil.example%23x/",
      ]) {
        const res = await get(path);
        const location = res.headers().location || "";
        const added = res.headersArray()
          .map(({ name }) => name.toLowerCase())
          .filter((name) => !names.has(name));

        expect(res.status(), path).toBe(plain.status());
        expect(location.startsWith("/account/?order="),
          `${path} -> ${JSON.stringify(location)}`).toBe(true);
        expect(location, path).not.toMatch(/[\r\n]/);
        expect(added, `${path} adds no header`).toEqual([]);
        expect(res.headers()["x-injected"], path).toBeUndefined();
      }
    });
  });
