// Restock types and the order page's Show control (#267, 6303165805,
// the `soon` amendment 6303183573 and the control in 6303649455).
// "In stock", the default, shows what is in stock; "Full catalog"
// also shows the rest, with a restock label and no way to add
// it. Search shows every product but an archived one, with its label,
// whatever the page shows. Stock wins over every type but archived.
// docs/qa-launch.md OP-26.

import { readFileSync } from "node:fs";

import { OrderPage, SKU, expect, test } from "./support/order.mjs";

const catalog = JSON.parse(readFileSync(
  new URL("../data/catalog.json", import.meta.url), "utf8"
));
const items = catalog.groups.flatMap((g) => g.items);

// One product out of stock in the catalog for each restock type but
// archived and seasonal (James's corrections, #274 6330468558, and
// #303 for Tenders).
const OUT = {
  soon: "NFF-CHK-FET-0075-0125", // Feet: "Returning soon"
  hiatus: "NFF-CHK-SAUSWT", // Sweet Italian Sausage
  discontinued: "NFF-CHK-TND-15-99", // Tenders, 1.5 lbs and up
};
// No seasonal product is out in the catalog since #303; a stub sells
// out Drumsticks, 1.5 lbs and up, for "Back in spring".
const SEASONAL = "NFF-CHK-DRM-15-99";
const LABEL = {
  soon: "Returning soon",
  seasonal: "Back in spring",
  hiatus: "On hiatus",
  discontinued: "Not available",
};
// No category is wholly out in the catalog since 2026-v9; selling
// out the maple links empties Sausage.
const MAPLE = "NFF-CHK-SAUMPL";
const SAUSAGE_OUT = { [MAPLE]: { inStock: false, available: 0 } };
const SEASONAL_OUT = { [SEASONAL]: { inStock: false, available: 0 } };

const archived = items.filter((i) => i.restock === "archived")
  .map((i) => i.sku);

const row = (page, sku) => page.locator(`.order-item[data-sku="${sku}"]`);
const choice = (page, name) => page.getByRole("radio", { name });
const show = (page, name) => choice(page, name).click();

// /api/stock as the server gives it, with `over` laid on top.
const stubStock = (page, over) => page.route("**/api/stock",
  async (route) => {
    const res = await route.fetch();
    const body = await res.json();

    Object.assign(body.items, over);
    await route.fulfill({ response: res, json: body });
  });

// Opens the order page and waits for its stock check.
const open = async (page, cart) => {
  const stock = page.waitForResponse("**/api/stock");

  await new OrderPage(page).open(cart);
  await stock;
};

