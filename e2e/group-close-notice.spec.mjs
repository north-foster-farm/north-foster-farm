// Criteria tests for #749's two "Close notice" boxes (James,
// 2026-11-23, wording approved final), in the browser: the Group
// orders close notice matches the delivery countdown exactly, with
// "for delivery" becoming "to join the current group order", a live
// countdown, and the round's date at the end. His example: "Order
// within 12 days, 20 hours, and 26 minutes to join the current group
// order on Sunday, December 6." They fail until the notice changes.
// Every form of the count, singular and plural, is held in
// test/group-close-notice.criteria.mjs; here the page shows it and its
// clock runs it down.
//
// The clock: the page's is installed at `now`, and /api/dates and
// /api/group are answered for that `now` (support/vff.mjs signIn),
// which the page anchors to. Each `now` sits 30 s past a whole minute
// of the count, so the page's own seconds never take a minute off.
// The round is the group's real next one (data/series.json), Sunday 6
// December 2026, its orders closing 11:59 PM the Saturday before.
// No order is placed.
//
// The seam: Group orders' body is what its radio reveals (support/
// vff.mjs `choose`); the notice is the one line in it that begins
// "Order within", and Delivery's is its [data-countdown-text].

import { readFileSync } from "node:fs";

import { expect, test } from "./support/order.mjs";
import {
  GROUP_ORDERS, MEMBER, choose, openOrder, rounds, signIn,
} from "./support/vff.mjs";
import { dates } from "./support/canned.mjs";
import { deliveryDates } from "../assets/scripts/order/lib/dates.mjs";

const TERMS = JSON.parse(readFileSync(
  new URL("../data/delivery.json", import.meta.url), "utf8",
));

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const ROUND = "Sunday, December 6";
const CUTOFF = Date.parse("2026-12-06T04:59:00.000Z");

// `d` days, `h` hours and `m` minutes (and 30 s) before the round's
// orders close.
const before = (d, h, m) => new Date(CUTOFF - d * DAY - h * HOUR
  - m * MINUTE - 30_000);

const sentence = (count) =>
  `Order within ${count} to join the current group order on ${ROUND}.`;

const installed = new WeakSet();

// The order page for a member at `now`, Group orders chosen, its
// clock installed (once a page) and running. -> Group orders' body
const groupOrdersAt = async (page, baseURL, now) => {
  if (installed.has(page)) {
    await page.clock.setSystemTime(now);
  } else {
    await page.clock.install({ time: now });
    installed.add(page);
  }
  const canned = dates();

  await signIn(page, baseURL, MEMBER, {
    now,
    lists: {
      ...canned, now: now.toISOString(),
      // The canned Pick-up days are built for today, so a `now` days
      // on would hold cutoffs already passed, which /api/dates never
      // sends (lib/dates.mjs keeps a cutoff not before `now`). Kept,
      // the page refreshes the lists a second after each one and takes
      // `now` again from every answer, holding its clock there.
      scheduled: canned.scheduled.filter((d) =>
        now.getTime() <= Date.parse(d.cutoff)),
      delivery: deliveryDates(now, TERMS),
    },
  });

  const [round] = rounds(now);

  expect(round.label, "the round counted down to").toBe(ROUND);
  expect(Date.parse(round.cutoff), "its orders close").toBe(CUTOFF);

  const order = await openOrder(page, MEMBER);

  return choose(order, GROUP_ORDERS);
};

const notice = (body) => body.getByText(/^\s*Order within /u);

test.describe("#749 close notice", () => {
  test("Close notice (James, 2026-11-23, wording approved final): the "
    + "Group orders close notice matches the delivery countdown "
    + "exactly, with \"for delivery\" becoming \"to join the current "
    + "group order\", a live countdown, and the round's date at the "
    + "end. Example: \"Order within 12 days, 20 hours, and 26 minutes "
    + "to join the current group order on Sunday, December 6.\"",
  async ({ page, baseURL }) => {
    const body = await groupOrdersAt(page, baseURL, before(12, 20, 26));
    const line = notice(body);

    await expect(line, "the close notice").toHaveCount(1);
    await expect(line).toBeVisible();
    await expect(line).toHaveText(sentence(
      "12 days, 20 hours, and 26 minutes"
    ));
    // It is the close notice: today's "Orders close at ..." line is
    // gone from the card.
    await expect(body).not.toContainText("Orders close");

    // Delivery's notice, at the same moment, in the same form but for
    // its phrase and its own day.
    const delivery = page.locator("[data-countdown-text]");
    const count = "(\\d+ days?, \\d+ hours?, and |\\d+ hours? and )?"
      + "\\d+ minutes?";
    const form = (phrase) => new RegExp(`^Order within ${count} ${
      phrase} on [A-Z][a-z]+day, [A-Z][a-z]+ \\d{1,2}\\.$`, "u");

    await expect(delivery).toHaveText(form("for delivery"));
    await expect(line).toHaveText(form("to join the current group order"));
  });

  test("Close notice: it counts down live, as the delivery countdown "
    + "does, and takes its days, hours and minutes from the same code, "
    + "so the two never differ in form", async ({ page, baseURL }) => {
    // Days out: a minute on, the page says so without a reload.
    let body = await groupOrdersAt(page, baseURL, before(12, 20, 26));
    let line = notice(body);

    await expect(line).toHaveText(sentence(
      "12 days, 20 hours, and 26 minutes"
    ));
    await page.clock.runFor(MINUTE);
    await expect(line).toHaveText(sentence(
      "12 days, 20 hours, and 25 minutes"
    ));
    await page.clock.runFor(MINUTE);
    await expect(line).toHaveText(sentence(
      "12 days, 20 hours, and 24 minutes"
    ));

    // An hour out: the hours drop off as the last hour starts, and the
    // count goes on to its last minute, as Delivery's does.
    body = await groupOrdersAt(page, baseURL, before(0, 1, 1));
    line = notice(body);

    await expect(line).toHaveText(sentence("1 hour and 1 minute"));
    await page.clock.runFor(MINUTE);
    await expect(line).toHaveText(sentence("1 hour and 0 minutes"));
    await page.clock.runFor(MINUTE);
    await expect(line).toHaveText(sentence("59 minutes"));
    await page.clock.runFor(57 * MINUTE);
    await expect(line).toHaveText(sentence("2 minutes"));
    await page.clock.runFor(MINUTE);
    await expect(line).toHaveText(sentence("1 minute"));
  });
});
