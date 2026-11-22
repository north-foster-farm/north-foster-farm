// Criteria tests for #402 (Header search: a plain site search in place
// of the palette), the boxes of its "Done when" list that are about the
// page, one test each, named for its box. Held out of every run by its
// name until the change lands: renamed to site-search.spec.mjs, it
// runs in the desktop and phone projects. The desktop project measures
// at the widths each box names; the phone project at its own (390 px).
// Boxes 6 and 8 (the likely queries, typo tolerance) and the data half
// of box 2 are unit tests in test/search-index.criteria.mjs.
//
// The seam, what the tests rely on:
// - The field is a combobox whose accessible name holds "Search". It
//   sits in a `role="search"` landmark (a <search> element or a form
//   with that role) that also holds its results panel, its Cancel and
//   X buttons and the no-match links.
// - Below 992 px the field is hidden until the header's magnifier, a
//   button in the banner whose name holds "Search", opens it.
// - The results are a listbox with a group per kind, each group named
//   by its heading ("Products", "Pages"), and options inside them.
// - A product result's row on the order page is the existing
//   `.order-item[data-sku]` row, and the "Full catalog" switch is the
//   existing `#order-show-all` radio.
// - X is a button in the search landmark named "Close search" or
//   "Clear search"; Cancel is a button named "Cancel".
// - The index is fetched from a path ending in `search.json`.
// - "Light" is a background whose relative luminance is 0.7 or more;
//   "dims without hiding" compares screenshots of the same patch of
//   the page before and after (darker by 5% or more, with at least a
//   sixth of its contrast left).
// Wording in results is a draft for James, so the tests read no result
// labels but the group names and "Cancel".

import { expect, test } from "./support/order.mjs";

const WIDE = 1280;
const PHONE_HEIGHT = 664;
const DESKTOP_HEIGHT = 900;
const OUT = "NFF-CHK-EGG-MD";
const WINGS = /^NFF-CHK-WNG-/;

const widthsFor = (project, widths) => (project === "desktop"
  ? widths : [null]);
const label = (w) => (w ? `${w} px` : "the phone's width");

const atWidth = async (page, width) => {
  if (width) {
    await page.setViewportSize({
      width, height: width >= 992 ? DESKTOP_HEIGHT : PHONE_HEIGHT,
    });
  }
};

const ui = (page) => {
  const field = page.getByRole("combobox", { name: /search/i });
  const region = page.getByRole("search").filter({ has: field });

  return {
    field,
    region,
    banner: page.getByRole("banner"),
    magnifier: page.getByRole("banner")
      .getByRole("button", { name: /search/i }),
    listbox: region.getByRole("listbox"),
    options: region.getByRole("option"),
    cancel: region.getByRole("button", { name: "Cancel", exact: true }),
    x: region.getByRole("button", { name: /^(close|clear) search$/i }),
  };
};

const wide = (page) => page.viewportSize().width >= 992;

// Opens search as a customer would: the field at 992 and up, the
// magnifier below.
const openSearch = async (page) => {
  const s = ui(page);

  if (wide(page)) {
    await s.field.click();
  } else {
    await s.magnifier.click();
  }
  await expect(s.field).toBeVisible();
  await expect(s.field).toBeFocused();
  await page.waitForTimeout(500);

  return s;
};

const typed = async (s, query) => {
  await s.field.fill(query);
  await expect(s.options.first()).toBeVisible();
};

// The background the element shows: its own, or the first opaque one
// behind it, as relative luminance.
const luminance = (locator) => locator.evaluate((el) => {
  let rgb = [255, 255, 255];

  for (let n = el; n; n = n.parentElement) {
    const m = getComputedStyle(n).backgroundColor.match(/[\d.]+/g);

    if (m && (m.length < 4 || Number(m[3]) > 0.5)) {
      rgb = m.slice(0, 3).map(Number);
      break;
    }
  }

  const [r, g, b] = rgb.map((v) => {
    const c = v / 255;

    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });

  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
});

