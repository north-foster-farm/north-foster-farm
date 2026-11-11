// The cart's discount code field (#532): Apply's note stays a short
// while and fades, for an accepted code and a refused one alike; the
// field folds back the way it opened, and at once under reduced
// motion.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, it, mock } from "node:test";

import {
  NOTE_FADE, NOTE_STAY, codeNote,
} from "../assets/scripts/order/cart/code-note.mjs";
import { shutShare } from "../assets/scripts/order/cart/view.mjs";

// A note that writes down each line it is told to draw, and each time
// the field is emptied.
const recorded = () => {
  const log = [];
  const note = codeNote({
    show: (line) => log.push(line),
    clear: () => log.push("clear"),
  });

  return { note, log };
};

const line = (text, tone = "", fading = false) => ({ text, tone, fading });

describe("cart/code-note.mjs codeNote", () => {
  beforeEach(() => mock.timers.enable({ apis: ["setTimeout"] }));
  afterEach(() => mock.timers.reset());

  it("shows an accepted code's line, empties the field, then fades it",
    () => {
      const { note, log } = recorded();
      const good = "Code applied: $5 off.";

      note.result({ text: good, tone: "good", accepted: true });
      assert.deepEqual(log, [line(good, "good"), "clear"]);
      mock.timers.tick(NOTE_STAY - 1);
      assert.equal(log.length, 2);
      mock.timers.tick(1);
      assert.deepEqual(log.at(-1), line(good, "good", true));
      mock.timers.tick(NOTE_FADE);
      assert.deepEqual(log.at(-1), line(""));
    });

  it("fades a refused code's line as soon, and keeps the field", () => {
    const { note, log } = recorded();
    const bad = "That code isn't valid.";

    note.result({ text: bad, refused: true });
    assert.deepEqual(log, [line(bad)]);
    mock.timers.tick(NOTE_STAY);
    assert.deepEqual(log.at(-1), line(bad, "", true));
    mock.timers.tick(NOTE_FADE);
    assert.deepEqual(log.at(-1), line(""));
    assert.ok(!log.includes("clear"));
  });

  it("stays a short while: a few seconds, not the old 15", () => {
    assert.ok(NOTE_STAY >= 2000 && NOTE_STAY <= 6000, String(NOTE_STAY));
  });

  it("clears the line for an empty field, with nothing left to fade", () => {
    const { note, log } = recorded();

    note.result();
    mock.timers.tick(NOTE_STAY + NOTE_FADE);
    assert.deepEqual(log, [line("")]);
  });

  it("keeps any other line until the next", () => {
    const { note, log } = recorded();
    const told = "That pass has been used.";

    note.result({ text: told });
    mock.timers.tick(NOTE_STAY * 10);
    assert.deepEqual(log, [line(told)]);
  });

  it("starts the wait over for a new line", () => {
    const { note, log } = recorded();

    note.result({ text: "That code isn't valid.", refused: true });
    mock.timers.tick(NOTE_STAY - 10);
    note.result({ text: "Code applied.", tone: "good", accepted: true });
    mock.timers.tick(NOTE_STAY - 1);
    assert.deepEqual(log.at(-1), "clear");
    mock.timers.tick(1);
    assert.deepEqual(log.at(-1), line("Code applied.", "good", true));
  });
});

// A part that plays one animation when `is-shutting` is added, and
// finishes it when the test says.
const fakePart = () => {
  const classes = new Set();
  let finish;
  const animation = { finished: new Promise((r) => { finish = r; }) };

  return {
    classes,
    finish: () => finish(),
    classList: {
      add: (name) => classes.add(name),
      remove: (name) => classes.delete(name),
    },
    getAnimations: () => (classes.has("is-shutting") ? [animation] : []),
  };
};

describe("cart/view.mjs shutShare", () => {
  it("plays the closing, and hides the part once it ends", async () => {
    const part = fakePart();
    let hidden = false;
    const done = shutShare(part, () => { hidden = true; }, { reduce: false });

    assert.ok(part.classes.has("is-shutting"));
    await Promise.resolve();
    assert.equal(hidden, false);
    part.finish();
    await done;
    assert.equal(hidden, true);
    assert.ok(!part.classes.has("is-shutting"));
  });

  it("hides the part at once under reduced motion", () => {
    const part = fakePart();
    let hidden = false;

    shutShare(part, () => { hidden = true; }, { reduce: true });
    assert.equal(hidden, true);
    assert.equal(part.classes.size, 0);
  });

  it("shuts once when asked twice", async () => {
    const part = fakePart();
    let hides = 0;
    const first = shutShare(part, () => { hides += 1; }, { reduce: false });
    const second = shutShare(part, () => { hides += 1; }, { reduce: false });

    assert.equal(first, second);
    part.finish();
    await first;
    assert.equal(hides, 1);
  });

  it("still hides the part when its closing is cancelled", async () => {
    const part = fakePart();
    let hidden = false;

    part.getAnimations = () => [{ finished: Promise.reject(new Error("x")) }];
    await shutShare(part, () => { hidden = true; }, { reduce: false });
    assert.equal(hidden, true);
  });
});

// The closing is the opening reversed: the same off frame at the other
// end, the same duration, and the easing played backwards in time.
describe("the code field's closing (_cart.scss)", () => {
  const cart = readFileSync("assets/styles/components/_cart.scss", "utf8");
  const order = readFileSync("assets/styles/components/_order.scss", "utf8");
  const bezier = (name) => order
    .match(new RegExp(`--${name}: cubic-bezier\\(([^)]+)\\)`))[1]
    .split(",").map(Number);

  it("eases back along the opening's curve", () => {
    const [x1, y1, x2, y2] = bezier("order-ease");
    const back = bezier("order-ease-back");
    const want = [1 - x2, 1 - y2, 1 - x1, 1 - y1];

    back.forEach((v, i) => assert.ok(Math.abs(v - want[i]) < 1e-9,
      `${back} is not ${want}`));
  });

  it("runs the off frame the other way, as fast", () => {
    assert.match(cart,
      /@keyframes order-share-in \{\s*from \{\s*@include order-share-off;/);
    assert.match(cart,
      /@keyframes order-share-out \{\s*to \{\s*@include order-share-off;/);
    assert.ok(cart.includes(
      "animation: order-share-in var(--order-fast) var(--order-ease);"
    ));
    assert.match(cart, new RegExp([
      String.raw`\.order-cart-code\.is-shutting \{\s*`,
      String.raw`animation: order-share-out var\(--order-fast\) `,
      String.raw`var\(--order-ease-back\)`,
    ].join("")));
  });
});
