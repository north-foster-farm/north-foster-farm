// An order on a Thursday the schedule has replaced keeps its date
// (#643), on the order page and in the account's Change delivery. The
// farm has moved December's week to Wednesday the 9th
// (`2026-12-09 delivery`); the order was placed for Thursday the 10th
// before the move. Criteria tests, written before the change; the
// contract, including what "marked as such" means, is in
// test/kept-thursday.criteria.mjs, and the server's rule in
// test/kept-thursday-server.test.mjs.
//
// The account's endpoints are canned, as in missed-delivery.spec.mjs,
// so this runs on a local build as on staging and saves nothing.
// /api/dates is answered as the server would answer with the move:
// the real lib/dates.mjs over the parsed line, and the server's clock,
// which the page anchors to. A change is answered as lib/edit.mjs
// answers it, and after the cutoff with its refusal.

import { readFileSync } from "node:fs";

import { CUSTOMER, ORDER, dates } from "./support/canned.mjs";
import { SKU, expect, test } from "./support/order.mjs";
import { deliveryDates } from "../assets/scripts/order/lib/dates.mjs";
import { parseSchedule } from "../assets/scripts/order/lib/schedule.mjs";
import { instant } from "../assets/scripts/order/lib/zoned.mjs";

const TERMS = JSON.parse(readFileSync(
  new URL("../data/delivery.json", import.meta.url), "utf8",
));
const ny = (iso, h, m = 0) => instant(iso, h, m, "America/New_York");
const KEPT = "2026-12-10";
// A week before: the 9th and the 17th are on offer.
const DEC_3 = ny("2026-12-03", 9);
// Two minutes before the 10th's cutoff, noon on the 9th, and after it.
const BEFORE_CUTOFF = ny("2026-12-09", 11, 58);
const AFTER_CUTOFF = ny("2026-12-09", 12, 3);

// $56 of eggs and the $5 fee, for delivery on Thursday the 10th.
const ON_KEPT = {
  ...ORDER,
  id: "NFF-2612-QA43",
  submittedAt: "2026-12-01T14:00:00.000Z",
  paidAt: "2026-12-01T14:00:05.000Z",
  lines: [{ ...ORDER.lines[0], qty: 8, lineTotal: 56 }],
  totals: { subtotal: 5600, discountAmount: 0, deliveryFee: 500,
    total: 6100 },
  fulfilment: {
    method: "delivery", date: KEPT, state: "agreed", onfarm: null,
    delivery: { address1: "1 Main St", town: "Foster", zip: "02825",
      cooler: "Porch" },
  },
  payments: [{ ...ORDER.payments[0], at: "2026-12-01T14:00:05.000Z",
    amount: 6100 }],
  keptFee: 0,
  keptDate: null,
};

// /api/dates at `now` with the move. No pickups: their canned days
// follow today's date, not this clock, and a pickup whose cutoff is
// already behind the clock would refresh the lists every second.
const answer = (now) => {
  const schedule = Object.assign([], {
    lines: [], deliveries: parseSchedule("2026-12-09 delivery").deliveries,
  });

  return {
    ...dates(),
    now: now.toISOString(),
    onfarm: [],
    scheduled: [],
    delivery: deliveryDates(now, TERMS, undefined, schedule),
  };
};

// Signed in with the order on the account, the dates at `clock.now`,
// and every change the page sends kept in `sent`. -> { clock, sent }
const setUp = async (page, context, baseURL, now) => {
  const clock = { now };
  const sent = [];

  await context.addCookies([{
    name: "nff_signed_in", value: "1", url: baseURL,
  }]);
  await page.route("**/api/me", (route) => route.fulfill({
    json: { signedIn: true, customer: CUSTOMER },
  }));
  await page.route("**/api/account/orders", (route) => route.fulfill({
    json: { orders: [ON_KEPT] },
  }));
  await page.route("**/api/account/cart", (route) => route.fulfill({
    json: { ok: true, cart: null },
  }));
  await page.route("**/api/dates",
    (route) => route.fulfill({ json: answer(clock.now) }));
  await page.route(`**/api/account/orders/${ON_KEPT.id}/*`,
    async (route) => {
      const body = route.request().postDataJSON();

      sent.push(body);
      // The functions (lib/edit.mjs, lib/account.mjs) refuse any change
      // once the order's cutoff has passed.
      if (clock.now.getTime() >= ny("2026-12-09", 12).getTime()) {
        await route.fulfill({ status: 409, json: {
          ok: false, errors: { order: "This order can't be changed any more." },
        } });

        return;
      }
      await route.fulfill({ json: { ok: true, order: ON_KEPT } });
    });

  return { clock, sent };
};

