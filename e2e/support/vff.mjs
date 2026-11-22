// A Village Family Fitness member on the order page, for the criteria
// tests of #749 (Group orders, e2e/group-orders.criteria.mjs) and the
// group's specs that choose a round (group-code, group-credit). Nothing
// is saved anywhere, so this runs on a local build as on staging.
//
// The member is canned as the perk revision spec (#717,
// e2e/perk-revision) cans one: /api/me names the group as
// netlify/functions/auth.mjs does (`customer.memberGroup`, `member`,
// `membership`). What the server would add is made by the server's own
// code, never written out here: /api/group's answer from
// group.mjs `groupDates` and lib/groups.mjs `publicGroup`, and a stored
// order as /api/account/orders sends it from lib/account.mjs
// `publicOrder`. The rounds are the group's real ones, from
// data/series.json.

import { publicOrder } from "../../netlify/functions/lib/account.mjs";
import {
  groupOf, publicGroup,
} from "../../netlify/functions/lib/groups.mjs";
import { groupDates } from "../../netlify/functions/group.mjs";
import {
  addDays, today,
} from "../../assets/scripts/order/lib/zoned.mjs";
import terms from "../../netlify/functions/lib/terms.mjs";
import { CUSTOMER, ORDER, dates } from "./canned.mjs";
import { OrderPage, expect } from "./order.mjs";
import { clearSession } from "./staging.mjs";

export const VFF = groupOf("vff");
export const GYM = terms.model.location(VFF.location);
export const SERIES = VFF.series;

// The approved name of the fourth fulfillment type (#749 item 1).
export const GROUP_ORDERS = "Group orders";

// A schedule line, so the group's dates are worked out without the
// error an empty PICKUP_SCHEDULE logs. Group rounds need none.
const envFor = (now) => ({
  PICKUP_SCHEDULE: `${addDays(today(now, terms.timeZone), 1)} 09:00-12:00`,
});

// The group's open rounds at `now`, as /api/group lists them.
export const rounds = (now = new Date()) => groupDates(VFF, now, envFor(now))
  .map((d) => ({ ...d, name: VFF.name }));

// /api/group's answer for the signed-in member (group.mjs `handle`).
export const groupAnswer = (now = new Date()) => {
  const group = publicGroup(VFF);

  group.places.series = group.places.series
    .map((s) => ({ ...s, name: VFF.name }));

  return {
    ok: true, group, dates: rounds(now), credit: 0, already: false,
    elsewhere: false,
  };
};

// /api/me for a member and for a customer in no group.
export const MEMBER = {
  signedIn: true, membership: true,
  customer: { ...CUSTOMER, memberGroup: VFF.key, perks: [] },
  member: { key: VFF.key, name: VFF.name, credit: 0 },
};
export const NON_MEMBER = {
  signedIn: true, customer: { ...CUSTOMER, perks: [] },
};

// Orders as the account API sends them, from a stored record.
const stored = (id, fulfilment) => publicOrder({
  ...ORDER, id, fulfilment,
  group: { key: VFF.key, round: fulfilment.date, viaCode: false },
}, new Date());

// A member's order at the group's next round, placed under Pick-up
// days before #749.
export const roundOrder = (now = new Date()) => {
  const [round] = rounds(now);

  return stored("NFF-2611-QA87", {
    method: "scheduled", occurrence: round.occurrence, date: round.date,
    state: "requested", onfarm: null,
  });
};

// A member's delivery to the gym, stored with `toGroup` as
// validateOrder wrote it (#471) before #626 parked the option, on
// `date`.
export const gymOrder = (date) => stored("NFF-2611-QA88", {
  method: "delivery", date, state: "requested", onfarm: null,
  delivery: {
    address1: GYM.street, address2: "", town: GYM.city, state: "RI",
    zip: GYM.zip, cooler: `The cooler at ${GYM.name}`, notes: "",
    zipStatus: "approved", toGroup: true,
  },
});

let stamps = 0;

// Signed in with `me` as /api/me's answer (signed out with null), the
// dates canned (`lists`, canned.mjs `dates()` by default) and, for a
// member, /api/group answered for `now`. `orders` is the account's
// list, and `group` /api/group's answer (groupAnswer(now) by default).
// Each sign-in takes a new session stamp, as #717's spec does, so the
// session's cache never answers with the last test's account.
export const signIn = async (page, baseURL, me, {
  orders = [], lists = dates(), now = new Date(), group = groupAnswer(now),
} = {}) => {
  await page.goto("about:blank");
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await clearSession(page.context());
  await page.route("**/api/dates", (route) => route.fulfill({ json: lists }));
  if (!me) return;
  stamps += 1;
  await page.context().addCookies([
    { name: "nff_signed_in", value: `vff${stamps}`, url: baseURL },
  ]);
  await page.route("**/api/me", (route) => route.fulfill({ json: me }));
  await page.route("**/api/account/cart", (route) => route.fulfill({
    json: { ok: true, cart: null },
  }));
  await page.route("**/api/account/orders", (route) => route.fulfill({
    json: { orders },
  }));
  if (me.customer && me.customer.memberGroup) {
    await page.route("**/api/group", (route) => route.fulfill({
      json: group,
    }));
  }
};

// The order page with `cart`, once a member's group has come.
export const openOrder = async (page, me, cart = { whole: 2 }) => {
  const member = !!(me && me.customer && me.customer.memberGroup);
  const group = member
    ? page.waitForResponse((r) => r.url().includes("/api/group"))
    : null;
  const order = new OrderPage(page);

  await order.open(cart);
  if (group) await group;
  // The page folds the group in after the answer.
  await order.scrollSettled();

  return order;
};

// A radio the page draws over a card: its label is what a customer
// presses.
export const pick = async (page, radio) => {
  const id = await radio.getAttribute("id");
  const label = id ? page.locator(`label[for='${id}']`) : null;

  if (label && await label.count()) await label.first().click();
  else await radio.check();
  await expect(radio).toBeChecked();
};

// The way to get the order named `name`, among the fulfillment types
// (`#pickup`'s radios of name "method").
export const way = (page, name) => page.locator("#pickup")
  .getByRole("radio", { name, exact: true });

// What a way's radio reveals: its `[data-method-body]`, keyed by the
// radio's value as the three ways' bodies are.
export const bodyOf = async (page, radio) => page.locator(
  `[data-method-body='${await radio.getAttribute("value")}']`
);

// The way chosen: the one checked radio of `#pickup`'s ways, whether
// or not the page offers Group orders.
export const chosenWay = (page) => page.locator(
  "#pickup input[name='method']:checked"
);

// One of today's three ways by its value: onfarm, scheduled (Pick-up
// days) or delivery.
export const methodRadio = (page, value) => page.locator(`#method-${value}`);

// Chooses a way: Group orders by its name, any of today's three by its
// value. -> its body
export const choose = async (order, name) => {
  const radio = name === GROUP_ORDERS ? way(order.page, name)
    : methodRadio(order.page, name);

  await expect(radio, `the "${name}" way`).toHaveCount(1);
  await order.scrollSettled();
  await pick(order.page, radio);

  return bodyOf(order.page, radio);
};

// The values of the radios in `body`: for Pick-up days and Group
// orders, occurrence ids, "<series>-<YYMMDD>".
export const radioValues = (body) => body.locator("input[type='radio']")
  .evaluateAll((els) => els.map((el) => el.value));
