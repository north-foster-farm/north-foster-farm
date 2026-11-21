// Criteria tests for #721 (Venmo decline: let the buyer pick another
// funding source), one per box of its "Done when". Held out of the
// suite as *.criteria.mjs until the implementer renames the file to
// venmo-restart.spec.mjs and lists it in e2e/dispatch.json.
//
// The order page runs against the local functions with PAYPAL_ENV=fake
// (bin/e2e/serve.mjs), and the Venmo button is the stub SDK
// (assets/scripts/fake/paypal.js), which approves at once and whose
// actions.restart() approves again on the same order, as PayPal's does
// once the buyer picks another funding source. The PayPal order and
// every capture that succeeds are the fake's, so the records are the
// server's own. A capture the test refuses never reaches the server:
// the browser is answered with the 402 the server gives for PayPal's
// 422, worked out from that 422 by lib/paypal.mjs itself.
//
// PayPal's 422 is the one James's first live Venmo payment got
// (2026-11-21), recorded by bin/fixtures/record and scrubbed into
// test/fixtures/paypal (#708, #744).

import { recorded } from "../netlify/functions/lib/fake.mjs";
import {
  DECLINE_MESSAGES, captureOrder,
} from "../netlify/functions/lib/paypal.mjs";
import {
  OrderPage, expect, paymentFakes, test, uniqueEmail,
} from "./support/order.mjs";
import {
  BACK_OFFICE_MISSING, backOffice, nff, orderLimitHeaders, orderRecord,
} from "./support/staging.mjs";

// PayPal's answer to the capture of James's live test: 422
// UNPROCESSABLE_ENTITY, INSTRUMENT_DECLINED.
const DECLINED = "paypal-20261121T085555608Z-post-v2-checkout-orders-" +
  "order-id-1-capture-1c506d";

// PayPal's answer to a capture refused with `issue`: the recorded 422,
// as recorded for INSTRUMENT_DECLINED. No other refusal has been
// recorded, so for another issue it is that same 422 with the issue
// it names changed, which is all lib/paypal.mjs reads of it.
const paypal422 = (issue) => {
  const { status, response } = recorded("paypal", DECLINED);

  response.details[0].issue = issue;

  return { status, response };
};

// What /api/orders answers the page for that 422: lib/paypal.mjs reads
// it as a decline and its code, and orders.mjs answers 402 with the
// code and the customer's words (its `declined` branch). The token
// exchange is never recorded (lib/recorder.mjs), so it is answered
// here with no more than captureOrder reads.
const TOKEN = { "access_token": "e2e", "expires_in": 3600 };

const declined = async (issue, paypalOrderId) => {
  const { status, response } = paypal422(issue);
  const fetchImpl = async (url) => (
    new URL(url).pathname === "/v1/oauth2/token"
      ? new Response(JSON.stringify(TOKEN))
      : new Response(JSON.stringify(response), {
        status, headers: { "Content-Type": "application/json" },
      })
  );
  const env = {
    PAYPAL_ENV: "sandbox", PAYPAL_CLIENT_ID: "e2e", PAYPAL_CLIENT_SECRET: "e2e",
  };

  try {
    await captureOrder(paypalOrderId, "e2e-key", {
      env, fetchImpl, recordings: null,
    });
  } catch (error) {
    if (!error.declined) throw error;

    return {
      status: 402,
      json: {
        declined: true, code: error.code, message: DECLINE_MESSAGES[error.code],
      },
    };
  }
  throw new Error(`lib/paypal.mjs took a 422 ${issue} for a capture`);
};

// Every POST to /api/orders, in order: { stage, paypalOrderId, status,
// data }. The nth capture is refused with refusals[n - 1] when there
// is one; everything else goes to the local functions, past the order
// limit, which counts this machine's whole run.
const watchOrders = async (page, refusals = []) => {
  const posts = [];

  await page.route("**/api/orders", async (route) => {
    const request = route.request();

    if (request.method() !== "POST") return route.fallback();

    const payment = (request.postDataJSON() || {}).payment || {};
    const post = {
      stage: payment.stage || null,
      paypalOrderId: payment.paypalOrderId || null,
    };

    posts.push(post);

    const nth = posts.filter((p) => p.stage === "capture").length;
    const refusal = post.stage === "capture" && refusals[nth - 1];

    if (refusal) {
      const answer = await declined(refusal, post.paypalOrderId);

      post.status = answer.status;
      post.data = answer.json;

      return route.fulfill(answer);
    }

    const response = await route.fetch({
      headers: { ...request.headers(), ...orderLimitHeaders() },
    });

    post.status = response.status();
    post.data = await response.json().catch(() => null);

    return route.fulfill({ response });
  });

  return {
    posts,
    creates: () => posts.filter((p) => p.stage === "create"),
    captures: () => posts.filter((p) => p.stage === "capture"),
  };
};

// An on-farm pickup of a dozen eggs, filled in up to the Venmo button.
// ?venmo shows the button even where VENMO_HIDDEN holds it back.
const readyToPay = async (page, email) => {
  const order = new OrderPage(page);

  await page.goto("/order/?venmo&add=NFF-CHK-EGG-LG:1");
  await expect(page.locator("#onfarm-date")).toBeEnabled();
  await page.waitForTimeout(1_000);
  await order.method("onfarm");
  await order.contact({ first: "Venmo", email });
  await order.firstDate("onfarm");
  await page.locator("#payment").scrollIntoViewIfNeeded();

  const venmo = page.locator("[data-fake-venmo]");

  await expect(venmo).toBeEnabled({ timeout: 30_000 });

  return { order, venmo };
};

