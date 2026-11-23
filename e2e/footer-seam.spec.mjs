// Criteria tests for #948 (Footer: the Get in touch buttons sit on a
// hairline seam above the farm silhouette), written from the issue's
// words before the fix. One test per box marked (test), named for it:
// boxes 1 to 4. Box 5 is James's sign-off on staging, on desktop.
//
// Held out of every run by playwright.config.mjs's `held` list until
// the fix lands: deleting its line there turns it on.
//
// What the tests read, and the reading each rests on:
// - The Get in touch band is the home page's `.touch` whose eyebrow
//   says "Get in touch"; its buttons are the links "Email us" and
//   "Call or text us" in it.
// - The farm silhouette's graphic is the footer: `footer.site-footer`,
//   which opens with the dark room the shape rises into, and the shape
//   itself, `.footer-base`, whose box top is where the shape begins
//   and whose negative top margin is the shape's height (_footer.scss).
// - What shows is read off screenshots, decoded on a blank page's
//   canvas, a strip the full width of the page: the columns under the
//   two buttons are left out, so only what runs across the page counts.
//
// Provisional, on readings James may overrule:
// - "Clear space" is at least CLEAR (24px, 1.5rem) of nothing but the
//   band's own color under the buttons, on screen, and as much between
//   the buttons and each edge of the footer and of the shape below
//   them. The footer's top counts because the issue reads "no space
//   below the buttons" there: the band itself gives its buttons room
//   before the footer begins. If James takes the fix as only removing
//   the line, the footer-top check in `clearAt` goes and the others
//   stay.
// - A hairline is a row in which at least half the columns differ, by
//   more than TOL in a channel, from the rows two above and two below
//   it in the same column: a line up to three pixels thick across the
//   page, where the fog over the roofline is a slow gradient and a
//   roof's edge a step. Rows are read from under the buttons to just
//   past the shape's top.
// - Box 4's "light row" is the ornament row #277 put above the band,
//   gone since #226 (footer.spec.mjs, "above the footer"): its place is
//   nowhere, so it is checked to stay gone. The rows the footer has
//   are each held to its place relative to the shape, the same as on
//   a page whose band (Shop now, /about/) the fix has no reason to
//   touch, and the links to 40px under the shape's full height.
//
// Expected on next: box 1 fails, the buttons sitting on the band's
// bottom edge, where the footer begins. Box 2's checks of the boxes
// (one color, no border, no gap) are guards that pass on next; its
// check of the pixels fails only where the runner's Chromium paints
// the hairline James saw, which a cloud run cannot try. Box 3 fails as
// box 1 does. Box 4 is a guard and passes on next.

import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { expect, test } from "./support/order.mjs";

const OUT = join(import.meta.dirname, "..", "test-results", "footer-seam");
const WIDTHS = [390, 768, 992, 1200, 1440, 1920];
const CLEAR = 24;
const TOL = 3;
const LINE = 0.5;
// Whole pixel rows between the band's edge, rounded, and each row a
// probe at the edge reads (seamAt).
const STEP = 3;
// How far a footer row may sit from its place, in px: Chromium lays
// out in 1/64px units, so a box whose offset is fractional reads a
// unit off (39.98 for 40) where nothing visible moved (rowsOf).
const SLACK = 0.05;

const desktopOnly = (info) => test.skip(info.project.name !== "desktop",
  "the desktop project sets each width the box names");

const open = async (page, width, path = "/") => {
  await page.setViewportSize({ width, height: 900 });
  await page.goto(path);
  await page.waitForLoadState("load");
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
  await page.mouse.move(0, 0);
};

// The band, its buttons, the footer and the shape, in document
// coordinates, with the shape's height and the band's color.
const layout = (page) => page.evaluate(() => {
  const at = (el) => {
    const r = el.getBoundingClientRect();

    return { top: r.top + scrollY, bottom: r.bottom + scrollY,
      left: r.left, right: r.right };
  };
  const band = [...document.querySelectorAll(".touch")].find((el) =>
    /get in touch/i.test(el.querySelector(".touch-eyebrow")?.textContent
      ?? ""));
  const buttons = [...band.querySelectorAll("a")].filter((a) =>
    ["Email us", "Call or text us"].includes(a.textContent.trim()));
  const shape = document.querySelector(".footer-base");

  return {
    band: at(band),
    color: getComputedStyle(band).backgroundColor,
    names: buttons.map((a) => a.textContent.trim()),
    buttons: buttons.map(at),
    footer: at(document.querySelector("footer.site-footer")),
    shape: at(shape),
    rise: -parseFloat(getComputedStyle(shape).marginTop),
  };
});

