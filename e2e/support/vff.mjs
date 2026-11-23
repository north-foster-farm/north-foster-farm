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
import { isChallenge } from "./challenge.mjs";
import { answerAccount, clearSession } from "./staging.mjs";

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
  await answerAccount(page.context(), !!me);
  if (!me) return;
  stamps += 1;
  await page.context().addCookies([
    { name: "nff_signed_in", value: `vff${stamps}`, url: baseURL },
  ]);
  stamped.set(page, (await page.context().cookies())
    .some((c) => c.name === "nff_signed_in"));
  // With or without a query string.
  await page.route(/\/api\/me(?:[?#]|$)/, (route) => route.fulfill({
    json: me,
  }));
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

// What the page did, for a staging run that keeps no trace (#729,
// qa's triage of run 45134992415; run 45144961061 found the stamp
// gone before the order page started): each main-frame navigation
// and each of the site's /api/ and /scripts/ responses, by method,
// path and status, and whether it was Netlify's bot challenge; the
// page's errors and console errors, by a known kind and source path
// alone; whether signIn's jar held the stamp right after adding it;
// whether each document saw the stamp as it started; the cookies'
// names and the storage keys; and what the page's /api/me answers
// said, as flags. Never a message's text, which can quote a URL's
// query or a field's value: no cookie value, token, query, body or
// address.
// Whether the jar held the stamp right after signIn added it, by page.
const stamped = new WeakMap();
// Each document's path and whether it saw the stamp as it started,
// kept in sessionStorage so a reload (a challenge's) keeps the list.
const STARTS = "nff-e2e-stamp-at-start";
const noteStart = (key) => {
  try {
    const list = JSON.parse(sessionStorage.getItem(key) || "[]");

    list.push([location.pathname,
      /(?:^|;\s*)nff_signed_in=[^;]/.test(document.cookie)]);
    sessionStorage.setItem(key, JSON.stringify(list.slice(-20)));
  } catch {
    // Storage blocked: nothing to note.
  }
};
// The kinds of console error that may be printed; any other text,
// which could begin with a name ("Pat Example: ..."), prints as error.
const KINDS = ["Failed to load resource", "Uncaught TypeError",
  "Uncaught ReferenceError", "Uncaught SyntaxError", "Uncaught Error",
  "TypeError", "ReferenceError", "SyntaxError", "RangeError", "Error"];
const kindOf = (text) => KINDS.find((k) => String(text).startsWith(`${k}:`))
  || "error";
const nameOf = (e) => (/^[A-Za-z]{1,40}$/.test(String(e && e.name))
  ? e.name : "Error");
const pathOf = (url) => {
  try {
    return new URL(url).pathname;
  } catch {
    return "";
  }
};
// The first frame of a stack that names a URL: its path and line.
const frameOf = (stack) => {
  const m = String(stack || "").match(/(https?:[^\s)]+?):(\d+):\d+/);

  return m ? `${pathOf(m[1])}:${m[2]}` : "";
};
const watchPage = (page) => {
  const seen = [];
  const add = (line) => {
    if (seen.length < 200) seen.push(line);
  };
  const onResponse = async (r) => {
    const url = new URL(r.url());
    const nav = r.request().isNavigationRequest()
      && r.frame() === page.mainFrame();

    // Main-frame documents, and the site's own calls and scripts, not
    // the payment SDKs'.
    if (!nav && !/^\/(api|scripts)\//.test(url.pathname)) return;
    let note = nav ? " document" : "";

    if (url.pathname === "/api/me") {
      const body = await r.json().catch(() => null);

      note = body ? ` signedIn=${!!body.signedIn} memberGroup=${
        !!(body.customer && body.customer.memberGroup)} member=${
        !!body.member}` : " unread";
    }
    if (r.status() === 403) {
      const body = await r.text().catch(() => "");

      if (isChallenge(403, body)) note += " challenge";
    }
    add(`${r.request().method()} ${url.pathname} ${r.status()}${note}`);
  };
  const onError = (e) => add(`pageerror ${nameOf(e)} ${frameOf(e.stack)}`);
  const onConsole = (m) => {
    if (m.type() !== "error") return;

    const where = m.location() || {};
    const kind = kindOf(m.text());

    add(`console ${kind} ${pathOf(where.url)}:${where.lineNumber ?? ""}`);
  };

  page.on("response", onResponse);
  page.on("pageerror", onError);
  page.on("console", onConsole);
  // Every document from here on notes the stamp as it starts.
  const started = page.addInitScript(noteStart, STARTS).catch(() => {});

  const stop = () => {
    page.off("response", onResponse);
    page.off("pageerror", onError);
    page.off("console", onConsole);
  };
  const gather = async () => ({
    stampAfterSignIn: stamped.has(page) ? stamped.get(page) : null,
    cookies: (await page.context().cookies()).map((c) => c.name),
    starts: await page.evaluate((key) => {
      try {
        return JSON.parse(sessionStorage.getItem(key) || "[]")
          .map(([path, seen]) => [String(path), !!seen]);
      } catch {
        return null;
      }
    }, STARTS),
    state: await page.evaluate(() => ({
      stamp: /(?:^|;\s*)nff_signed_in=[^;]/.test(document.cookie),
      session: Object.keys(sessionStorage),
      local: Object.keys(localStorage),
      prompt: !!document.querySelector("[data-signin-prompt]:not([hidden])"),
    })),
  });

  // -> what was seen. Never throws and never takes more than 5 s, so
  // the error it reports on is the one rethrown: a closed page or a
  // stuck one leaves only what the listeners saw.
  const report = async () => {
    stop();

    let timer;
    const late = new Promise((resolve) => {
      timer = setTimeout(() => resolve({ late: true }), 5_000);
    });
    const more = await Promise.race([gather(), late])
      .catch(() => ({ closed: true }));

    clearTimeout(timer);

    return { seen, ...more };
  };

  return { started, stop, report };
};

// The order page with `cart`, once a member's group has come.
export const openOrder = async (page, me, cart = { whole: 2 }) => {
  const member = !!(me && me.customer && me.customer.memberGroup);
  const group = member
    ? page.waitForResponse((r) => r.url().includes("/api/group"))
    : null;
  const order = new OrderPage(page);
  const watch = watchPage(page);

  await watch.started;
  try {
    await order.open(cart);
    if (group) await group;
  } catch (error) {
    // Never in place of the error it reports on.
    try {
      console.log(`openOrder diagnostics: ${
        JSON.stringify(await watch.report())}`);
    } catch {
      // Nothing more to say.
    }
    throw error;
  }
  watch.stop();
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
