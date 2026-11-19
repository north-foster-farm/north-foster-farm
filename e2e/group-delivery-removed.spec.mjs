// Criteria tests for #626: the "Deliver to <group>" option (#471) comes
// off the order page and is parked. Written from the spec before the
// change, so they fail until it lands. A member signed in is the one
// customer the option was ever offered to, so each test signs one in
// (the back office makes the member) and waits for the page to unlock
// their group before it looks. Runs on the local build with fake
// payments and on staging; places no order.

import groupData from "../data/groups.json" with { type: "json" };
import locationData from "../data/locations.json" with { type: "json" };
import { OrderPage, expect, test, uniqueEmail } from "./support/order.mjs";
import {
  BACK_OFFICE_MISSING, backOffice, clearSession, op, teardown,
} from "./support/staging.mjs";
import { followLink } from "./support/request-error.mjs";

const GROUP = "vff";
const GYM = locationData.locations.find((l) => l.code
  === groupData.groups.find((g) => g.key === GROUP).location);
const COOLER = "Left in the cooler";
const OFFER = `Deliver to ${GYM.name}`;

// Signs a new member of the group in. -> their email address
const member = async (context, page, tag, made) => {
  const email = uniqueEmail(tag);

  made.push(email);
  await op("customerJoin", { email, key: GROUP });
  await clearSession(context);
  await followLink(page, (await op("login", { email })).url);
  await expect(page.locator("#account-app")).toBeVisible();

  return email;
};

// Resolves once the order page has the member's group: /api/group
// answers with it, and the page unlocks it.
const unlocked = (page) => page.waitForResponse(async (r) => {
  if (!r.url().includes("/api/group") || r.request().method() !== "POST") {
    return false;
  }

  const data = await r.json().catch(() => null);

  return !!(data && data.group);
});

// Neither the option nor its line is anywhere on what the page holds:
// shown, hidden or in a template.
const neitherIn = (html, where) => {
  expect(html, `${where}: the option's line`).not.toContain(COOLER);
  expect(html, `${where}: the option's field`).not.toContain(
    "delivery.toGroup");
  expect(html, `${where}: the option's checkbox`).not.toContain(
    "delivery-to-group");
  expect(html, `${where}: the option`).not.toContain(OFFER);
};

test.describe("the group delivery option is gone (#626)", () => {
  test.skip(!backOffice().ready, BACK_OFFICE_MISSING);

  const made = [];

  test.beforeAll(() => op("groupCode", { key: GROUP }));

  test.afterAll(() => teardown(made.map((email) => () =>
    op("customerDelete", { email }, { allowFail: true }))));

  test("no Deliver to <group> option or Left in the cooler text is " +
    "offered anywhere a customer chooses delivery",
  async ({ page, context }) => {
    await member(context, page, "nogroupdelivery", made);

    // The account page, where Change delivery is.
    neitherIn(await page.content(), "account page");

    // The built page as served, which every way into the order page
    // shares: a new order, a restored draft, a change to a paid order
    // (?edit=) and the lapsed dialog (partials/order/lapsed.html).
    const served = await page.request.get("/order/");

    expect(served.ok()).toBe(true);
    neitherIn(await served.text(), "built /order/");

    // The order page for the member, their group unlocked, delivery
    // chosen.
    const order = new OrderPage(page);
    const group = unlocked(page);

    await order.open({ whole: 3 });
    await group;
    await order.method("delivery");
    await expect(page.locator("#delivery-address1")).toBeVisible();

    await expect(page.getByRole("checkbox", { name: /Deliver to/ }))
      .toHaveCount(0);
    await expect(page.getByText(COOLER)).toHaveCount(0);
    neitherIn(await page.content(), "order page, member, delivery");
    // The address is the customer's to type, as anyone's.
    for (const id of ["address1", "town", "zip"]) {
      await expect(page.locator(`#delivery-${id}`)).toBeEditable();
    }
  });

  test("a saved cart or draft with the option ticked loads as an " +
    "ordinary delivery", async ({ page, context }) => {
    const email = await member(context, page, "tickeddraft", made);

    // The draft as the page saved it at launch, ticked: the address
    // fields filled from the group's place.
    await page.addInitScript(({ saved, place }) => {
      if (localStorage.getItem("nff-order-draft")) return;
      localStorage.setItem("nff-order-draft", JSON.stringify({
        savedAt: Date.now(),
        payload: {
          lines: [{ sku: "NFF-CHK-WHL-35-39", qty: 3 }],
          customer: { firstName: "Tick", lastName: "Draft", email: saved },
          fulfilment: {
            method: "delivery",
            delivery: {
              toGroup: true, address1: place.street, address2: "",
              town: place.city, zip: place.zip,
              cooler: `The cooler at ${place.name}`, notes: "",
            },
          },
        },
      }));
    }, { saved: email, place: GYM });

    const order = new OrderPage(page);
    const group = unlocked(page);

    await order.open();
    await group;

    // What the customer sees: delivery chosen, as saved, with nothing
    // ticked and the address fields empty and theirs to type.
    await expect(page.locator("#method-delivery")).toBeChecked();
    await expect(page.locator("#delivery-address1")).toBeVisible();
    await expect(page.getByRole("checkbox", { name: /Deliver to/ }))
      .toHaveCount(0);
    for (const id of ["address1", "town", "zip"]) {
      const field = page.locator(`#delivery-${id}`);

      await expect(field).toHaveValue("");
      await expect(field).toBeEditable();
    }
    await expect(page.locator("#delivery-cooler"))
      .not.toHaveValue(new RegExp(GYM.name));
    neitherIn(await page.content(), "order page, ticked draft");
  });
});
