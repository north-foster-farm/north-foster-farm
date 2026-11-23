// Criteria tests for #898 (Site search: move the results panel outside
// the main navigation), its two (test) boxes on the running page, one
// test each, in the states the built HTML can't show: the panel
// closed, showing results, and showing "Nothing matches". The built
// markup is checked in test/search-panel-nav.criteria.mjs. Held out of
// every run by its name until the change lands: renamed to
// search-panel-nav.spec.mjs, it runs in the desktop project at 1280
// and 390 px and in the phone project at its own width.
//
// The seam, as e2e/site-search.spec.mjs's: the field is a combobox
// named "Search..." in a role="search" landmark, opened by the
// banner's magnifier below 992 px; its results are a listbox of
// options; "zzqx" matches nothing and "delivery" matches something.

import { expect, test } from "./support/order.mjs";

const WIDE = 1280;
const POLICY = "a[href$='/delivery-policy/']";
const MAIN = "nav[aria-label='Main']";

const widthsFor = (project) => (project === "desktop" ? [WIDE, 390] : [null]);
const label = (w) => (w ? `${w} px` : "the phone's width");

const atWidth = async (page, width) => {
  if (width) {
    await page.setViewportSize({ width, height: width >= 992 ? 900 : 664 });
  }
};

const ui = (page) => {
  const field = page.getByRole("combobox", { name: /search/i });
  const region = page.getByRole("search").filter({ has: field });

  return {
    field,
    region,
    magnifier: page.getByRole("banner")
      .getByRole("button", { name: /search/i }),
    options: region.getByRole("option"),
  };
};

const openSearch = async (page) => {
  const s = ui(page);

  if (page.viewportSize().width >= 992) await s.field.click();
  else await s.magnifier.click();
  await expect(s.field).toBeFocused();

  return s;
};

// The three states the box names, each reached in turn on one page.
const STATES = [
  ["closed", async () => {}],
  ["showing results", async (s) => {
    await s.field.fill("delivery");
    await expect(s.options.first()).toBeVisible();
  }],
  ["showing \"Nothing matches\"", async (s, page) => {
    await s.field.fill("zzqx");
    await expect(s.region.getByText(/Nothing matches/)).toBeVisible();
    await expect(s.options).toHaveCount(0);
    await expect(page.locator(`[data-find-none] ${POLICY}`)).toBeVisible();
  }],
];

// Whether the element sits inside any nav landmark.
const inNav = (locator) => locator.evaluate((el) => !!el.closest("nav"));

test.describe("#898 search panel outside the main navigation", () => {
  test("No link to the delivery policy is inside nav[aria-label=\"Main\"], "
    + "with the search panel closed, showing results, or showing "
    + "\"Nothing matches\"", async ({ page }, info) => {
    for (const width of widthsFor(info.project.name)) {
      await atWidth(page, width);
      await page.goto("/about/");

      let s = ui(page);

      for (const [state, reach] of STATES) {
        if (state !== "closed" && !(await s.field.isVisible())) {
          s = await openSearch(page);
        }
        await reach(s, page);
        await expect(page.locator(`${MAIN} ${POLICY}`),
          `${label(width)}, ${state}`).toHaveCount(0);
      }
    }
  });

  test("The search panel's results and its \"Nothing matches\" links are "
    + "outside every nav landmark, and the field still names the list it "
    + "controls (aria-controls, the listbox role)", async ({ page }, info) => {
    for (const width of widthsFor(info.project.name)) {
      const at = label(width);

      await atWidth(page, width);
      await page.goto("/about/");

      const s = await openSearch(page);
      const controls = await s.field.getAttribute("aria-controls");

      expect(controls, `${at}: the field names its list`).toBeTruthy();

      const list = page.locator(`[id="${controls}"]`);

      await expect(list, `${at}: the list is a listbox`)
        .toHaveAttribute("role", "listbox");

      await s.field.fill("delivery");
      await expect(s.options.first()).toBeVisible();
      expect(await inNav(list), `${at}: the results are in a nav`).toBe(false);
      expect(await inNav(s.options.first()),
        `${at}: a result is in a nav`).toBe(false);

      await s.field.fill("zzqx");

      const links = page.locator("[data-find-none] a");

      await expect(links.first()).toBeVisible();
      expect(await links.count(), `${at}: the no-match links`)
        .toBeGreaterThanOrEqual(3);
      for (const link of await links.all()) {
        expect(await inNav(link),
          `${at}: ${await link.getAttribute("href")} is in a nav`).toBe(false);
      }
    }
  });
});
