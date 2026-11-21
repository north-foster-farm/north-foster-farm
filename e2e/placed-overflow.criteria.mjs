// Criteria test for #723's box from the staging screenshot (#729
// comment 7068499351, item 7): at 390 px the panel's bold values ran
// past its right edge and "Date and time" broke across two lines.
//
// Held out of every run by its name: the config takes *.spec.mjs only,
// so renaming it to placed-overflow.spec.mjs turns it on. It runs in
// the phone project, which is 390 px wide, and places each order
// against the fake payment drivers (#265), skipping where they are not
// offered.

import {
  OrderPage, expect, paymentFakes as fakes, test, uniqueEmail,
} from "./support/order.mjs";

// Half a pixel for subpixel rounding, no more.
const SLACK = 0.5;

// The three ways, each with a long value: the farm's street, a pickup
// location's street, a delivery's date and time.
const WAYS = {
  onfarm: async (order) => {
    await order.method("onfarm");
    await order.firstDate("onfarm");
  },
  scheduled: (order) => order.scheduled(),
  delivery: async (order) => {
    await order.delivery();
    await order.firstDate("delivery");
  },
};

const place = async (page, way) => {
  const order = new OrderPage(page);

  // Delivery needs its minimum, and asks for a phone number.
  await order.open({ eggs: way === "delivery" ? 6 : 1 });
  await WAYS[way](order);
  await order.contact({
    first: "Placed", email: uniqueEmail(`overflow-${way}`),
    ...(way === "delivery" ? { phone: "4015550100" } : {}),
  });
  await order.openCard();
  await order.card();

  const { status, body } = await order.pay();

  expect(status, JSON.stringify(body)).toBe(200);
  await expect(order.result).toBeVisible();

  return order.result;
};

// Every row of the panel's lists: the row's box, its label's line
// boxes (the text before its first bold value) and its values' line
// boxes, beside the panel's own box.
const measure = (card) => card.evaluate((panel) => {
  const box = (r) => ({
    left: r.left, right: r.right, top: r.top, bottom: r.bottom,
  });
  const lines = (rects) => [...rects]
    .filter((r) => r.width > 0 && r.height > 0).map(box);

  return {
    panel: box(panel.getBoundingClientRect()),
    rows: [...panel.querySelectorAll("ul li, ol li")]
      .filter((li) => li.getClientRects().length > 0)
      .map((li) => {
        const values = [...li.querySelectorAll("strong")];
        const label = document.createRange();

        label.setStart(li, 0);
        if (values.length) label.setEndBefore(values[0]);
        else label.setEndAfter(li.lastChild);

        return {
          text: li.textContent.replace(/\s+/g, " ").trim(),
          row: box(li.getBoundingClientRect()),
          label: lines(label.getClientRects()),
          values: values.flatMap((v) => lines(v.getClientRects())),
        };
      }),
  };
});

const inside = (inner, outer) =>
  inner.left >= outer.left - SLACK && inner.right <= outer.right + SLACK;

// Line boxes on one line share a top, give or take the slack.
const lineCount = (rects) => rects
  .map((r) => r.top)
  .sort((a, b) => a - b)
  .filter((top, i, tops) => i === 0 || top - tops[i - 1] > SLACK)
  .length;

test.describe("#723 the order placed panel at 390 px", () => {
  test.beforeEach(async ({ request }, testInfo) => {
    test.skip(testInfo.project.name !== "phone", "the 390 px check");
    test.skip(!(await fakes(request)).square, "SQUARE_ENV is not fake here");
  });

  test("At 390 px nothing in the panel runs past its edge: every label " +
    "and value wraps inside it, and no label breaks mid-phrase",
  async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 664 });

    for (const way of Object.keys(WAYS)) {
      await test.step(way, async () => {
        const fresh = await page.context().newPage();

        await fresh.setViewportSize({ width: 390, height: 664 });

        const { panel, rows } = await measure(await place(fresh, way));

        expect(panel.right - panel.left, `${way}: the panel`)
          .toBeLessThanOrEqual(390 + SLACK);
        expect(rows.length, `${way}: the panel's rows`)
          .toBeGreaterThan(0);
        // Soft, so one run reports every row of every way.
        for (const { text, row, label, values } of rows) {
          expect.soft(inside(row, panel),
            `${way}: row "${text}" ${JSON.stringify(row)} sits inside ` +
              `the panel ${JSON.stringify(panel)}`).toBe(true);
          for (const value of values) {
            expect.soft(inside(value, panel),
              `${way}: a value of "${text}" ${JSON.stringify(value)} ` +
                `sits inside the panel ${JSON.stringify(panel)}`)
              .toBe(true);
          }
          for (const line of label) {
            expect.soft(inside(line, panel),
              `${way}: the label of "${text}" sits inside the panel`)
              .toBe(true);
          }
          expect.soft(lineCount(label),
            `${way}: the label of "${text}" renders on one line`)
            .toBe(1);
        }
        await fresh.close();
      });
    }
  });
});
