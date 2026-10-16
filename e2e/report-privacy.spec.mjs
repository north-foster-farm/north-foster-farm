// No browser error report carries the customer (#258). The order form
// is filled with a fake customer, then every failure in pay.js's
// table (#246) is forced, plus an uncaught throw and rejection, and
// every POST to /api/health is caught in the browser and read. The
// test fails if any of the fake values appears in one. Square's and
// PayPal's scripts are stand-ins served here, and the beacons never
// leave the browser, so nothing reaches a processor or raises a
// staging alert. docs/monitoring.md, "Browser error reports".

import { cannedDates } from "./support/canned.mjs";
import { OrderPage, expect, test } from "./support/order.mjs";

const FAKE = {
  first: "Zebulon",
  last: "Quixote-Farnsworth",
  email: "zeb.pii-check@example.com",
  phone: "(401) 555-0123",
};
// What must never appear, in every spelling a value might take.
const NEEDLES = [
  FAKE.first, FAKE.last, FAKE.email, "zeb.pii-check", FAKE.phone,
  "4015550123", "401-555-0123", "555-0123", "555 0123", "5550123",
];

const SQUARE = "/e2e-fake/square.js";
const PAYPAL = "/e2e-fake/paypal.js";

const CONFIG = {
  square: {
    applicationId: "sandbox-sq0idb-fake", locationId: "LFAKE",
    env: "sandbox", sdkUrl: SQUARE,
  },
  paypal: { clientId: "fake", env: "sandbox", hidden: false, sdkUrl: PAYPAL },
};

// Stand-in SDKs whose every failure quotes the customer, as a real
// error quoting an input's value would.
const brokenSquare = `
  const e = ${JSON.stringify(FAKE.email)};
  const p = ${JSON.stringify(FAKE.phone)};
  window.Square = { payments: () => ({
    card: async () => ({
      attach: async () => { throw new Error("Billing contact " + e); },
      focus: async () => {},
    }),
    paymentRequest: () => ({ update() {} }),
    applePay: async () => ({
      tokenize: () => Promise.reject(new Error("Apple Pay for " + e + " " + p)),
    }),
    googlePay: async () => ({
      attach: async () => {},
      tokenize: async () => ({
        status: "Error", errors: [{ message: "Bad phone " + p }],
      }),
    }),
    cashAppPay: async () => {
      let handler = null;

      return {
        addEventListener: (type, fn) => { handler = fn; },
        attach: async () => {
          setTimeout(() => handler({
            detail: { error: { message: "Cash App refused " + e } },
          }), 50);
        },
      };
    },
  }) };
`;

const paypal = (render) => `
  window.paypal = {
    FUNDING: { VENMO: "venmo" },
    Buttons: (opts) => ({
      isEligible: () => true,
      render: async () => { ${render} },
    }),
  };
`;

const failingRender = paypal(
  `throw new Error("Venmo render for " + ${JSON.stringify(FAKE.phone)});`
);
const workingButton = paypal("");
const erroringButton = paypal(`setTimeout(() => opts.onError(
  new Error("Venmo said no to " + ${JSON.stringify(FAKE.email)})), 50);`);

// Every report the page sends, caught before it leaves; and the
// config held until the form is filled, so the payment section loads
// after the customer has typed.
const setUp = async (page, { config = { json: CONFIG }, square, venmo }) => {
  const reports = [];
  let release;
  const filled = new Promise((resolve) => { release = resolve; });

  await cannedDates(page);
  await page.route("**/api/health", (route) => {
    if (route.request().method() === "POST") {
      reports.push(route.request().postData() || "");
    }

    return route.fulfill({ status: 202, json: { ok: true } });
  });
  await page.route("**/api/checkout/config", async (route) => {
    await filled;

    return route.fulfill(config);
  });
  await page.route(`**${SQUARE}`, (route) => (square
    ? route.fulfill({ contentType: "text/javascript", body: square })
    : route.abort()));
  await page.route(`**${PAYPAL}`, (route) => (venmo
    ? route.fulfill({ contentType: "text/javascript", body: venmo })
    : route.abort()));

  const order = new OrderPage(page);

  await order.open({ eggs: 1 });
  await order.method("onfarm");
  await order.contact(FAKE);
  await order.firstDate("onfarm");
  release();
  await page.locator("#payment").scrollIntoViewIfNeeded();

  return { order, reports };
};

const wheres = (reports) => reports.map((r) => JSON.parse(r).where);

const expectReports = async (reports, expected) => {
  await expect.poll(() => wheres(reports).sort(), { timeout: 20_000 })
    .toEqual(expect.arrayContaining(expected));
};

const expectNoCustomer = (reports) => {
  expect(reports.length).toBeGreaterThan(0);
  for (const body of reports) {
    for (const needle of NEEDLES) {
      expect(body, `a report quoted "${needle}"`).not.toContain(needle);
    }
  }
};

test.describe("browser error reports keep the customer out (#258)", () => {
  test("the checkout config fails", async ({ page }) => {
    const { reports } = await setUp(page, {
      config: { status: 500, json: { error: "down" } },
    });

    await expectReports(reports, ["checkout.config"]);
    expectNoCustomer(reports);
  });

  test("the checkout config is not JSON", async ({ page }) => {
    const { reports } = await setUp(page, {
      config: { contentType: "application/json", body: "not json" },
    });

    await expectReports(reports, ["checkout.init"]);
    expectNoCustomer(reports);
  });

  test("neither SDK loads", async ({ page }) => {
    const { reports } = await setUp(page, {});

    await expectReports(reports, ["square.load", "paypal.load", "sdks.gone"]);
    expectNoCustomer(reports);
  });

  // A page sends five reports at most, so the wallets have their own.
  test("the card field and Venmo's render fail", async ({ page }) => {
    const { reports } = await setUp(page, {
      square: brokenSquare, venmo: failingRender,
    });

    await expectReports(reports, [
      "card.attach", "cashapp.tokenize", "paypal.render", "sdks.gone",
    ]);
    expectNoCustomer(reports);
  });

  test("the wallets fail", async ({ page }) => {
    const { reports } = await setUp(page, {
      square: brokenSquare, venmo: workingButton,
    });

    await expectReports(reports, ["card.attach", "cashapp.tokenize"]);
    await page.locator("[data-apple-pay]").dispatchEvent("click");
    await page.locator("[data-google-pay]").dispatchEvent("click");
    await expectReports(reports, ["wallet.pay", "wallet.tokenize"]);
    expectNoCustomer(reports);
  });

  test("Venmo errors, and the page throws", async ({ page }) => {
    const { reports } = await setUp(page, {
      config: { json: { paypal: CONFIG.paypal } }, venmo: erroringButton,
    });

    await expectReports(reports, ["paypal.error"]);
    // An error quoting what the customer typed, thrown and rejected
    // with nothing to catch it.
    await page.evaluate(() => {
      const email = document.getElementById("customer-email").value;
      const phone = document.getElementById("customer-phone").value;

      setTimeout(() => {
        throw new Error(`Uncaught with ${email}`);
      });
      Promise.reject(new Error(`Rejected with ${phone}`));
    });
    await expectReports(reports, ["window.error", "window.rejection"]);
    expectNoCustomer(reports);
  });

  test("the privacy policy says so", async ({ page }) => {
    await page.goto("/privacy/");
    expect(await page.locator("main").innerText()).toMatch(new RegExp(
      "The\\s+order page reports its own errors to that log: what went " +
      "wrong, on which page,\\s+and your browser and its version, but " +
      "never your name, your contact details or\\s+your order\\."
    ));
  });
});
