// Criteria test for #772 (A group's host counts as a member, unlisted),
// the page's half of its first box, named for it. The server's half,
// and the other three boxes, are test/host-member.criteria.mjs. Held
// out of every run by its name until the change lands: renamed to
// host-member.spec.mjs, it runs.
//
// The host is a customer whose email address is the group record's
// `host` (lib/groups.mjs `setGroupHost`) and whose record has no
// `memberGroup`. Nothing of what the server says of them is canned:
// /api/me and /api/group are answered by the server's own handlers
// (auth.mjs and group.mjs `handle`), run here against an in-memory
// store (lib/store.mjs `testStores`) that holds the host, their
// session and the group's record. The member they are compared with
// is e2e/support/vff.mjs's, canned as #749's specs can one. Nothing
// is saved anywhere, so this runs on a local build as on staging.
//
// The seam, what the test relies on:
// - the page learns who is signed in from /api/me and the group, its
//   rounds and its member prices from POST /api/group, and asks the
//   latter when /api/me says the customer is in a group;
// - Group orders and its rounds are as e2e/group-orders.spec.mjs reads
//   them (vff.mjs `way`, `choose`, `radioValues`);
// - the member's line and prices are in the cart, `#order-cart`, its
//   line `[data-cart-perks]` (#717).

import { handle as authHandle } from "../netlify/functions/auth.mjs";
import { handle as groupHandle } from "../netlify/functions/group.mjs";
import { createSession } from "../netlify/functions/lib/auth.mjs";
import {
  memberKeyOf, setGroupCode, setGroupHost,
} from "../netlify/functions/lib/groups.mjs";
import {
  getCustomer, saveCustomer,
} from "../netlify/functions/lib/records.mjs";
import { testStores } from "../netlify/functions/lib/store.mjs";
import terms from "../netlify/functions/lib/terms.mjs";
import {
  addDays, today,
} from "../assets/scripts/order/lib/zoned.mjs";
import { dates } from "./support/canned.mjs";
import { OrderPage, expect, settleCart, test } from "./support/order.mjs";
import {
  GROUP_ORDERS, MEMBER, VFF, choose, openOrder, radioValues, rounds,
  signIn, way,
} from "./support/vff.mjs";

const HOST = "qa-e2e-host@example.com";
const CART = { whole: 2 };

// A schedule line, as vff.mjs gives /api/group, so the group's dates
// are worked out without the error an empty PICKUP_SCHEDULE logs.
const envFor = (now) => ({
  PICKUP_SCHEDULE: `${addDays(today(now, terms.timeZone), 1)} 09:00-12:00`,
});

// The group's host, in a store of their own: the group's record names
// them, their customer record names no group.
const hostStore = async (now) => {
  const stores = testStores();

  await setGroupCode(stores, VFF.key, { code: "GYM-2026", now });
  await setGroupHost(stores, VFF.key, HOST, { now });
  await saveCustomer(stores, { email: HOST, firstName: "Hal",
    lastName: "Example", name: "Hal Example", phone: "4015550100" });

  const session = await createSession(stores, HOST, { now });

  return { stores, cookie: `nff_session=${session.id}` };
};

// The page's request, passed to a server handler with the host's
// session, and the handler's answer fulfilled back to the page.
const serve = (handler, { stores, cookie, now }) => async (route) => {
  const req = route.request();
  const body = req.method() === "GET" ? undefined : req.postData() || "{}";
  const res = await handler(new Request(req.url(), {
    method: req.method(),
    headers: {
      "Content-Type": "application/json", "sec-fetch-site": "same-origin",
      cookie,
    },
    body,
  }), { stores, now, env: envFor(now) });

  await route.fulfill({
    status: res.status,
    contentType: "application/json",
    body: await res.text(),
  });
};

// Signed in as the host, the server answering for them; the dates and
// the account's cart and orders canned as vff.mjs `signIn` cans them.
const signInHost = async (page, baseURL, host) => {
  // The member's cart, which had no owner, would carry into the host's
  // page as any signed-out cart does, under the host's own ?add=: the
  // site's storage starts empty, as it would in the host's browser.
  await page.evaluate(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
  await page.goto("about:blank");
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await page.context().clearCookies();
  await page.route("**/api/dates", (route) => route.fulfill({
    json: dates(),
  }));
  await page.context().addCookies([
    { name: "nff_signed_in", value: `host${Date.now()}`, url: baseURL },
  ]);
  await page.route("**/api/me", serve(authHandle, host));
  await page.route("**/api/group", serve(groupHandle, host));
  await page.route("**/api/account/cart", (route) => route.fulfill({
    json: { ok: true, cart: null },
  }));
  await page.route("**/api/account/orders", (route) => route.fulfill({
    json: { orders: [] },
  }));
};

// What a signed-in customer sees of the group on the order page: the
// cart's member line and prices, and Group orders' rounds.
const groupView = async (page, order) => {
  await settleCart(order);

  const cart = await page.locator("#order-cart").innerText();
  const perks = await page.locator("#order-cart [data-cart-perks]")
    .innerText();
  const body = await choose(order, GROUP_ORDERS);

  return { cart, perks, rounds: (await radioValues(body)).sort() };
};

test.describe("A group's host counts as a member (#772)", () => {
  test("A group's host, signed in, sees Group orders with the group's " +
    "open rounds and the member prices on the order page, as a member " +
    "does, with no membership on their own record", async ({
    page, baseURL,
  }) => {
    const now = new Date();
    const open = rounds(now).map((d) => d.occurrence).sort();

    expect(open.length, "the group has a round open").toBeGreaterThan(0);

    // A member, as #749's specs see one.
    await signIn(page, baseURL, MEMBER, { now });

    const asMember = await groupView(page,
      await openOrder(page, MEMBER, CART));

    expect(asMember.rounds, "a member's rounds").toEqual(open);

    // The host, with no membership on their record.
    const host = { ...(await hostStore(now)), now };

    expect(memberKeyOf(await getCustomer(host.stores, HOST)),
      "no membership on the host's record").toBeNull();
    await signInHost(page, baseURL, host);

    const order = new OrderPage(page);

    await order.open(CART);
    await expect(way(page, GROUP_ORDERS), "the host has Group orders")
      .toHaveCount(1);
    await order.scrollSettled();

    const asHost = await groupView(page, order);

    expect(asHost.rounds, "the group's open rounds").toEqual(open);
    expect(asHost.perks, "the member line").toContain(VFF.perk.line);
    expect(asHost.perks, "as a member's").toBe(asMember.perks);
    expect(asHost.cart, "the member prices, as a member's")
      .toBe(asMember.cart);
    expect(memberKeyOf(await getCustomer(host.stores, HOST)),
      "still none: derived, never written").toBeNull();
  });
});
