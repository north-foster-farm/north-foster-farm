// Canned answers for the functions a page calls, so a spec can reach
// the signed-in account and the order page's dates on a local build
// as well as on staging, without signing in or creating anything.

import { readFileSync } from "node:fs";

import { allDates } from "../../assets/scripts/order/lib/dates.mjs";
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
    sku: "NFF-CHK-EGG-LG", label: "Eggs, large, one dozen", qty: 2,
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

// The farm's pickup schedule is an environment setting (W11d), so
// /api/dates answers from a schedule of our own: each weekday of the
// next three weeks, a morning and an afternoon window.
export const dates = () => {
  const now = new Date();
  const start = today(now, TERMS.timeZone);
  const days = [];

  for (let i = 1; i <= 21; i += 1) {
    const day = addDays(start, i);

    if (weekday(day) >= 1 && weekday(day) <= 5) {
      days.push(`${day} 09:00-12:00 13:00-17:00`);
    }
  }

  return allDates(now, TERMS, parseSchedule(days.join("\n")).windows);
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
