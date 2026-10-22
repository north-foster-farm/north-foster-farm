// The settled cart floating again on the way back up (#274, round 5).

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  FLOAT_AGAIN, floatsAgain, look, segOn,
} from "../assets/scripts/order/lib/cart-float.mjs";

const SETTLED = { items: "open", money: "open" };

// A pane as the page draws it: every line settled, under the cap
// floating open, and the total row and foot alone floating hidden.
const PANE = { settled: 420, open: 290, hidden: 151 };
const ROOM = 1000;

// Scrolls the pane's place in the flow from `from` to `to` in 10px
// steps, as order-form.js does: hidden as it lifts off, open as it
// settles. `hidden` is what the settle measures. Returns the cart and
// the flips from settled to floating and back on the way.
const scroll = (cart, from, to, hidden) => {
  let flips = 0;
  const step = from > to ? -10 : 10;

  for (let place = from; place !== to + step; place += step) {
    const height = cart.stuck === "false" ? PANE.settled
      : cart.open ? PANE.open : PANE.hidden;
    const seen = look(cart, {
      place, height, room: ROOM, easing: false, hidden: () => hidden,
    });

    if (seen.stuck !== cart.stuck) flips++;
    if (floatsAgain(cart.stuck, seen.stuck === "true")) cart.open = false;
    if (seen.stuck === "false") cart.open = true;
    cart.stuck = seen.stuck;
    cart.floatH = seen.floatH;
  }

  return { cart, flips };
};

// Floating and open over the catalog, then down until it settles.
const settle = (open, hidden) => {
  const { cart } = scroll({ stuck: "true", floatH: 0, open }, 1400, 400,
    hidden);

  assert.equal(cart.stuck, "false");

  return cart;
};

describe("look", () => {
  it("lifts off once on the way up after settling expanded", () => {
    const cart = settle(true, PANE.hidden);
    const up = scroll(cart, 400, 1400, PANE.hidden);

    assert.equal(up.flips, 1);
    assert.equal(up.cart.stuck, "true");
    assert.equal(up.cart.open, false);
  });

  it("lifts off once after settling hidden", () => {
    const up = scroll(settle(false, PANE.hidden), 400, 1400, PANE.hidden);

    assert.equal(up.flips, 1);
  });

  it("lifts off where its hidden foot meets the room", () => {
    const cart = settle(true, PANE.hidden);

    assert.equal(look(cart, {
      place: ROOM - PANE.hidden, height: PANE.settled, room: ROOM,
    }).stuck, "false");
    assert.equal(look(cart, {
      place: ROOM - PANE.hidden + 1, height: PANE.settled, room: ROOM,
    }).stuck, "true");
  });

  // QA's flicker: judged by the open pane's height it lifted off too
  // soon, hid, settled again and sprang open.
  it("flickers when the settle takes the open height", () => {
    const up = scroll(settle(true, PANE.open), 400, 1400, PANE.open);

    assert.ok(up.flips > 1, `${up.flips} flips`);
  });

  it("keeps the height it floated at while it eases", () => {
    const seen = look({ stuck: "true", floatH: 151 }, {
      place: 900, height: 300, room: ROOM, easing: true,
    });

    assert.equal(seen.floatH, 151);
  });
});

describe("floatsAgain", () => {
  it("is true only when a settled cart starts to float", () => {
    assert.equal(floatsAgain("false", true), true);
    assert.equal(floatsAgain("true", true), false);
    assert.equal(floatsAgain("false", false), false);
    assert.equal(floatsAgain(undefined, true), false);
  });
});

describe("FLOAT_AGAIN", () => {
  it("hides the pane on its lines", () => {
    assert.deepEqual({ ...FLOAT_AGAIN },
      { open: false, items: "open", money: "closed" });
  });

  it("lights one pill on a tablet, where settled lit both", () => {
    assert.deepEqual(segOn(SETTLED, false), { items: true, money: true });
    assert.deepEqual(segOn(FLOAT_AGAIN, false),
      { items: true, money: false });
  });

  it("selects the lines tab on a phone", () => {
    assert.deepEqual(segOn(FLOAT_AGAIN, true),
      { items: true, money: false });
  });
});

describe("segOn", () => {
  it("shows a phone's sums only when the lines are folded", () => {
    assert.deepEqual(segOn({ items: "closed", money: "open" }, true),
      { items: false, money: true });
    assert.deepEqual(segOn(SETTLED, true), { items: true, money: false });
  });
});