const rgb = (css) => css.match(/\d+(\.\d+)?/g).slice(0, 3).map(Number);

// A full-width strip of the page, document rows top to top + height,
// scrolled to the middle of the window and shot at CSS pixels. Returns
// the picture and where the rows start in it.
const shoot = async (page, top, height, path) => {
  const viewport = page.viewportSize();

  await page.evaluate((y) => window.scrollTo(0, y),
    Math.max(0, top - (viewport.height - height) / 2));
  await page.waitForTimeout(100);

  const scrolled = await page.evaluate(() => window.scrollY);
  const y = Math.floor(top - scrolled);

  return {
    png: await page.screenshot({
      clip: { x: 0, y, width: viewport.width, height: Math.ceil(height) },
      animations: "disabled", scale: "css", ...(path ? { path } : {}),
    }),
    offset: top - scrolled - y,
  };
};

// Each row of the picture: whether every counted column is the band's
// color, and the share of counted columns that differ from the rows
// two above and two below. Columns in `skip` ([left, right] pairs) are
// not counted. Decoded on about:blank, where no page's CSP applies.
const readRows = async (page, png, color, skip) => {
  const blank = await page.context().newPage();

  try {
    return await blank.evaluate(async ({ b64, band, gaps, tol }) => {
      const img = new Image();

      img.src = `data:image/png;base64,${b64}`;
      await img.decode();

      const canvas = document.createElement("canvas");

      canvas.width = img.width;
      canvas.height = img.height;

      const ctx = canvas.getContext("2d", { willReadFrequently: true });

      ctx.drawImage(img, 0, 0);

      const { data } = ctx.getImageData(0, 0, img.width, img.height);
      const px = (x, y) => data.slice((y * img.width + x) * 4,
        (y * img.width + x) * 4 + 3);
      const far = (a, b) => a.some((v, i) => Math.abs(v - b[i]) > tol);
      const cols = [];

      for (let x = 0; x < img.width; x += 1) {
        if (!gaps.some(([l, r]) => x >= l && x <= r)) cols.push(x);
      }

      return [...Array(img.height).keys()].map((y) => ({
        clear: cols.every((x) => !far(px(x, y), band)),
        line: y < 2 || y >= img.height - 2 ? 0
          : cols.filter((x) => far(px(x, y), px(x, y - 2))
            && far(px(x, y), px(x, y + 2))).length / cols.length,
      }));
    }, { b64: png.toString("base64"), band: color, gaps: skip, tol: TOL });
  } finally {
    await blank.close();
  }
};

const under = (g) => g.buttons.map((b) => [Math.floor(b.left) - 6,
  Math.ceil(b.right) + 6]);

// Box 1, at one width: room under the buttons, in the boxes and on
// screen.
const clearAt = async (page, width) => {
  await open(page, width);

  const g = await layout(page);

  expect(g.names, `${width}px: the band's two buttons`)
    .toEqual(["Email us", "Call or text us"]);

  const top = Math.min(...g.buttons.map((b) => b.top));
  const bottom = Math.max(...g.buttons.map((b) => b.bottom));

  for (const [name, edge] of [["the footer", g.footer.top],
    ["the silhouette's shape", g.shape.top]]) {
    if (edge <= top) continue;
    expect(edge - bottom, `${width}px: from the buttons down to the top ` +
      `of ${name}`).toBeGreaterThanOrEqual(CLEAR);
  }

  // On screen: rows of nothing but the band's color under the buttons,
  // down to the first row with anything else in it, from the row the
  // buttons end in (their own columns are not counted).
  const from = Math.floor(bottom);
  const { png, offset } = await shoot(page, from,
    Math.min(Math.max(g.shape.top - from + 8, CLEAR + 8), 600));
  const rows = (await readRows(page, png, rgb(g.color), under(g)))
    .slice(Math.round(offset));
  const first = rows.findIndex((row) => !row.clear);
  const gap = first < 0 ? rows.length : first;

  expect(gap, `${width}px: clear rows under the buttons before anything ` +
    "shows").toBeGreaterThanOrEqual(CLEAR);
};

