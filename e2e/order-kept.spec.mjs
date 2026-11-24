// Criteria tests for #596 (Order page: keep last words and AM/PM
// together in text written in the browser), one per tested box. #593
// landed keepTogether (assets/scripts/utils/keep-together.mjs) and set
// the account page's lines through it; the order page's ~80 call sites
// that set prose with textContent were left. The third box (the order
// page's e2e specs pass on the lane branch) is a run, and the fourth
// (lint, tests and build green) is CI's.
// Held out of every run by its name until the change lands: renamed to
// order-kept.spec.mjs, the first test runs in the phone project (390
// px) and the second in the desktop project; each skips itself in the
// other.
//
// "Written in the browser" is read off the page itself: a script
// started before the page's own records every text node a script adds
// or changes after the HTML is parsed, and each block that holds one
// is measured where it ends up, after the cart is filled and each way
// to get the order (on-farm pickup with a time, a pickup day, delivery)
// has been chosen in turn. A line is found by measuring each word.
// The rule is keepTogether's, the same as bin/orphans/wrap.mjs's for
// the built pages: the last two words share a line unless either is a
// URL, an email address or longer than MAX_WORD, and a time's AM or PM
// is never alone at the start of a line.

import { windowLabel } from "../assets/scripts/order/lib/schedule.mjs";
import { rangeWindow } from "../assets/scripts/order/lib/events.mjs";
import { MAX_WORD } from "../assets/scripts/utils/keep-together.mjs";
import { CANNED, cannedDates } from "./support/canned.mjs";
import { FULL_CART, OrderPage, expect, test } from "./support/order.mjs";

// U+00A0 and U+202F.
const NO_BREAK = new RegExp(`[${String.fromCharCode(0xa0, 0x202f)}]`);

const onlyIn = (testInfo, project) => test.skip(
  testInfo.project.name !== project, `runs in the ${project} project`);

// Records the parents of every text node a script writes once the
// HTML is in.
const watch = (page) => page.addInitScript(() => {
  const written = new Set();
  const note = (node) => {
    if (node.nodeType === Node.TEXT_NODE && node.parentElement) {
      written.add(node.parentElement);
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      const walk = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);

      for (let n = walk.nextNode(); n; n = walk.nextNode()) {
        written.add(n.parentElement);
      }
    }
  };

  window.nffWritten = written;
  document.addEventListener("DOMContentLoaded", () => {
    new MutationObserver((records) => {
      for (const r of records) {
        if (r.type === "characterData") note(r.target);
        else r.addedNodes.forEach(note);
      }
    }).observe(document.body, {
      childList: true, characterData: true, subtree: true,
    });
  });
});

// Fills the cart and takes the page through each way to get the order,
// so the browser writes what each shows, and calls `look` after each,
// while what that way shows is on the screen.
const walk = async (page, look = async () => {}) => {
  const order = new OrderPage(page);

  await watch(page);
  await cannedDates(page);
  await order.open(FULL_CART);
  await order.firstDate("onfarm");
  await order.scrollSettled();
  await look();
  await order.scheduled(CANNED.market);
  await order.scrollSettled();
  await look();
  await order.delivery();
  await order.firstDate("delivery");
  await order.scrollSettled();
  await look();

  return order;
};

// Every visible block holding browser-written text, each as its lines
// of words.
const blocks = (page) => page.evaluate(() => {
  const isBlock = (el) => !getComputedStyle(el).display.startsWith("inline");
  const blockOf = (el) => {
    let at = el;

    while (at.parentElement && !isBlock(at)) at = at.parentElement;

    return at;
  };
  const skip = (el) => el.closest(
    "select, option, script, template, style, textarea, .visually-hidden"
  );
  const seen = new Set();
  const out = [];

  for (const el of window.nffWritten) {
    if (!el.isConnected || skip(el)) continue;

    const block = blockOf(el);

    if (seen.has(block) || !block.checkVisibility()) continue;
    seen.add(block);

    const words = [];
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);

    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (skip(n.parentElement) || blockOf(n.parentElement) !== block) {
        continue;
      }
      for (const m of n.data.matchAll(/[^\s]+/g)) {
        const range = document.createRange();

        range.setStart(n, m.index);
        range.setEnd(n, m.index + m[0].length);

        const r = range.getClientRects()[0];

        if (r && r.width > 0) words.push({ text: m[0], top: r.top });
      }
    }

    const lines = [];

    for (const w of words) {
      const line = lines.at(-1);

      if (line && Math.abs(line.top - w.top) <= 2) line.words.push(w.text);
      else lines.push({ top: w.top, words: [w.text] });
    }
    if (lines.length >= 2) {
      out.push({
        id: block.id || block.className || block.tagName,
        lines: lines.map((l) => l.words),
      });
    }
  }

  return out;
});

const unsafe = (word, max) => /:\/\/|www\.|@/i.test(word)
  || [...word].length > max;
const half = (word) => /^[AP]M(?![A-Za-z0-9_])/.test(word);

test.describe("order page text kept together (#596)", () => {
  test("at 390 px the order page and cart show no line holding a lone "
    + "last word or a lone AM or PM in text written in the browser",
  async ({ page }, testInfo) => {
    onlyIn(testInfo, "phone");

    const found = new Map();

    await walk(page, async () => {
      for (const b of await blocks(page)) {
        found.set(`${b.id} ${b.lines.flat().join(" ")}`, b);
      }
    });

    const max = MAX_WORD;
    const faults = [];

    expect(found.size, "the browser wrote lines that wrap")
      .toBeGreaterThan(0);
    for (const { id, lines } of found.values()) {
      const last = lines.at(-1);
      const before = lines.at(-2).at(-1);

      if (last.length === 1 && !unsafe(last[0], max) &&
        !unsafe(before, max)) {
        faults.push(`${id}: "${last[0]}" alone on the last line`);
      }
      lines.slice(1).forEach((line) => {
        if (half(line[0])) faults.push(`${id}: "${line[0]}" starts a line`);
      });
    }
    expect(faults).toEqual([]);
  });

  test("no stored, compared or server-bound string carries a no-break "
    + "space", async ({ page }, testInfo) => {
    onlyIn(testInfo, "desktop");

    // The shared labels the server reads too (emails, Square notes)
    // and the windows other code compares.
    for (const [from, to] of [["09:00", "12:00"], ["18:00", "20:00"],
      ["10:00", "13:30"]]) {
      expect(windowLabel({ from, to }), `${from}-${to}`)
        .not.toMatch(NO_BREAK);
      expect(rangeWindow(from, to), `${from}-${to}`).not.toMatch(NO_BREAK);
    }

    await walk(page);

    // The draft is the form's collect(), the body the order is sent
    // with; the rest of storage and every control's value besides.
    const held = await page.evaluate(() => {
      const all = [];

      for (const store of [localStorage, sessionStorage]) {
        for (let i = 0; i < store.length; i += 1) {
          const key = store.key(i);

          all.push([`storage ${key}`, store.getItem(key)]);
        }
      }
      for (const el of document.querySelectorAll(
        "#order-form input, #order-form select, #order-form textarea, "
        + "#order-cart input, #order-cart select"
      )) {
        all.push([`value of ${el.name || el.id}`, el.value]);
        for (const { name, value } of el.attributes) {
          if (name.startsWith("data-")) all.push([`${name} on ${el.id}`,
            value]);
        }
      }

      return all;
    });

    expect(held.some(([what]) => what.startsWith("storage ")),
      "the draft is stored").toBe(true);
    expect(held.filter(([, value]) => NO_BREAK.test(value))
      .map(([what]) => what)).toEqual([]);
  });
});
