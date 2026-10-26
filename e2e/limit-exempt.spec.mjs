// #164: off production, a request with the staging token in
// X-Staging-Token skips the per-address rate limits of /api/orders (12
// per 10 minutes) and /api/contact (5), so a full pass and a person
// testing by hand can share one address. The requests here are
// refused before they charge or send anything: an order without a
// submission key answers 422, a blank message answers 422. Past each
// limit a bare request would lock this address out for ten minutes
// (rate-limit.spec.mjs does that on request), so this spec sends only
// the exempt ones. That production keeps its limit is the by-hand
// half of #164 and the release-day check in #237.

import { eggOrder } from "./support/api.mjs";
import { expect, test, uniqueEmail } from "./support/order.mjs";
import {
  BACK_OFFICE_MISSING, backOffice, orderLimitHeaders,
} from "./support/staging.mjs";

const TRIES = 30;

test.describe("the staging token and the rate limits", () => {
  test.skip(!backOffice().ready, BACK_OFFICE_MISSING);

  test("orders: more than the limit, none answered 429",
    async ({ request }) => {
      const cheap = { ...await eggOrder(request, {
        email: uniqueEmail("exempt"),
      }), idempotencyKey: "" };
      const answers = [];

      for (let i = 0; i < TRIES; i += 1) {
        const res = await request.post("/api/orders", {
          data: cheap, headers: orderLimitHeaders(),
        });

        answers.push(res.status());
      }
      expect(answers.filter((s) => s === 429), "429s").toEqual([]);
      expect(new Set(answers)).toEqual(new Set([422]));
    });

  test("contact: more than the limit, none answered 429",
    async ({ request }) => {
      const answers = [];

      for (let i = 0; i < TRIES; i += 1) {
        const res = await request.post("/api/contact", {
          headers: orderLimitHeaders(),
          data: { name: " ", email: "you@farm", message: "" },
        });

        answers.push(res.status());
      }
      expect(answers.filter((s) => s === 429), "429s").toEqual([]);
      expect(new Set(answers)).toEqual(new Set([422]));
    });
});
