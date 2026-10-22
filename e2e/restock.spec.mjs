// Restock types and the order page's Show control (#267, 6303165805,
// the `soon` amendment 6303183573 and the control in 6303649455).
// "In stock", the default, shows what is in stock; "Full catalog"
// also shows the rest, greyed, with a restock label and no way to add
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
// archived (James's corrections, #274 6330468558).
const OUT = {
  soon: "NFF-CHK-FET-0075-0125", // Feet: "Back soon"
  seasonal: "NFF-CHK-TND-15-99", // Tenders, 1.5 lbs and up
  hiatus: "NFF-CHK-SAUSWT", // Sweet Italian Sausage
  discontinued: "NFF-CHK-WHL-50-59", // Whole Chicken, 5.0 - 5.9 lbs
};
const LABEL = {
  soon: "Back soon",
  seasonal: "Back in spring",
  hiatus: "On hiatus",
  discontinued: "No longer available",
};
// No category is wholly out in the catalog since 2026-v9; selling
// out the maple links empties Sausage.
const MAPLE = "NFF-CHK-SAUMPL";
const SAUSAGE_OUT = { [MAPLE]: { inStock: false, available: 0 } };

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
  // the control stands alone, centered over the catalog, still named
  // "Show" for a screen reader.
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
        { width: 1280, height: 900 }, { width: 390, height: 800 },
      ]) {
        await page.setViewportSize(size);

        const offset = await page.locator(".order-intro").evaluate((el) => {
          const box = el.getBoundingClientRect();
          const seg = el.querySelector(".order-filter-seg")
            .getBoundingClientRect();

          return (seg.left + seg.width / 2) - (box.left + box.width / 2);
        });

        expect(Math.abs(offset), `${size.width}px`).toBeLessThan(2);
      }
    });

  test("Full catalog: out-of-stock rows show greyed with their label " +
    "and can't be added", async ({ page }) => {
    await stubStock(page, SAUSAGE_OUT);
    await open(page);
    await show(page, "Full catalog");

    for (const [type, sku] of Object.entries(OUT)) {
      const r = row(page, sku);

      await expect(r, type).toBeVisible();
      await expect(r).toHaveAttribute("data-stock", "out");
      await expect(r.locator(".order-item-stock")).toHaveText(LABEL[type]);
      await expect(r.locator(".order-qty")).toBeHidden();
      await expect(r.locator("[data-qty]")).toBeDisabled();
      for (const b of await r.locator("[data-step]").all()) {
        await expect(b).toBeDisabled();
      }
      await expect(r.getByText("Sold out", { exact: true })).toHaveCount(0);
    }

    // Greyed: the name in the secondary color, not the body's.
    const color = (sku) => row(page, sku).locator("label")
      .evaluate((el) => getComputedStyle(el).color);

    expect(await color(OUT.soon)).not.toBe(await color(SKU.eggs));

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

  test("an out-of-stock product can't be put in the cart by link",
    async ({ page }) => {
      await page.goto(`/order/?add=${OUT.seasonal}:2`);
      await expect(page.locator("#order-added"))
        .toContainText("No longer available: Tenders, 1.5 lbs and up.");
      await expect(new OrderPage(page).count).toHaveText("0 items");
    });

  test("the choice is remembered across reloads", async ({ page }) => {
    await open(page);
    await show(page, "Full catalog");
    await expect(row(page, OUT.seasonal)).toBeVisible();

    await page.reload();
    await expect(choice(page, "Full catalog")).toBeChecked();
    await expect(row(page, OUT.seasonal)).toBeVisible();

    await show(page, "In stock");
    await page.reload();
    await expect(choice(page, "In stock")).toBeChecked();
    await expect(row(page, OUT.seasonal)).toBeHidden();
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

  test("stock wins over seasonal, soon and hiatus",
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
      await row(page, OUT.seasonal).locator(".order-qty-add").click();
      await expect(new OrderPage(page).count).toHaveText("1 item");
    });

  test("a product that sells out mid-visit takes its label",
    async ({ page }) => {
      await stubStock(page, { [SKU.wings]: { inStock: false, available: 0 } });
      await open(page, { wings: 1 });
      await expect(row(page, SKU.wings)).toBeHidden();
      await show(page, "Full catalog");
      await expect(row(page, SKU.wings).locator(".order-item-stock"))
        .toHaveText("Back in spring");
      await expect(new OrderPage(page).count).toHaveText("0 items");
    });

  test("a product with no restock type stays hidden while out",
    async ({ page }) => {
      await open(page);
      // No product lacks a type today; take one away in the page.
      await row(page, OUT.seasonal).evaluate((li) => {
        li.dataset.restockLabel = "";
      });
      await show(page, "Full catalog");
      await expect(row(page, OUT.seasonal)).toBeHidden();
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
        // Its row is in the hidden "No longer available" section, for
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
        "Added to your cart: 1 × Eggs, Large. " +
        "No longer available: Wings, 2.0 – 2.9 lbs."
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

    await p.input.fill("eggs");
    await expect(p.rows).toHaveCount(3);
    await expect(p.rows.and(page.locator(`[data-sku="${OUT.soon}"]`)))
      .toContainText("Back soon");
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