// The mean and spread of a patch of the screen's brightness, read on a
// blank page so no site policy applies to the image.
const patch = async (page, clip) => {
  const png = await page.screenshot({ clip });
  const blank = await page.context().newPage();

  try {
    return await blank.evaluate(async (b64) => {
      const img = new Image();

      img.src = `data:image/png;base64,${b64}`;
      await img.decode();

      const canvas = document.createElement("canvas");

      canvas.width = img.width;
      canvas.height = img.height;

      const ctx = canvas.getContext("2d");

      ctx.drawImage(img, 0, 0);

      const { data } = ctx.getImageData(0, 0, img.width, img.height);
      let sum = 0;
      let sq = 0;
      const n = data.length / 4;

      for (let i = 0; i < data.length; i += 4) {
        const y = 0.2126 * data[i] + 0.7152 * data[i + 1]
          + 0.0722 * data[i + 2];

        sum += y;
        sq += y * y;
      }

      const mean = sum / n;

      return { mean, spread: Math.sqrt(Math.max(0, sq / n - mean * mean)) };
    }, png.toString("base64"));
  } finally {
    await blank.close();
  }
};

const isClosed = async (page, s, how) => {
  if (wide(page)) {
    await expect(s.listbox, how).toBeHidden();
    await expect(s.field, how).toHaveAttribute("aria-expanded", "false");
  } else {
    await expect(s.field, how).toBeHidden();
  }
};