test.describe("restock types (#267)", () => {
  test("the catalog's assignments hold", () => {
    for (const [type, sku] of Object.entries(OUT)) {
      const item = items.find((i) => i.sku === sku);

      expect(item.inStock, sku).toBe(false);
      expect(item.restock, sku).toBe(type);
    }
    for (const item of items) {
      expect(["seasonal", "soon", "hiatus", "discontinued", "archived"])
        .toContain(item.restock);
    }
  });

  test("Show is a radio group, In stock by default, showing today's " +
    "list", async ({ page }) => {
    await stubStock(page, SAUSAGE_OUT);
    await open(page);

    const group = page.getByRole("radiogroup", { name: "Show" });

    await expect(group).toBeVisible();
    await expect(group.getByRole("radio")).toHaveCount(2);
    await expect(choice(page, "In stock")).toBeChecked();
    await expect(choice(page, "Full catalog")).not.toBeChecked();
    for (const sku of Object.values(OUT)) {
      await expect(row(page, sku)).toBeHidden();
    }
    await expect(page.locator("#cat-sausage")).toBeHidden();
    await expect(page.locator("#order-nav a[href='#cat-sausage']"))
      .toBeHidden();
    await expect(row(page, SKU.eggs)).toBeVisible();

    // It takes the keyboard, with a visible focus ring on the label.
    await page.keyboard.press("Shift");
    await choice(page, "In stock").focus();
    await page.keyboard.press("ArrowRight");
    await expect(choice(page, "Full catalog")).toBeChecked();
    await expect(choice(page, "Full catalog")).toBeFocused();
    await expect(row(page, OUT.soon)).toBeVisible();
    expect(await page.locator(".order-filter-option:has(#order-show-all)")
      .evaluate((el) => getComputedStyle(el).outlineStyle)).toBe("solid");

    // The chosen side is lighter than the track.
    const lum = (sel) => page.locator(sel).evaluate((el) => {
      const [r, g, b] = getComputedStyle(el).backgroundColor
        .match(/\d+/g).map(Number);

      return r + g + b;
    });

    expect(await lum(".order-filter-fill"))
      .toBeGreaterThan(await lum(".order-filter-seg"));
  });

  // The lead line and the visible "Show" went (#274, round 4 part 2):
  // the control stands alone over the catalog, centered in the
  // hidden heading's place (#327), still named "Show" for a screen
  // reader.
  test("Show stands alone, centered, at the top of the catalog",
    async ({ page }) => {
      await open(page);

      await expect(page.locator(".order-intro .order-filter")).toHaveCount(1);
      await expect(page.locator(".order-topbar .order-filter"))
        .toHaveCount(0);
      await expect(page.locator(".order-intro")).toHaveText(
        /^\s*In stock\s*Full catalog\s*$/
      );

      for (const size of [
        { width: 1280, height: 900 }, { width: 768, height: 900 },
        { width: 390, height: 800 },
      ]) {
        await page.setViewportSize(size);

        const offset = await page.locator(".order-intro").evaluate((el) => {
          const box = el.getBoundingClientRect();
          const seg = el.querySelector(".order-filter-seg")
            .getBoundingClientRect();

          return (seg.left + seg.right) / 2 - (box.left + box.right) / 2;
        });

        expect(Math.abs(offset), `${size.width}px`).toBeLessThan(2);
        // The heading is still the h1, for a screen reader only.
        await expect(page.locator(".page-heading h1"))
          .toHaveText("Place an order");
        // Its box is a pixel, clipped; the h1 inside keeps its own
        // size, which the clip hides.
        const head = await page.locator(".page-heading").boundingBox();

        expect(head.width * head.height, `${size.width}px`).toBeLessThan(4);
      }
    });

  // The header's Order button shows the catalog heading's double
  // chevron on the order page only, and the icon glyphs sit equally
  // far apart (#327).
  test("The header's Order button wears the double chevron", async ({
    page,
  }) => {
    await open(page);

    const order = page.locator(".site-order");

    await expect(order).toHaveAttribute("aria-current", "page");
    await expect(order.locator(".site-order-chev svg")).toBeVisible();
    await expect(order.locator(".site-order-chev"))
      .toHaveAttribute("aria-hidden", "true");

    await page.goto("/news/");
    await expect(page.locator(".site-order-chev")).toHaveCount(0);
  });

  test("The header's icon glyphs are equally far apart", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 800 });
    // Signed out, the header has a Sign in link and no account glyph.
    await page.route("**/api/me", (route) => route.fulfill({
      json: { signedIn: true, customer: { email: "qa-e2e-glyph@example.com" } },
    }));
    await open(page);
    await expect(page.locator(".site-account-icon:visible")).toHaveCount(1);

    const gaps = await page.evaluate(() => {
      const edge = (el) => {
        const r = el.getBoundingClientRect();

        return [r.left, r.right];
      };
      const glyphs = [
        ".site-account-icon", ".site-search-open", ".site-order",
      ].map((q) => [...document.querySelectorAll(q)]
        .find((el) => el.offsetWidth)).map(edge);

      return [
        glyphs[1][0] - glyphs[0][1], glyphs[2][0] - glyphs[1][1],
      ];
    });

    expect(Math.abs(gaps[0] - gaps[1])).toBeLessThan(2);
  });

  test("Full catalog: out-of-stock rows show their label, with no " +
    "tint on the name, and can't be added", async ({ page }) => {
    await stubStock(page, { ...SAUSAGE_OUT, ...SEASONAL_OUT });
    await open(page);
    await show(page, "Full catalog");

    for (const [type, sku] of Object.entries({
      ...OUT, seasonal: SEASONAL,
    })) {
      const r = row(page, sku);

      await expect(r, type).toBeVisible();
      await expect(r).toHaveAttribute("data-stock", "out");
      // One design for every row (#318): the label is a disabled
      // button in Add's place, with no border and no gray tint.
      const out = r.locator(".order-qty-out");

      await expect(out).toHaveText(LABEL[type]);
      await expect(out).toBeDisabled();
      await expect(out).toHaveAttribute("aria-disabled", "true");
      await expect(out).toHaveCSS("border-top-width", "0px");
      await expect(r.locator(".order-qty-add")).toBeHidden();
      expect(await r.evaluate((el) => getComputedStyle(el)
        .backgroundColor), type).toBe(await row(page, SKU.eggs)
        .evaluate((el) => getComputedStyle(el).backgroundColor));
      // No price but on "Returning soon"; on every row the label stands
      // where Add goes, at the row's right (#274 round 5, #303), and
      // a price stays to its left.
      await expect(r.locator(".order-item-price"))
        .toBeVisible({ visible: type === "soon" });
      const at = await r.evaluate((el) => {
        const box = (s) => el.querySelector(s).getBoundingClientRect();

        return {
          gap: el.getBoundingClientRect().right - box(".order-qty-out")
            .right,
          left: box(".order-qty-out").left - box(".order-item-price")
            .right,
        };
      });

      expect(at.gap, type).toBeLessThan(40);
      if (type === "soon") expect(at.left, type).toBeGreaterThan(0);
      await expect(r.locator("[data-qty]")).toBeDisabled();
      for (const b of await r.locator("[data-step]").all()) {
        await expect(b).toBeDisabled();
      }
      await expect(r.getByText("Sold out", { exact: true })).toHaveCount(0);
    }

    // No tint: the name keeps the body's color (#318).
    const color = (sku) => row(page, sku).locator("label")
      .evaluate((el) => getComputedStyle(el).color);

    expect(await color(OUT.soon)).toBe(await color(SKU.eggs));

    // Every egg says its grade (#303, James, final), by its name and
    // out of the price column (#437): Large with its price, Medium and
    // Small, on hiatus, with none.
    await expect(row(page, SKU.eggs).locator(".order-item-name"))
      .toHaveText("Large · Grade A", { useInnerText: true });
    await expect(row(page, SKU.eggs).locator(".order-item-price"))
      .toHaveText("$7");
    for (const sku of ["NFF-CHK-EGG-MD", "NFF-CHK-EGG-SM"]) {
      await expect(row(page, sku).locator(".order-item-name"), sku)
        .toHaveText(/· Grade A$/, { useInnerText: true });
      await expect(row(page, sku).locator(".order-item-price"), sku)
        .toBeHidden();
      await expect(row(page, sku).locator(".order-qty-out"), sku)
        .toHaveText("On hiatus");
    }

    // One column for every row (#437): each price ends where the
    // others do, and each restock label centers on Add's column.
    const edges = await page.locator("#cat-eggs, #cat-sausage")
      .locator(".order-item:visible").evaluateAll((rows) => rows.map(
        (el) => {
          const box = (s) => el.querySelector(s)?.getBoundingClientRect();
          const price = box(".order-item-price");
          const qty = box(".order-qty");
          const out = box(".order-qty-out");

          return {
            price: price?.width ? price.right : null,
            qty: qty.left + qty.width / 2,
            out: out?.width ? out.left + out.width / 2 : null,
          };
        }
      ));
    const prices = edges.map((e) => e.price).filter((p) => p !== null);

    expect(Math.max(...prices) - Math.min(...prices)).toBeLessThan(1);
    for (const e of edges.filter((x) => x.out !== null)) {
      expect(Math.abs(e.out - edges[0].qty)).toBeLessThan(1);
    }

    // Empty categories return, with their links.
    await expect(page.locator("#cat-sausage")).toBeVisible();
    await expect(page.locator("#order-nav a[href='#cat-sausage']"))
      .toBeAttached();
    await expect(page.locator("#order-nav a[href='#cat-sausage']")
      .locator("xpath=..")).not.toHaveAttribute("hidden", "");
    // A category with every product archived never returns (2026-v9).
    for (const key of ["ground", "cornish"]) {
      await expect(page.locator(`#cat-${key}`)).toHaveCount(0);
      await expect(page.locator(`#order-nav a[href='#cat-${key}']`))
        .toHaveCount(0);
    }

    // Every product but an archived one has a row.
    await expect(page.locator(".order-item:visible"))
      .toHaveCount(items.length - archived.length);

    // The cart stays empty, and ?add= of one is refused.
    await expect(new OrderPage(page).count).toHaveText("0 items");
  });

  test("every restock label stays on one line at 320 (#324)",
    async ({ page }) => {
      await page.setViewportSize({ width: 320, height: 800 });
      await stubStock(page, { ...SAUSAGE_OUT, ...SEASONAL_OUT });
      await open(page);
      await show(page, "Full catalog");

      for (const [type, sku] of Object.entries({
        ...OUT, seasonal: SEASONAL,
      })) {
        const out = row(page, sku).locator(".order-qty-out");
        const box = await out.boundingBox();
        const lineHeight = await out.evaluate((el) =>
          parseFloat(getComputedStyle(el).lineHeight));

        await expect(out, type).toHaveText(LABEL[type]);
        // One line: the button is no taller than a line plus its
        // padding and border.
        expect(box.height, type).toBeLessThan(lineHeight * 2);
      }
    });

  test("Add and a restock label share one width at 390 (#325)",
    async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 800 });
      await open(page);
      await show(page, "Full catalog");

      const add = await page.locator(
        ".order-item:not([data-stock='out']) .order-qty-add"
      ).first().boundingBox();
      const out = await row(page, OUT.soon).locator(".order-qty-out")
        .boundingBox();

      // The label is as wide as its words, never narrower than Add
      // (#437), and centered on Add's column.
      expect(out.width).toBeGreaterThanOrEqual(add.width - 0.5);
      expect(add.x + add.width / 2)
        .toBeCloseTo(out.x + out.width / 2, 0);
    });

  test("an out-of-stock product can't be put in the cart by link",
    async ({ page }) => {
      await page.goto(`/order/?add=${OUT.discontinued}:2`);
      await expect(page.locator("#order-added"))
        .toContainText("Not available: Tenders, 1.5 lbs and up.");
      await expect(new OrderPage(page).count).toHaveText("0 items");
    });

  test("the choice is remembered across reloads", async ({ page }) => {
    await open(page);
    await show(page, "Full catalog");
    await expect(row(page, OUT.discontinued)).toBeVisible();

    await page.reload();
    await expect(choice(page, "Full catalog")).toBeChecked();
    await expect(row(page, OUT.discontinued)).toBeVisible();

    await show(page, "In stock");
    await page.reload();
    await expect(choice(page, "In stock")).toBeChecked();
    await expect(row(page, OUT.discontinued)).toBeHidden();
  });

  test("with storage blocked the choice still works, In stock first",
    async ({ page }) => {
      const errors = [];

      page.on("pageerror", (e) => errors.push(e.message));
      await page.addInitScript(() => {
        const blocked = () => {
          throw new DOMException("Blocked", "SecurityError");
        };

        Storage.prototype.getItem = blocked;
        Storage.prototype.setItem = blocked;
      });
      await open(page);
      await expect(choice(page, "In stock")).toBeChecked();
      await show(page, "Full catalog");
      await expect(row(page, OUT.hiatus)).toBeVisible();
      expect(errors.filter((m) => /Blocked/.test(m))).toEqual([]);
    });

  test("stock wins over soon, hiatus and discontinued",
    async ({ page }) => {
      await stubStock(page, Object.fromEntries(Object.values(OUT)
        .map((sku) => [sku, { inStock: true, available: 3 }])));
      await open(page);
      await expect(choice(page, "In stock")).toBeChecked();

      for (const sku of Object.values(OUT)) {
        const r = row(page, sku);

        await expect(r).toBeVisible();
        await expect(r).not.toHaveAttribute("data-stock", "out");
        await expect(r.locator(".order-item-stock")).toHaveText("3 left");
        await expect(r.locator(".order-qty-add")).toBeEnabled();
      }
      await row(page, OUT.discontinued).locator(".order-qty-add").click();
      await expect(new OrderPage(page).count).toHaveText("1 item");
    });

  test("a product that sells out mid-visit takes its label",
    async ({ page }) => {
      await stubStock(page, { [SKU.wings]: { inStock: false, available: 0 } });
      await open(page, { wings: 1 });
      await expect(row(page, SKU.wings)).toBeHidden();
      await show(page, "Full catalog");
      await expect(row(page, SKU.wings).locator(".order-qty-out"))
        .toHaveText("Back in spring");
      await expect(new OrderPage(page).count).toHaveText("0 items");
    });

  test("a product with no restock type stays hidden while out",
    async ({ page }) => {
      await open(page);
      // No product lacks a type today; take one away in the page.
      await row(page, OUT.discontinued).evaluate((li) => {
        li.dataset.restockLabel = "";
      });
      await show(page, "Full catalog");
      await expect(row(page, OUT.discontinued)).toBeHidden();
      await expect(row(page, OUT.hiatus)).toBeVisible();
    });

  test("an archived product is hidden under either choice and in search",
    async ({ page }) => {
      await stubStock(page, Object.fromEntries(archived
        .map((sku) => [sku, { inStock: true, available: 9 }])));
      await open(page);

      const products = JSON.parse(await page
        .locator("[data-search-products]").textContent());

      expect(products).toHaveLength(items.length - archived.length);
      for (const on of [true, false]) {
        if (!on) await show(page, "Full catalog");
        // Its row is in the hidden "Not available" section, for
        // a paid order that holds it (6305650920); nothing else shows it.
        for (const sku of archived) {
          await expect(row(page, sku)).toBeHidden();
        }
        await expect(page.locator("#cat-archived")).toBeHidden();
      }
      for (const sku of archived) {
        expect(products.map((p) => p.sku)).not.toContain(sku);
      }
    });

  // Nothing is archived yet, so one is stubbed (qa, after 3f10e84): the
  // order page is served as the build makes it for an archived item,
  // with no row and no search entry, its catalog entry marked so, and
  // /api/stock saying it is on hand, as when a restock leaves the flag
  // on. Nothing may bring it back, and ?add= of it is refused by name.
  test.describe("a stubbed archived product", () => {
    const sku = "NFF-CHK-WNG-20-29"; // Wings, 2.0 - 2.9 lbs

    // A stock check still in flight at the end must not fail the next
    // test.
    test.afterEach(({ page }) => page.unrouteAll({
      behavior: "ignoreErrors",
    }));

    const archive = async (page) => {
      await stubStock(page, { [sku]: { inStock: true, available: 5 } });
      await page.route(/\/order\/(\?.*)?$/, async (route) => {
        if (route.request().resourceType() !== "document") {
          return route.fallback();
        }

        const res = await route.fetch();
        let html = await res.text();
        const quoted = `"?${sku}"?`;
        const rowRe = new RegExp(
          `<li[^>]*data-sku=${quoted}[^>]*>[\\s\\S]*?</li>`
        );

        expect(html).toMatch(rowRe);
        html = html.replace(rowRe, "");

        // The page's catalog keeps the item, as data/catalog.json does,
        // marked archived.
        html = html.replace(
          /(id="?order-data"?>)([\s\S]*?)(<\/script>)/,
          (all, open, json, close) => {
            const data = JSON.parse(json);

            for (const group of data.catalog.groups) {
              for (const item of group.items) {
                if (item.sku === sku) item.restock = "archived";
              }
            }

            return `${open}${JSON.stringify(data)}${close}`;
          }
        );
        // Search's products leave it out.
        html = html.replace(
          /(data-search-products>)([\s\S]*?)(<\/script>)/,
          (all, open, json, close) => `${open}${JSON.stringify(
            JSON.parse(json).filter((p) => p.sku !== sku)
          )}${close}`
        );

        return route.fulfill({ response: res, body: html });
      });
    };

    test("has no row under either choice, on hand or not",
      async ({ page }) => {
        await archive(page);
        await open(page);
        await expect(row(page, SKU.wings)).toBeVisible();
        for (const name of ["In stock", "Full catalog"]) {
          await show(page, name);
          await expect(row(page, sku)).toHaveCount(0);
          await expect(page.locator("#cat-wings .order-item:visible"))
            .toHaveCount(name === "In stock" ? 1 : 2);
        }
      });

    test("is not in search", async ({ page }) => {
      await archive(page);
      await open(page);

      const stock = page.waitForResponse("**/api/stock");

      await page.locator("[data-search-open]").click();
      await page.locator("#search-palette-input").fill("wings");
      await stock.catch(() => null);

      const rows = page.locator("#search-palette-list [role='option']");

      await expect(rows).toHaveCount(2);
      await expect(rows.and(page.locator(`[data-sku="${sku}"]`)))
        .toHaveCount(0);
    });

    test("is refused by ?add=, named", async ({ page }) => {
      await archive(page);
      await page.goto(`/order/?add=${sku}:2,${SKU.eggs}:1`);
      await expect(page.locator("#order-added")).toHaveText(
        "Added to your cart: 1 × Eggs, Grade A · Large. " +
        "Not available: Wings, 2.0 – 2.9 lbs."
      );
      await expect(new OrderPage(page).count).toHaveText("1 item");
    });
  });
});