// The order page, changing the order, with its dates in.
const openEdit = async (page) => {
  await page.goto(`/order/?edit=${ON_KEPT.id}`, {
    waitUntil: "domcontentloaded",
  });
  await expect(page.locator("[data-edit-money] [data-total='paid']"))
    .toHaveText("$61");
  await expect(page.locator("#delivery-date")).toBeEnabled();
};

// Seven dozen for eight, so nothing is due and Save changes sends it.
const fewerEggs = async (page) => {
  const qty = page.locator(`[data-qty="${SKU.eggs}"]`);

  await expect(qty).toHaveValue("8");
  await qty.fill("7");
  await qty.blur();
};

const datesSent = (sent) => sent.map((b) => b.fulfilment && b.fulfilment.date);

test.describe("an order on a replaced Thursday, on the order page (#643)",
  () => {
    test("keeps the order's Thursday in the list, marked as booked, " +
      "until its cutoff", async ({ page, context, baseURL }) => {
      await setUp(page, context, baseURL, DEC_3);
      await openEdit(page);

      const select = page.locator("#delivery-date");
      const options = await select.locator("option").evaluateAll((list) =>
        list.map((o) => [o.value, o.textContent.trim()]));

      await expect(select).toHaveValue(KEPT);
      expect(options).toContainEqual([KEPT,
        "Thursday, December 10 (as booked)"]);
      expect(options.map(([value]) => value))
        .toEqual(expect.arrayContaining(["2026-12-09", "2026-12-17"]));
      expect(options.filter(([value]) => value !== KEPT)
        .every(([, text]) => !text.includes("(as booked)")),
      "no day on offer is marked").toBe(true);
    });

    test("sends the order's Thursday when only the quantities change",
      async ({ page, context, baseURL }) => {
        const { sent } = await setUp(page, context, baseURL, DEC_3);

        await openEdit(page);
        await fewerEggs(page);
        await page.locator("#order-save").click();
        await expect.poll(() => sent.length,
          "Save changes sent the change").toBeGreaterThan(0);
        expect(datesSent(sent)).toEqual([KEPT]);
      });

    test("sends another day on offer when the customer chooses it",
      async ({ page, context, baseURL }) => {
        const { sent } = await setUp(page, context, baseURL, DEC_3);

        await openEdit(page);
        await page.locator("#delivery-date").selectOption("2026-12-17");
        await fewerEggs(page);
        await page.locator("#order-save").click();
        await expect.poll(() => sent.length,
          "Save changes sent the change").toBeGreaterThan(0);
        expect(datesSent(sent)).toEqual(["2026-12-17"]);
      });

    test("says the day has passed and which days are on offer, after its " +
      "cutoff", async ({ page, context, baseURL }) => {
      await page.clock.install({ time: BEFORE_CUTOFF });

      const { clock, sent } = await setUp(page, context, baseURL,
        BEFORE_CUTOFF);

      await openEdit(page);
      await fewerEggs(page);
      // The page stays open past noon on the 9th.
      clock.now = AFTER_CUTOFF;
      await page.clock.runFor(AFTER_CUTOFF - BEFORE_CUTOFF);
      await page.locator("#order-save").click();

      const dialog = page.locator("#order-lapsed");

      await expect(dialog).toBeVisible();
      await expect(dialog.locator("#order-lapsed-title"))
        .toHaveText("That delivery day is no longer available");

      const list = dialog.locator("[data-lapsed-list]");

      await expect(list).toContainText("Thursday, December 17");
      await expect(list).not.toContainText("December 10");
      expect(datesSent(sent).filter((date) => date !== KEPT),
        "no other day was sent in its place").toEqual([]);
    });
  });

test.describe("an order on a replaced Thursday, in the account (#643)",
  () => {
    test("Change delivery keeps the order's Thursday, marked as booked",
      async ({ page, context, baseURL }) => {
        const { sent } = await setUp(page, context, baseURL, DEC_3);

        await page.goto("/account/#orders");
        await page.getByRole("button", { name: "Change delivery" }).first()
          .click();

        const panel = page.locator("[data-out='panel']:visible");
        const select = panel.locator("select[name='date']");

        await expect(select).toHaveValue(KEPT);
        await expect(select.locator("option:checked")).toHaveText(
          "Delivery, Thursday, December 10 (as booked)",
        );
        await expect(select.locator("option[value='2026-12-09']"))
          .toBeAttached();
        await panel.getByRole("button", { name: "Save changes" }).click();
        await expect.poll(() => sent.length,
          "Save changes sent the change").toBe(1);
        expect(sent[0].date).toBe(KEPT);
      });
  });
