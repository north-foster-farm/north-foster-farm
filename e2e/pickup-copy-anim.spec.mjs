// Criteria test for the #703 box James added after he checked the
// second revision on staging (2026-11-21, about 5 PM: "Otherwise it
// looks good now"), written before the change, from the box alone and
// named for it word for word. The card and its parts are those of
// e2e/pickup-days.spec.mjs.
//
// Held out of every run by its name (playwright.config.mjs matches
// *.spec.mjs). The change that meets the box turns it on with
//
//   git mv e2e/pickup-copy-anim.criteria.mjs \
//     e2e/pickup-copy-anim.spec.mjs
//
// and maps it in e2e/dispatch.json wherever pickup-days.spec.mjs is,
// with a row for its own path.
//
// The seam is the rendered button, frame by frame: a sampler on
// requestAnimationFrame records Copy's width, the opacity on screen of
// every part of it that holds text (its own opacity times its
// ancestors' up to the button) and the icon's box against the button's
// left edge, from just before the tap until Copy reads Copy again.
// Nothing reads a class, a stylesheet or the script, so any markup
// that eases the width and fades the word meets it. "Eases" means a
// frame shows a width between the two words' widths; "fades" means a
// frame shows a word at an opacity between 0 and 1. With reduced
// motion neither may happen. Checked at 390 px, where James looks,
// and at 1440 px.

import {
  OrderPage, expect, test,
} from "./support/order.mjs";
import {
  DROP, FOSTER, cannedScheduled, datesWith,
} from "./support/scheduled.mjs";

const PHONE = { width: 390, height: 844 };
const WIDE = { width: 1440, height: 900 };

// A frame's width counts as between the two words' widths when it is
// this far from both, and a word counts as fading when its opacity is
// this far from 0 and from 1, so rounding never passes for motion.
// The icon's place and size may drift by PX too: the site-wide hover
// and press lift on .btn leaves its box a fraction of a pixel off
// while a mouse holds the button (#703).
const PX = 1;
const FADE = 0.05;

const grouped = () => datesWith([
  { place: DROP, days: [3, 10] },
  { place: FOSTER, days: [3, 9] },
]);

// The clipboard as a list of what was written, so Copy succeeds in
// every browser (as in e2e/pickup-days.spec.mjs).
const stubClipboard = (page) => page.addInitScript(() => {
  window.copiedText = [];
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: async (t) => { window.copiedText.push(t); },
      readText: async () => window.copiedText.at(-1) || "",
    },
  });
});

const openPickups = async (page, size) => {
  await page.setViewportSize(size);
  await stubClipboard(page);
  await cannedScheduled(page, grouped());

  const order = new OrderPage(page);

  await order.open({ eggs: 1 }, { method: "scheduled" });
  await expect(page.locator("#scheduled-pickups .order-pickup").first())
    .toBeVisible();
  await order.scrollSettled();
};

// Starts recording the first card's Copy button on every frame.
const startSampling = (button) => button.evaluate((el) => {
  const icon = el.querySelector("svg");
  const shown = (node) => {
    let o = 1;

    for (let n = node; n && n !== el.parentElement; n = n.parentElement) {
      o *= Number(getComputedStyle(n).opacity);
    }

    return o;
  };
  const wordy = (node) => [...node.childNodes]
    .some((c) => c.nodeType === Node.TEXT_NODE && c.textContent.trim());
  const parts = () => [el, ...el.querySelectorAll("*")].filter(wordy);
  const samples = [];

  window.copySamples = samples;
  window.copySampling = true;

  const frame = () => {
    const b = el.getBoundingClientRect();
    const i = icon.getBoundingClientRect();

    samples.push({
      t: performance.now(),
      width: b.width,
      icon: { x: i.left - b.left, width: i.width, height: i.height,
        opacity: shown(icon) },
      words: parts().map((p) => ({ text: p.textContent.trim(),
        opacity: shown(p) })),
    });
    if (window.copySampling) requestAnimationFrame(frame);
  };

  requestAnimationFrame(frame);
});

