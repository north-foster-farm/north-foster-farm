// Canned answers for the functions a page calls, so a spec can reach
// the signed-in account and the order page's dates on a local build
// as well as on staging, without signing in or creating anything.

import { readFileSync } from "node:fs";

import { allDates } from "../../assets/scripts/order/lib/dates.mjs";
import { buildModel } from "../../assets/scripts/order/lib/events.mjs";
import { parseSchedule } from "../../assets/scripts/order/lib/schedule.mjs";
import {
  addDays, today, weekday,
} from "../../assets/scripts/order/lib/zoned.mjs";

const TERMS = JSON.parse(readFileSync(
  new URL("../../data/delivery.json", import.meta.url), "utf8",
));

export const ACCOUNT_TABS = [
  "orders", "receipts", "address", "settings", "help",
];

export const CUSTOMER = {
  email: "qa-e2e-canned@example.com", name: "Ada Hen", firstName: "Ada",
  lastName: "Hen", phone: "4015550100", avatar: null, discountGroup: null,
  address: null, reminders: {}, marketing: false,
};

export const ORDER = {
  id: "NFF-2609-QA85", status: "paid",
  submittedAt: "2026-09-26T14:00:00.000Z",
  paidAt: "2026-09-26T14:00:05.000Z", cancelRequested: false,
  lines: [{
    sku: "NFF-CHK-EGG-LG", label: "Eggs, Large · Grade A", qty: 2,
    unitPrice: 7, lineTotal: 14,
  }],
  totals: { subtotal: 1400, discountAmount: 0, deliveryFee: 0, total: 1400 },
  code: null,
  customer: {
    firstName: "Ada", lastName: "Hen", phone: "4015550100", contact: "",
  },
  fulfilment: {
    method: "onfarm", date: "2026-10-03", state: "requested",
    onfarm: { window: "10 AM – 12 PM" },
  },
  notes: "",
  payments: [{
    at: "2026-09-26T14:00:05.000Z", amount: 1400, via: "square",
    method: "card", brand: "VISA", last4: "1111",
    receiptUrl: "https://squareupsandbox.com/receipt/preview/qa",
  }],
  refunds: [], returns: [], question: null,
  canCancel: true, canChange: true,
};

// An order for a scheduled pickup, as the account API sends it: the
// drop site's first Saturday, its place derived server side.
export const ORDER_SCHEDULED = {
  ...ORDER,
  id: "NFF-2610-QA86",
  fulfilment: {
    method: "scheduled", occurrence: "VFVQ-261017", date: "2026-10-17",
    state: "requested", onfarm: null,
  },
  pickup: {
    name: "Drop site",
    place: "Village Green, 46 Institute Lane, North Scituate, RI 02857",
    window: "10 – 11 AM", gone: false,
  },
};

// The farm's pickup schedule is an environment setting (W11d), so
// /api/dates answers from a schedule of our own: each weekday of the
// next three weeks, a morning and an afternoon window.
// The scheduled pickups every canned list holds, relative to today so a
// spec runs in any month: a market, a pop-up and the drop site open for
// pickup, one occurrence the farm only attends and one it skips. Each
// lies 2 to 6 days ahead, inside the horizon and before its cutoff.
export const CANNED = {
  market: "MKT2", popUp: "PUP3", drop: "DRP4", attend: "ATN5", skip: "SKP6",
  location: "LCK7",
};

export const cannedSchedule = (now = new Date()) => {
  const start = today(now, TERMS.timeZone);
  const at = (n) => addDays(start, n);
  const series = (code, kind, name, first, over = {}) => ({
    code, kind, name, location: CANNED.location, start: first,
    opens: "10:00", closes: "12:00", ...over,
  });
  const model = buildModel([{
    code: CANNED.location, name: "Town Common", street: "1 Main St",
    city: "Foster", state: "RI", town: "Foster", lat: 41.8, lng: -71.7,
  }], [
    series(CANNED.market, "market", "Canned Market", addDays(at(2), -7)),
    series(CANNED.popUp, "pop-up", "Canned Fair", at(3), { end: at(3) }),
    series(CANNED.drop, "drop-site", "Drop site", at(4)),
    series(CANNED.attend, "market", "Canned Attend", at(5), { end: at(5) }),
    series(CANNED.skip, "market", "Canned Skip", at(6), { end: at(6) }),
  ]);
  const id = (code, n) => `${at(n)} ${code}`;
  const lines = [
    `${id(CANNED.market, 2)} pickup`, `${id(CANNED.popUp, 3)} pickup`,
    `${id(CANNED.drop, 4)} pickup`, `${id(CANNED.attend, 5)} attend`,
    `${id(CANNED.skip, 6)} skip`,
  ];

  return { model, lines, start };
};

export const dates = () => {
  const now = new Date();
  const start = today(now, TERMS.timeZone);
  const days = [];
  const canned = cannedSchedule(now);

  for (let i = 1; i <= 21; i += 1) {
    const day = addDays(start, i);

    if (weekday(day) >= 1 && weekday(day) <= 5) {
      days.push(`${day} 09:00-12:00 13:00-17:00`);
    }
  }

  const parsed = parseSchedule([...days, ...canned.lines].join("\n"));

  return allDates(now, { ...TERMS, model: canned.model },
    Object.assign(parsed.windows, { lines: parsed.lines }));
};

export const cannedDates = (page) => page.route(
  "**/api/dates", (route) => route.fulfill({ json: dates() }),
);

// Signed in as CUSTOMER, with ORDER on the account.
export const signedIn = async (page) => {
  await page.route("**/api/me", (route) => route.fulfill({
    json: { signedIn: true, customer: CUSTOMER },
  }));
  await page.route("**/api/account/orders", (route) => route.fulfill({
    json: { orders: [ORDER] },
  }));
};

// The 404 page sets <base> to the site's address, which in a local or
// branch build is production's, so its styles and scripts would come
// from production (and fail their integrity check from another
// origin). Point it at the site under test instead.
export const keepHome = (page, baseURL) => page.route(
  "**/404.html",
  async (route) => {
    const response = await route.fetch();
    const body = (await response.text()).replace(
      /<base href="[^"]*">/, `<base href="${new URL("/", baseURL).href}">`,
    );

    await route.fulfill({ response, body });
  },
);

// The pages in the built site's sitemap, as paths.
export const sitemap = async (request) => {
  const res = await request.get("/sitemap.xml");

  if (!res.ok()) throw new Error(`/sitemap.xml answered ${res.status()}`);

  return [...(await res.text()).matchAll(/<loc>([^<]+)<\/loc>/g)]
    .map(([, loc]) => new URL(loc).pathname);
};