// Box 2, at one width: the band's edge and the footer's meet in one
// color with nothing drawn at the edge, and no row reads as a line,
// with a picture of the strip for James.
const seamAt = async (page, width, info) => {
  await open(page, width);

  const g = await layout(page);
  const seam = g.band.bottom;

  await page.evaluate((y) => window.scrollTo(0, y - innerHeight / 2), seam);
  await page.waitForTimeout(100);

  const edge = await page.evaluate((step) => {
    const band = [...document.querySelectorAll(".touch")].find((el) =>
      /get in touch/i.test(el.querySelector(".touch-eyebrow")?.textContent
        ?? ""));
    const y = band.getBoundingClientRect().bottom;
    const clear = (c) => c === "transparent" || /,\s*0\)$/.test(c);
    const painted = (x, py) => {
      let el = document.elementFromPoint(x, py);

      while (el && clear(getComputedStyle(el).backgroundColor)
        && getComputedStyle(el).backgroundImage === "none") {
        el = el.parentElement;
      }
      if (!el) return null;

      const r = el.getBoundingClientRect();

      return { el, name: el.className || el.tagName, top: r.top,
        bottom: r.bottom, color: getComputedStyle(el).backgroundColor };
    };
    // The probes read whole pixel rows clear of the edge, not a
    // fraction of a pixel off it. Where the edge is fractional
    // (4996.797px down at 1280px), Chromium hit-tests the footer's
    // block in the edge's own pixel row, so y - 0.5 found the footer on
    // a page that is right and the "gap" measured was that block's
    // height. Rounding the edge, then reading the middle of the row
    // STEP rows away on each side, stays on the side meant whatever
    // way the edge snaps, and clear of anything a few pixels thick
    // painted across it.
    const row = Math.round(y);
    const above = painted(8, row - step - 0.5);
    const below = painted(8, row + step + 0.5);
    const strip = (p) => p && { name: p.name, top: p.top, bottom: p.bottom,
      color: p.color };
    // Every box running at least half the page wide with its top or
    // bottom at the edge, and what it draws there.
    const drawn = [...document.querySelectorAll("body *")].flatMap((el) => {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      const side = [];

      if (r.width < innerWidth / 2) return [];
      if (Math.abs(r.bottom - y) < 1) side.push("Bottom");
      if (Math.abs(r.top - y) < 1) side.push("Top");

      return side.flatMap((s) => {
        const marks = [];

        if (parseFloat(cs[`border${s}Width`]) > 0
          && !clear(cs[`border${s}Color`])) marks.push(`border-${s}`);
        if (cs.outlineStyle !== "none" && parseFloat(cs.outlineWidth) > 0) {
          marks.push("outline");
        }
        if (cs.boxShadow !== "none") marks.push("box-shadow");

        return marks.map((m) => `${el.className || el.tagName}: ${m}`);
      });
    });

    return { above: strip(above), below: strip(below),
      same: Boolean(above) && above.el === below?.el, drawn };
  }, STEP);

  expect(edge.above, `${width}px: the band paints above its edge`)
    .not.toBeNull();
  expect(edge.below, `${width}px: something paints below the edge`)
    .not.toBeNull();
  expect(edge.same, `${width}px: the probes either side of the edge ` +
    `read two boxes, not ${edge.above.name} twice`).toBe(false);
  expect(edge.below.color, `${width}px: ${edge.below.name} under the ` +
    `band's edge shares ${edge.above.name}'s color`)
    .toBe(edge.above.color);
  expect(Math.abs(edge.below.top - edge.above.bottom),
    `${width}px: no gap between ${edge.above.name} and ${edge.below.name}`)
    .toBeLessThan(0.01);
  expect(edge.drawn, `${width}px: nothing drawn along the edge`)
    .toEqual([]);

  // The picture for James: the buttons, the edge and the shape's top.
  mkdirSync(OUT, { recursive: true });

  const file = join(OUT, `seam-${width}.png`);
  const above = Math.min(...g.buttons.map((b) => b.top)) - 40;

  await shoot(page, above, Math.min(g.shape.top + g.rise + 20 - above,
    800), file);
  await info.attach(`Get in touch band and footer at ${width}px`, {
    path: file, contentType: "image/png",
  });

  // On screen: one color either side of the band's edge, and no row
  // from under the buttons to past the shape's top that reads as a
  // line across the page. The rows start a little above the buttons'
  // bottom, so a line right under them has rows on both sides.
  const from = Math.floor(Math.max(...g.buttons.map((b) => b.bottom))) - 3;
  const to = Math.max(g.shape.top, seam) + 4;
  const { png, offset } = await shoot(page, from,
    Math.min(Math.max(to - from, 8), 600));
  const rows = (await readRows(page, png, rgb(g.color), under(g)))
    .slice(Math.round(offset));
  const lines = rows.flatMap((row, i) => (row.line >= LINE
    ? [`${Math.round(from + i)}px (${Math.round(row.line * 100)}%)`]
    : []));

  expect(lines, `${width}px: rows that read as a line across the page`)
    .toEqual([]);
  // Whole rows STEP off the rounded edge, as the probes above read.
  for (const dy of [-STEP - 1, STEP]) {
    const i = Math.round(seam) + dy - from;

    if (i >= 0 && i < rows.length) {
      expect(rows[i].clear, `${width}px: ${dy < 0 ? "above" : "below"} ` +
        "the band's edge, the band's color").toBe(true);
    }
  }
};