// Time for a restart that should not come to show itself. The stub
// approves at once, so a restart posts its capture well within this.
const SETTLE_MS = 3_000;

// A record with what differs between two orders by design taken out:
// the order id, the email address, the fakes' hashed ids, the
// submission's keys, the outbox's message ids (the send time, then a
// count) and the times.
const comparable = (record, { id, email }) => JSON.parse(
  JSON.stringify(record)
    .replaceAll(id, "<order id>")
    .replaceAll(email, "<email>")
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-\d+/g, "<outbox id>")
    .replace(/-[0-9A-F]{16}\b/g, "-<fake id>")
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g,
      "<key>")
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})/g,
      "<time>")
);

test.describe("Venmo decline restarts the flow (#721)", () => {
  test.beforeEach(async ({ request }) => {
    test.skip(!(await paymentFakes(request)).paypal,
      "PAYPAL_ENV is not fake here");
    test.skip(!backOffice().ready, BACK_OFFICE_MISSING);
  });

  test("A capture refused with INSTRUMENT_DECLINED restarts the Venmo " +
    "flow on the same PayPal order, once", async ({ page }) => {
    const email = uniqueEmail("venmo-restart");
    const orders = await watchOrders(page, ["INSTRUMENT_DECLINED"]);
    const { order, venmo } = await readyToPay(page, email);

    await venmo.click();

    await expect.poll(() => orders.captures().length, {
      message: "the page captures again after INSTRUMENT_DECLINED",
    }).toBe(2);
    await expect(order.result).toBeVisible();
    await page.waitForTimeout(SETTLE_MS);

    const [created] = orders.creates();

    expect(orders.creates(), "one PayPal order, not a second").toHaveLength(1);
    expect(created.data && created.data.paypalOrderId).toBeTruthy();
    expect(orders.captures().map((c) => c.paypalOrderId)).toEqual([
      created.data.paypalOrderId, created.data.paypalOrderId,
    ]);
    expect(orders.captures().map((c) => c.status)).toEqual([402, 200]);
  });

  test("A second decline, or any other capture failure, shows today's " +
    "message and records nothing", async ({ context, page }) => {
    // A second INSTRUMENT_DECLINED, after the one restart.
    const twice = uniqueEmail("venmo-twice");
    const second = await watchOrders(page, [
      "INSTRUMENT_DECLINED", "INSTRUMENT_DECLINED",
    ]);
    const first = await readyToPay(page, twice);

    await first.venmo.click();

    await expect.poll(() => second.captures().length, {
      message: "the first INSTRUMENT_DECLINED restarts the flow",
    }).toBe(2);
    await expect(first.order.payError)
      .toHaveText(DECLINE_MESSAGES.INSTRUMENT_DECLINED);
    await page.waitForTimeout(SETTLE_MS);
    expect(second.captures(), "no restart after the second decline")
      .toHaveLength(2);
    expect(second.creates()).toHaveLength(1);
    await expect(first.order.result).toBeHidden();
    expect(await nff(["orders", "list", `--email=${twice}`]))
      .toContain("No orders.");

    // Another refusal: no restart, today's words at once.
    const other = await context.newPage();
    const refused = uniqueEmail("venmo-refused");
    const once = await watchOrders(other, ["TRANSACTION_REFUSED"]);
    const refusedPay = await readyToPay(other, refused);

    await refusedPay.venmo.click();

    await expect(refusedPay.order.payError)
      .toHaveText(DECLINE_MESSAGES.TRANSACTION_REFUSED);
    await other.waitForTimeout(SETTLE_MS);
    expect(once.captures(), "no restart after TRANSACTION_REFUSED")
      .toHaveLength(1);
    expect(once.creates()).toHaveLength(1);
    await expect(refusedPay.order.result).toBeHidden();
    expect(await nff(["orders", "list", `--email=${refused}`]))
      .toContain("No orders.");
  });

  test("A successful capture after a restart records the order exactly " +
    "as a first-time success does", async ({ context, page }) => {
    // A first-time success, the same order by another buyer.
    const plainEmail = uniqueEmail("venmo-plain");
    const plain = await watchOrders(page);
    const first = await readyToPay(page, plainEmail);

    await first.venmo.click();
    await expect(first.order.result).toBeVisible();

    const [plainPaid] = plain.captures();

    expect(plainPaid.status).toBe(200);

    // The same, refused once with INSTRUMENT_DECLINED.
    const other = await context.newPage();
    const restartedEmail = uniqueEmail("venmo-again");
    const restarted = await watchOrders(other, ["INSTRUMENT_DECLINED"]);
    const restartedPay = await readyToPay(other, restartedEmail);

    await restartedPay.venmo.click();

    await expect.poll(() => restarted.captures().length, {
      message: "the page captures again after INSTRUMENT_DECLINED",
    }).toBe(2);
    await expect(restartedPay.order.result).toBeVisible();

    const restartedPaid = restarted.captures()[1];

    expect(restartedPaid.status).toBe(200);

    const plainId = plainPaid.data.orderId;
    const restartedId = restartedPaid.data.orderId;

    expect(await nff(["orders", "list", `--email=${restartedEmail}`]))
      .toBe(`${restartedId}  paid`);
    expect(comparable(await orderRecord(restartedId), {
      id: restartedId, email: restartedEmail,
    })).toEqual(comparable(await orderRecord(plainId), {
      id: plainId, email: plainEmail,
    }));
  });
});