test.describe("#402 site search", () => {
  test("box 1: the header's modal palette is gone: its dark sheet, "
    + "product card, Add button, keyboard-hint chips and their scripts "
    + "and styles", async ({ page }, info) => {
    for (const width of widthsFor(info.project.name, [WIDE, 390])) {
      await atWidth(page, width);
      await page.goto("/about/");

      const at = label(width);

      expect(await page.locator("dialog").count(), `${at}: no dialog`)
        .toBe(0);
      expect(await page.locator("[id*='search-palette'], "
        + "[class*='search-palette'], [data-search-palette]").count(),
      `${at}: no palette markup`).toBe(0);
      expect(await page.locator("kbd").count(),
        `${at}: no keyboard-hint chips`).toBe(0);

      // Its scripts and styles: nothing the page loads names it.
      const named = await page.evaluate(async () => {
        const urls = [
          ...[...document.styleSheets].map((s) => s.href),
          ...[...document.scripts].map((s) => s.src),
        ].filter((u) => u && new URL(u).origin === location.origin);
        const hits = [];

        for (const url of urls) {
          const body = await (await fetch(url)).text();

          if (/search-palette|searchPalette/.test(body)) hits.push(url);
        }

        return hits;
      });

      expect(named, `${at}: no script or style names the palette`)
        .toEqual([]);

      // Open, with a product found: no card, photo or Add.
      const s = await openSearch(page);

      await typed(s, "eggs");
      await expect(s.region.getByRole("button", { name: /add/i }),
        `${at}: no Add button`).toHaveCount(0);
      await expect(s.region.locator("img"), `${at}: no product card photo`)
        .toHaveCount(0);
      await expect(s.region.locator("kbd"), `${at}: no hint chips`)
        .toHaveCount(0);
      expect(await luminance(s.listbox), `${at}: no dark sheet`)
        .toBeGreaterThanOrEqual(0.7);
    }
  });

  // The box's data half is in test/search-index.criteria.mjs.
  test("box 2: Hugo writes /search.json at build time with products, "
    + "page sections, pages, delivery towns, quick facts and news, its "
    + "synonyms and keywords read from one data file, and a page loads "
    + "it only when search is first opened or focused (the page)",
  async ({ page }, info) => {
    for (const width of widthsFor(info.project.name, [WIDE, 390])) {
      const at = label(width);
      let loads = 0;
      const count = (request) => {
        if (/search\.json$/.test(new URL(request.url()).pathname)) {
          loads += 1;
        }
      };

      await atWidth(page, width);
      page.on("request", count);
      await page.goto("/about/");
      await page.waitForLoadState("load");
      await page.waitForTimeout(1_500);
      expect(loads, `${at}: not on page load`).toBe(0);

      let s = await openSearch(page);

      await expect.poll(() => loads, { message: `${at}: on first open` })
        .toBe(1);
      await typed(s, "eggs");
      await page.keyboard.press("Escape");
      await isClosed(page, s, `${at}: Esc closes`);

      s = await openSearch(page);
      await typed(s, "wings");
      await page.waitForTimeout(1_000);
      expect(loads, `${at}: not again on a second open`).toBe(1);
      page.off("request", count);
    }
  });

  test("box 3: at 992 px and up, a light search field sits in the "
    + "header row and its results open in a light panel under it, "
    + "grouped Products then Pages, with the page still visible",
  async ({ page, isMobile }) => {
    test.skip(isMobile, "the wide layout");

    for (const width of [992, WIDE]) {
      const at = `${width} px`;

      await atWidth(page, width);
      // The contact page, not /about/: at 1280 the about page's column
      // leaves the patch beside the panel blank, with no page in it to
      // compare (the implementer, 2026-11-21; how it runs, not what it
      // expects).
      await page.goto("/contact/");

      const s = ui(page);
      const brand = s.banner.getByRole("link", { name: /, home$/ });

      // The field is there before anything is pressed, in the row.
      await expect(s.field, `${at}: the field shows`).toBeVisible();
      await expect(s.magnifier.filter({ visible: true }),
        `${at}: no magnifier to press first`).toHaveCount(0);

      const field = await s.field.boundingBox();
      const header = await s.banner.boundingBox();
      const row = await brand.boundingBox();
      const middle = field.y + field.height / 2;

      expect(field.y, `${at}: inside the header`)
        .toBeGreaterThanOrEqual(header.y - 1);
      expect(field.y + field.height, `${at}: inside the header`)
        .toBeLessThanOrEqual(header.y + header.height + 1);
      expect(middle, `${at}: in the brand's row`)
        .toBeGreaterThanOrEqual(row.y);
      expect(middle, `${at}: in the brand's row`)
        .toBeLessThanOrEqual(row.y + row.height);
      expect(await luminance(s.field), `${at}: a light field`)
        .toBeGreaterThanOrEqual(0.7);

      // The page beside the panel, before and after.
      const vw = page.viewportSize().width;
      const top = header.y + header.height + 20;
      const away = field.x > vw / 2
        ? { x: 0, width: Math.min(300, field.x - 40) }
        : { x: vw - 300, width: 300 };
      const clip = { ...away, y: top, height: 300 };
      const before = await patch(page, clip);

      await s.field.click();
      await typed(s, "eggs");
      await page.waitForTimeout(500);

      const panel = await s.listbox.boundingBox();

      expect(panel.y, `${at}: the panel opens under the field`)
        .toBeGreaterThanOrEqual(field.y + field.height - 4);
      expect(panel.y, `${at}: right under it`)
        .toBeLessThanOrEqual(field.y + field.height + 32);
      expect(panel.x + panel.width, `${at}: beside the field`)
        .toBeGreaterThan(field.x);
      expect(panel.x, `${at}: beside the field`)
        .toBeLessThan(field.x + field.width);
      expect(panel.width, `${at}: a panel, not a sheet`)
        .toBeLessThan(vw * 0.75);
      expect(await luminance(s.listbox), `${at}: a light panel`)
        .toBeGreaterThanOrEqual(0.7);

      // Grouped, Products then Pages.
      const products = s.listbox.getByRole("group", { name: "Products" });
      const pages = s.listbox.getByRole("group", { name: "Pages" });

      await expect(products, `${at}: a Products group`).toBeVisible();
      await expect(pages, `${at}: a Pages group`).toBeVisible();
      await expect(products.getByRole("option").first()).toBeVisible();
      await expect(pages.getByRole("option").first()).toBeVisible();

      const first = await products.boundingBox();
      const second = await pages.boundingBox();

      expect(first.y, `${at}: Products before Pages`).toBeLessThan(second.y);

      // The page still shows beside it, neither hidden nor dimmed away.
      const after = await patch(page, clip);

      expect(before.spread, `${at}: the patch holds some of the page`)
        .toBeGreaterThan(5);
      expect(after.mean, `${at}: the page still shows`)
        .toBeGreaterThanOrEqual(before.mean * 0.85);
      expect(after.spread, `${at}: the page still shows`)
        .toBeGreaterThanOrEqual(before.spread * 0.5);
      await expect(page.locator("main")).toBeVisible();
      await expect(page.locator("[aria-modal='true']:visible"),
        `${at}: nothing modal`).toHaveCount(0);
    }
  });

  test("box 4: below 992 px, the magnifier opens a light full-width bar "
    + "under the header with the field focused and a Cancel button, over "
    + "a scrim that dims the page without hiding it",
  async ({ page }, info) => {
    for (const width of widthsFor(info.project.name, [390, 991])) {
      const at = label(width);

      await atWidth(page, width);
      await page.goto("/about/");

      const s = ui(page);
      const { width: vw, height: vh } = page.viewportSize();

      await expect(s.field, `${at}: no field until the magnifier`)
        .toBeHidden();

      const clip = {
        x: 0, y: Math.round(vh * 0.65), width: vw,
        height: Math.round(vh * 0.3),
      };
      const before = await patch(page, clip);

      await s.magnifier.click();
      await expect(s.field, `${at}: the field shows`).toBeVisible();
      await expect(s.field, `${at}: focused`).toBeFocused();
      await expect(s.cancel, `${at}: a Cancel button`).toBeVisible();
      await page.waitForTimeout(600);

      const bar = await s.region.boundingBox();
      const header = await s.banner.boundingBox();
      const field = await s.field.boundingBox();
      const cancel = await s.cancel.boundingBox();

      expect(bar.x, `${at}: full width`).toBeLessThanOrEqual(1);
      expect(bar.width, `${at}: full width`).toBeGreaterThanOrEqual(vw - 1);
      expect(bar.y, `${at}: under the header`)
        .toBeGreaterThanOrEqual(header.y + header.height - 2);
      await expect(s.banner, `${at}: the header stays in view`)
        .toBeInViewport();
      expect(bar.y + bar.height, `${at}: a bar, not a sheet`)
        .toBeLessThanOrEqual(clip.y);
      expect(await luminance(s.field), `${at}: a light field`)
        .toBeGreaterThanOrEqual(0.7);
      expect(await luminance(s.region), `${at}: a light bar`)
        .toBeGreaterThanOrEqual(0.7);
      expect(cancel.x, `${at}: Cancel beside the field`)
        .toBeGreaterThanOrEqual(field.x + field.width - 1);
      expect(Math.abs((cancel.y + cancel.height / 2)
        - (field.y + field.height / 2)), `${at}: in the field's row`)
        .toBeLessThanOrEqual(field.height / 2);

      // The scrim: the page below is darker, and still there.
      const after = await patch(page, clip);

      expect(before.spread, `${at}: the patch holds some of the page`)
        .toBeGreaterThan(5);
      expect(after.mean, `${at}: dims the page`)
        .toBeLessThanOrEqual(before.mean * 0.95);
      expect(after.spread, `${at}: without hiding it`)
        .toBeGreaterThanOrEqual(before.spread / 6);
    }
  });

  test("box 5: a product result goes to its row on the order page "
    + "(switching to Full catalog when it is out of stock), with no Add "
    + "button; Enter opens the top result; Esc, Cancel, X or a tap "
    + "outside closes search", async ({ page, stock, isMobile }, info) => {
    await stock.pin({ [OUT]: 0 });

    for (const width of widthsFor(info.project.name, [WIDE, 390])) {
      const at = label(width);

      // No Add button, and an out of stock product's row, shown.
      await atWidth(page, width);
      await page.goto("/about/");

      let s = await openSearch(page);

      await typed(s, "medium eggs");
      await expect(s.region.getByRole("button", { name: /add/i }),
        `${at}: no Add button`).toHaveCount(0);
      await expect(s.options.locator("button"), `${at}: options hold no `
        + "button").toHaveCount(0);

      const products = s.listbox.getByRole("group", { name: "Products" });

      await products.getByRole("option", { name: /medium/i }).first()
        .click();
      await expect(page, `${at}: to the order page`).toHaveURL(/\/order\//);

      const row = page.locator(`.order-item[data-sku='${OUT}']`);

      await expect(page.locator("#order-show-all"),
        `${at}: Full catalog chosen`).toBeChecked();
      await expect(row, `${at}: its row shows`).toBeVisible();
      await expect(row, `${at}: its row in view`).toBeInViewport();

      // Enter opens the top result.
      await page.goto("/about/");
      s = await openSearch(page);
      await typed(s, "wings");
      await page.keyboard.press("Enter");
      await expect(page, `${at}: Enter goes to the order page`)
        .toHaveURL(/\/order\//);
      await page.waitForTimeout(1_000);
      expect(await page.locator(".order-item[data-sku]").evaluateAll(
        (rows) => rows.filter((r) => {
          const box = r.getBoundingClientRect();

          return box.height > 0 && box.bottom > 0
            && box.top < innerHeight;
        }).map((r) => r.dataset.sku),
      ), `${at}: a Wings row in view`).toEqual(
        expect.arrayContaining([expect.stringMatching(WINGS)]),
      );

      // Closing.
      await page.goto("/about/");
      s = await openSearch(page);
      await typed(s, "eggs");
      await page.keyboard.press("Escape");
      await isClosed(page, s, `${at}: Esc closes`);

      if (wide(page)) {
        s = await openSearch(page);
        await typed(s, "eggs");
        await s.x.click();
        await isClosed(page, s, `${at}: X closes`);
      } else {
        s = await openSearch(page);
        await typed(s, "eggs");
        await s.cancel.click();
        await isClosed(page, s, `${at}: Cancel closes`);
      }

      s = await openSearch(page);
      if (wide(page)) await typed(s, "eggs");

      const { height: vh } = page.viewportSize();
      const url = page.url();

      if (isMobile) {
        await page.touchscreen.tap(page.viewportSize().width / 2, vh - 40);
      } else if (wide(page)) {
        await page.mouse.click(5, vh - 5);
      } else {
        await page.mouse.click(page.viewportSize().width / 2, vh - 40);
      }
      await isClosed(page, s, `${at}: a tap outside closes`);
      expect(page.url(), `${at}: and goes nowhere`).toBe(url);
    }
  });

  test("box 7: a query with no match keeps what was typed and offers "
    + "Order, Delivery policy and Contact", async ({ page }, info) => {
    for (const width of widthsFor(info.project.name, [WIDE, 390])) {
      const at = label(width);

      await atWidth(page, width);
      await page.goto("/about/");

      const s = await openSearch(page);

      await s.field.fill("zzqx");
      await page.waitForTimeout(800);
      await expect(s.field, `${at}: keeps what was typed`)
        .toHaveValue("zzqx");
      await expect(s.options, `${at}: no match`).toHaveCount(0);
      await expect(s.region, `${at}: says what was typed`)
        .toContainText("zzqx");
      for (const path of ["/order/", "/delivery-policy/", "/contact/"]) {
        await expect(s.region.locator(`a[href$='${path}']`).first(),
          `${at}: offers ${path}`).toBeVisible();
      }
    }
  });

  test("box 9: the field follows the ARIA 1.2 combobox pattern, with "
    + "grouped listbox options and a polite live region announcing the "
    + "count", async ({ page }, info) => {
    for (const width of widthsFor(info.project.name, [WIDE, 390])) {
      const at = label(width);

      await atWidth(page, width);
      await page.goto("/about/");

      const s = await openSearch(page);

      await expect(s.field, `${at}: an input`)
        .toHaveJSProperty("tagName", "INPUT");
      await expect(s.field, `${at}: lists as it is typed in`)
        .toHaveAttribute("aria-autocomplete", "list");
      await expect(s.field, `${at}: collapsed while empty`)
        .toHaveAttribute("aria-expanded", "false");

      await typed(s, "eggs");
      await expect(s.field, `${at}: expanded with results`)
        .toHaveAttribute("aria-expanded", "true");

      const controls = await s.field.getAttribute("aria-controls");

      expect(controls, `${at}: aria-controls names the listbox`)
        .toBeTruthy();
      await expect(page.locator(`[id='${controls}']`),
        `${at}: aria-controls is the listbox`).toHaveAttribute("role",
        "listbox");

      // Grouped: every option sits in a named group.
      const groups = s.listbox.getByRole("group");
      const names = await groups.evaluateAll((els) => els.map((g) => {
        const by = g.getAttribute("aria-labelledby");

        return (by ? by.split(/\s+/).map((id) => document
          .getElementById(id)?.textContent || "").join(" ")
          : g.getAttribute("aria-label") || "").trim();
      }));

      expect(names.length, `${at}: groups`).toBeGreaterThan(0);
      expect(names.every(Boolean), `${at}: each group named`).toBe(true);

      let inGroups = 0;

      for (let i = 0; i < names.length; i += 1) {
        inGroups += await groups.nth(i).getByRole("option").count();
      }

      const total = await s.options.count();

      expect(inGroups, `${at}: every option in a group`).toBe(total);

      // Arrows move the active option; focus stays in the field.
      await page.keyboard.press("ArrowDown");

      const active = await s.field.getAttribute("aria-activedescendant");

      expect(active, `${at}: ArrowDown sets the active option`)
        .toBeTruthy();
      await expect(page.locator(`[id='${active}']`))
        .toHaveAttribute("role", "option");
      await expect(page.locator(`[id='${active}']`))
        .toHaveAttribute("aria-selected", "true");
      await expect(s.field, `${at}: focus stays in the field`)
        .toBeFocused();

      // A polite live region says how many.
      const live = page.locator("[aria-live='polite'], [role='status']")
        .filter({ hasText: new RegExp(`\\b${total}\\b`) });

      await expect(live.first(), `${at}: announces ${total}`)
        .toBeAttached();

      await typed(s, "wings");

      const now = await s.options.count();

      await expect(page.locator("[aria-live='polite'], [role='status']")
        .filter({ hasText: new RegExp(`\\b${now}\\b`) }).first(),
      `${at}: announces ${now} after a new query`).toBeAttached();
    }
  });
});