// Box 4, at one width: each of the footer's rows relative to the
// shape's top, and where the links start under it.
const rowsOf = async (page, width, path) => {
  await open(page, width, path);

  return page.evaluate(() => {
    const shape = document.querySelector(".footer-base");
    const s = shape.getBoundingClientRect();
    const place = (sel) => {
      const r = document.querySelector(`footer.site-footer ${sel}`)
        .getBoundingClientRect();

      return [r.left, r.right, r.top - s.top, r.height]
        .map((n) => Math.round(n * 100) / 100);
    };

    const links = place("nav[aria-label='Footer']");
    const rise = -parseFloat(getComputedStyle(shape).marginTop);

    return {
      links,
      signup: place("[data-farm-list-block]"),
      contact: place(".footer-contact"),
      copyright: place(".footer-copyright"),
      shape: Math.round(s.height * 100) / 100,
      under: Math.round((links[2] - rise) * 100) / 100,
      ornament: document.querySelectorAll(".ticker-slot").length,
    };
  });
};

test.describe("Get in touch and the silhouette (#948)", () => {
  test("At 1280 px there is clear space between the Get in touch buttons " +
    "and the top of the farm silhouette: the buttons do not touch or " +
    "overlap it", async ({ page }, info) => {
    desktopOnly(info);
    await clearAt(page, 1280);
  });

  test("No hairline or seam shows across the page where the silhouette " +
    "begins, at 1280 px", async ({ page }, info) => {
    desktopOnly(info);
    await seamAt(page, 1280, info);
  });

  test("The same holds at 390, 768, 992, 1200, 1440 and 1920 px",
    async ({ page }, info) => {
      desktopOnly(info);
      for (const width of WIDTHS) {
        await clearAt(page, width);
        await seamAt(page, width, info);
      }
    });

  test("Nothing else in the footer moves: the link columns, the news " +
    "sign-up and the light row keep their places", async ({ page }, info) => {
    desktopOnly(info);
    for (const width of [1280, ...WIDTHS]) {
      const home = await rowsOf(page, width, "/");
      const about = await rowsOf(page, width, "/about/");

      expect(home.ornament, `${width}px: no light row on the home page`)
        .toBe(0);
      expect(about.ornament, `${width}px: no light row on /about/`).toBe(0);
      // Within SLACK, not exactly: the band's edge now sits at a
      // fractional position, so a row can read one 1/64px layout unit
      // off (39.98 for 40) where nothing visible moved.
      expect(Math.abs(home.under - 40), `${width}px: the links start 40px ` +
        `under the shape's full height (${home.under})`)
        .toBeLessThan(SLACK);
      expect(Math.abs(home.shape - about.shape), `${width}px: the shape's ` +
        `height matches /about/'s (${home.shape}, ${about.shape})`)
        .toBeLessThan(SLACK);
      for (const name of ["links", "signup", "contact", "copyright"]) {
        ["left", "right", "top", "height"].forEach((side, i) => {
          expect(Math.abs(home[name][i] - about[name][i]), `${width}px: ` +
            `the ${name} row's ${side} sits where /about/'s does ` +
            `(${home[name][i]}, ${about[name][i]})`).toBeLessThan(SLACK);
        });
      }
    }
  });
});