const stopSampling = (page) => page.evaluate(() => {
  window.copySampling = false;

  return window.copySamples;
});

const between = (w, a, b) => w > Math.min(a, b) + PX
  && w < Math.max(a, b) - PX;
const fading = (s) => s.words.some((w) => w.opacity > FADE
  && w.opacity < 1 - FADE);

// Taps Copy on the first card and records it until it reads Copy
// again: its widths as Copy and as Copied, and the frames of the way
// there (to) and of the way back (back).
const tapAndRecord = async (page) => {
  const button = page.locator("#scheduled-pickups .order-pickup").first()
    .getByRole("button", { name: /^Cop(y|ied)$/ });

  await expect(button).toBeVisible();

  const copy = (await button.boundingBox()).width;

  await startSampling(button);
  await button.click();
  await expect(button).toHaveAccessibleName("Copied");
  await page.waitForTimeout(800);

  const copied = (await button.boundingBox()).width;

  await expect(button).toHaveAccessibleName("Copy", { timeout: 5000 });
  await page.waitForTimeout(800);

  const samples = await stopSampling(page);
  const at = samples.map((s) => Math.abs(s.width - copied) <= 0.5);
  const first = at.indexOf(true);
  const last = at.lastIndexOf(true);

  return {
    copy,
    copied,
    samples,
    to: samples.slice(0, first + 30),
    back: samples.slice(last),
  };
};

test.describe("pickup days, Copy's animation (#703)", () => {
  test("Copy's change to \"Copied\" and back animates as the site's busy " +
    "buttons do: its width eases between the two words (the " +
    "fitted-button transition in assets/scripts/utils/busy-button.js " +
    "and _busy-button.scss, 0.3 s) and the word cross-fades, with the " +
    "icon staying put; with reduced motion it changes at once",
  async ({ page }) => {
    for (const size of [PHONE, WIDE]) {
      const at = `${size.width}px`;

      await page.emulateMedia({ reducedMotion: "no-preference" });
      await openPickups(page, size);

      const run = await tapAndRecord(page);

      expect(run.copied, `"Copied" is wider than "Copy", ${at}`)
        .toBeGreaterThan(run.copy + 2 * PX);
      expect(run.to.some((s) => between(s.width, run.copy, run.copied)),
        `the width eases from Copy to Copied, ${at}`).toBe(true);
      expect(run.back.some((s) => between(s.width, run.copy, run.copied)),
        `the width eases from Copied back to Copy, ${at}`).toBe(true);
      expect(run.to.some(fading),
        `the word fades on the way to Copied, ${at}`).toBe(true);
      expect(run.back.some(fading),
        `the word fades on the way back to Copy, ${at}`).toBe(true);

      const [still] = run.samples;

      for (const s of run.samples) {
        expect(Math.abs(s.icon.x - still.icon.x),
          `the icon keeps its place in the button, ${at}`)
          .toBeLessThanOrEqual(PX);
        const resized = Math.max(
          Math.abs(s.icon.width - still.icon.width),
          Math.abs(s.icon.height - still.icon.height));
        expect(resized, `the icon keeps its size, ${at}`)
          .toBeLessThanOrEqual(PX);
        expect(s.icon.opacity, `the icon stays fully shown, ${at}`)
          .toBeGreaterThanOrEqual(1 - FADE);
      }

      await page.emulateMedia({ reducedMotion: "reduce" });
      await openPickups(page, size);

      const calm = await tapAndRecord(page);
      const eased = calm.samples
        .filter((s) => between(s.width, calm.copy, calm.copied));

      expect(eased, `with reduced motion the width jumps, ${at}`)
        .toEqual([]);
      expect(calm.samples.filter(fading),
        `with reduced motion the word changes at once, ${at}`)
        .toEqual([]);
    }
  });
});