test.describe("search and restock types (#267)", () => {
  const palette = (page) => {
    const dialog = page.locator("#search-palette");

    return {
      dialog,
      input: dialog.locator("#search-palette-input"),
      rows: dialog.locator("#search-palette-list [role='option']"),
      add: dialog.locator("[data-search-add]"),
      restock: dialog.locator("[data-search-restock]"),
    };
  };
  const find = async (page, query) => {
    const p = palette(page);
    const stock = page.waitForResponse("**/api/stock");

    await page.locator("[data-search-open]").click();
    await p.input.fill(query);
    await stock;

    return p;
  };

  test("lists every non-archived product with its label", async ({ page }) => {
    await page.goto("/about/");

    const p = await find(page, "sausage");

    await expect(p.rows).toHaveCount(2);

    const sweet = p.rows.and(page.locator(`[data-sku="${OUT.hiatus}"]`));

    await expect(sweet).toContainText("On hiatus");
    await expect(sweet).toHaveAttribute("data-stock", "out");
    await sweet.click();
    await expect(p.restock).toHaveText("On hiatus");
    await expect(p.add).toBeDisabled();

    // Cornish hens are archived (2026-v9).
    await p.input.fill("cornish");
    await expect(p.rows).toHaveCount(0);

    await p.input.fill("feet");
    await expect(p.rows.and(page.locator(`[data-sku="${OUT.soon}"]`)))
      .toContainText("Returning soon");

    await p.input.fill("eggs");
    await expect(p.rows).toHaveCount(3);
    await expect(p.rows.and(page.locator(`[data-sku="${SKU.eggs}"]`)))
      .toContainText("$7");
  });

  test("ignores what the order page shows", async ({ page }) => {
    for (const on of [true, false]) {
      await open(page);
      if (!on) await show(page, "Full catalog");
      await expect(choice(page, "In stock")).toBeChecked({ checked: on });

      const p = await find(page, "sweet");

      await expect(p.rows.and(page.locator(`[data-sku="${OUT.hiatus}"]`)))
        .toContainText("On hiatus");
    }
  });

  test("stock wins in search too", async ({ page }) => {
    await stubStock(page, { [OUT.hiatus]: { inStock: true, available: 4 } });
    await page.goto("/about/");

    const p = await find(page, "sweet");
    const sweet = p.rows.and(page.locator(`[data-sku="${OUT.hiatus}"]`));

    await expect(sweet).not.toHaveAttribute("data-stock", "out");
    await expect(sweet).toContainText("$");
    await expect(p.restock).toBeHidden();
    await expect(p.add).toBeEnabled();
  });
});
